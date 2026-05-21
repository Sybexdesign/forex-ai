#!/usr/bin/env node
/**
 * SybexForexAI — 24/7 Background Scalper Worker
 *
 * - 10-second polling across XAU/USD and XAG/USD (concurrent tick fetch + pre-filter)
 * - Session-aware strategy rotation: Momentum during London/NY, Mean Reversion Asian
 * - Two-stage scan: fast indicator pre-filter → Claude signal only when needed
 * - Risk guards: 1% max risk, 3% daily loss limit, max 3 concurrent trades
 * - WORKER_MODE=paper  → Telegram alerts + Supabase log (no real orders)
 * - WORKER_MODE=live   → real OANDA orders + alerts + log
 * - 15-min alert cooldown per pair+direction
 * - 4-hour heartbeat, daily midnight restart, graceful shutdown
 */

// ── Config ────────────────────────────────────────────────────────────────────

const BASE_URL       = process.env.APP_URL || 'https://forex.sybexdesigns.co.uk'
const BOT_TOKEN      = process.env.TELEGRAM_BOT_TOKEN
const CHAT_ID        = process.env.TELEGRAM_CHAT_ID
const SUPABASE_URL   = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
const SUPABASE_KEY   = process.env.SUPABASE_SERVICE_ROLE_KEY
const WORKER_MODE    = (process.env.WORKER_MODE || 'paper').toLowerCase() // 'paper' | 'live'
const WORKER_USER_ID = process.env.WORKER_USER_ID  // optional: Supabase user ID for logging

const POLL_MS          = 10_000       // 10 s per sweep
const SIG_COOLDOWN_MS  = 60_000       // 1 min between Claude calls per pair
const ALERT_COOL_MS    = 15 * 60_000  // 15 min per pair+direction alert
const RISK_CACHE_MS    = 2  * 60_000  // 2 min account state cache
const HEARTBEAT_MS     = 30 * 60_000
const FETCH_TIMEOUT_MS = 45_000       // Claude API can take 10-15 s
const MAX_SIG_BATCH    = 3            // max concurrent Claude calls per sweep
const CONFIDENCE_MIN   = 70           // minimum confidence to alert/trade

// ── Pairs + Strategy Defaults ─────────────────────────────────────────────────

const PAIRS = ['XAU/USD', 'XAG/USD']

const PAIR_STRATEGY = {
  'XAU/USD': 'Breakout',
  'XAG/USD': 'Breakout',
}

// ── Session Detection ─────────────────────────────────────────────────────────
// Market week: Sunday 22:00 UTC → Friday 22:00 UTC

function isMarketOpen() {
  const d   = new Date()
  const day = d.getUTCDay()   // 0=Sun 6=Sat
  const h   = d.getUTCHours()
  const m   = d.getUTCMinutes()
  if (day === 6) return false                                  // Saturday: always closed
  if (day === 0 && h < 22) return false                       // Sunday before 22:00
  if (day === 5 && (h > 22 || (h === 22 && m >= 0))) return false // Friday after 22:00
  return true
}

function getSession() {
  const h = new Date().getUTCHours()
  if (h >= 22 || h < 7)  return 'Asian'    // 22:00–07:00 UTC  – ranging
  if (h >= 7  && h < 13) return 'London'   // 07:00–13:00 UTC  – trending
  if (h >= 13 && h < 16) return 'Overlap'  // 13:00–16:00 UTC  – highest volatility
  return 'New York'                          // 16:00–22:00 UTC  – trending
}

function getStrategy(pair, session) {
  if (pair.startsWith('XA')) return 'Breakout'
  return PAIR_STRATEGY[pair] || 'Momentum'
}

// ── Indicator Pre-filter ──────────────────────────────────────────────────────
// Avoids calling Claude unless the market shows a genuine setup.

function hasSignalCondition(tick, strategy) {
  const { rsi14, adx, bbWidth, price, buyPressure } = tick
  const relBbWidth = price > 0 ? bbWidth / price : bbWidth
  switch (strategy) {
    case 'Momentum':      return (rsi14 < 42 || rsi14 > 58) && adx > 18
    case 'Mean Reversion': return rsi14 < 38 || rsi14 > 62
    case 'Breakout':      return relBbWidth < 0.004   // normalised squeeze: ~18pt on XAU/USD
    default:              return buyPressure < 0.38 || buyPressure > 0.62
  }
}

// ── State ─────────────────────────────────────────────────────────────────────

const lastSigFetch   = new Map()   // pair → ms timestamp
const alertCooldowns = new Map()   // `${pair}:${direction}` → ms timestamp
let   cachedRisk     = null
let   riskCachedAt   = 0
let   tradingHalted  = false
let   haltNotified   = false

const stats = {
  sweeps: 0, sigChecks: 0, alerts: 0, trades: 0, errors: 0,
  startTime: Date.now(),
}

// ── Worker Log (Supabase) ─────────────────────────────────────────────────────
// Writes key events to the worker_logs table so the web app can display them.

async function wlog(level, message, { pair, session, metadata } = {}) {
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    console.log(`[wlog] skipped — no SUPABASE_URL/KEY (url=${!!SUPABASE_URL} key=${!!SUPABASE_KEY})`)
    return
  }
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/worker_logs`, {
      method:  'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey':        SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Prefer':        'return=minimal',
      },
      body:   JSON.stringify({ level, message, pair, session, metadata }),
      signal: AbortSignal.timeout(5_000),
    })
    if (!res.ok) console.error(`[wlog] HTTP ${res.status}:`, await res.text().catch(() => ''))
  } catch (e) {
    console.error(`[wlog] fetch error:`, e.message)
  }
}

// ── Pip / Price Helpers ───────────────────────────────────────────────────────

function pipSize(pair) {
  if (pair.includes('JPY'))    return 0.01
  if (pair.startsWith('XAU'))  return 0.1
  if (pair.startsWith('XAG'))  return 0.01
  return 0.0001
}

function toPips(pair, priceDiff) {
  return Math.abs(priceDiff) / pipSize(pair)
}

function decimals(pair) {
  if (pair.includes('JPY'))   return 3
  if (pair.startsWith('XA')) return 2
  return 5
}

// ── Supabase ──────────────────────────────────────────────────────────────────

async function sbInsert(table, row) {
  if (!SUPABASE_URL || !SUPABASE_KEY) return
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
      method:  'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey':        SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Prefer':        'return=minimal',
      },
      body:   JSON.stringify(row),
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) console.error(`[sb/${table}]`, res.status, await res.text())
  } catch (e) {
    console.error('[sb]', e.message)
  }
}

// Returns the inserted row (including generated id) — used for outcome tracking
async function sbInsertReturning(table, row) {
  if (!SUPABASE_URL || !SUPABASE_KEY) return null
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
      method:  'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey':        SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Prefer':        'return=representation',
      },
      body:   JSON.stringify(row),
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) { console.error(`[sb/${table}]`, res.status, await res.text()); return null }
    const rows = await res.json()
    return Array.isArray(rows) ? rows[0] : null
  } catch (e) {
    console.error('[sb/insert]', e.message)
    return null
  }
}

async function sbUpdate(table, id, data) {
  if (!SUPABASE_URL || !SUPABASE_KEY) return
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?id=eq.${id}`, {
      method:  'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'apikey':        SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Prefer':        'return=minimal',
      },
      body:   JSON.stringify(data),
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) console.error(`[sb/update ${table}]`, res.status, await res.text())
  } catch (e) {
    console.error('[sb/update]', e.message)
  }
}

// ── Outcome Tracker ───────────────────────────────────────────────────────────
// Tracks open signals in memory and resolves them when TP/SL is hit.
// signalId → { pair, direction, sl, tp, insertedAt }

const pendingSignals = new Map()
const OUTCOME_MAX_AGE_MS = 4 * 60 * 60_000  // stop tracking after 4 hours

function trackSignal(id, pair, direction, entry, sl, tp) {
  if (!id) return
  pendingSignals.set(id, { pair, direction, sl, tp, insertedAt: Date.now() })
  console.log(`[outcome] tracking signal ${id.slice(0, 8)} — ${pair} ${direction} SL:${sl} TP:${tp}`)
}

async function checkPendingOutcomes(ticksByPair) {
  if (pendingSignals.size === 0) return
  const now = Date.now()
  for (const [id, sig] of pendingSignals) {
    if (now - sig.insertedAt > OUTCOME_MAX_AGE_MS) {
      pendingSignals.delete(id)
      continue
    }
    const tick = ticksByPair[sig.pair]
    if (!tick) continue

    const price = tick.price
    let outcome = null
    if (sig.direction === 'BUY') {
      if (price <= sig.sl) outcome = 'LOSS'
      else if (price >= sig.tp) outcome = 'WIN'
    } else if (sig.direction === 'SELL') {
      if (price >= sig.sl) outcome = 'LOSS'
      else if (price <= sig.tp) outcome = 'WIN'
    }

    if (outcome) {
      pendingSignals.delete(id)
      await sbUpdate('signals', id, { outcome })
      console.log(`[outcome] ${sig.pair} ${sig.direction} → ${outcome} (${id.slice(0, 8)})`)
      wlog('info', `Signal outcome: ${sig.pair} ${sig.direction} → ${outcome}`, {
        pair: sig.pair, session: getSession(),
        metadata: { signalId: id, outcome, direction: sig.direction },
      })
    }
  }
}

// ── Telegram ──────────────────────────────────────────────────────────────────

async function tgSend(text) {
  if (!BOT_TOKEN || !CHAT_ID) { console.log('[TG]', text.slice(0, 120)); return }
  try {
    const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ chat_id: CHAT_ID, text, parse_mode: 'HTML' }),
      signal:  AbortSignal.timeout(10_000),
    })
    if (!res.ok) console.error('[TG]', res.status, await res.text())
  } catch (e) {
    console.error('[TG]', e.message)
  }
}

function formatAlert(pair, strategy, session, signal, mode) {
  const dir    = signal.direction
  const emoji  = dir === 'BUY' ? '🟢' : '🔴'
  const dp     = decimals(pair)
  const f      = n => (+n).toFixed(dp)
  const entry  = +signal.entry
  const sl     = +signal.sl
  const tp     = +signal.tp
  const rr     = Math.abs(entry - sl) > 0
    ? (Math.abs(tp - entry) / Math.abs(entry - sl)).toFixed(2)
    : '—'
  const slPips = toPips(pair, entry - sl).toFixed(1)
  const tpPips = toPips(pair, tp - entry).toFixed(1)
  const badge  = mode === 'live' ? '💸 LIVE TRADE PLACED' : '📋 Paper Signal'
  const reasons = (signal.reasons || []).map(r => `  • ${r}`).join('\n')

  return [
    `${emoji} <b>${dir} ${pair}</b>  [${strategy} · ${session}]`,
    `Confidence: <b>${signal.confidence}%</b>  ${badge}`,
    ``,
    `Entry  : <code>${f(entry)}</code>`,
    `SL     : <code>${f(sl)}</code>  (${slPips} pips)`,
    `TP     : <code>${f(tp)}</code>  (${tpPips} pips)`,
    `R:R    : 1 : ${rr}`,
    ``,
    reasons,
    signal.risk_note ? `\n⚠ ${signal.risk_note}` : '',
    `⏱ ${new Date().toUTCString()}`,
  ].join('\n').replace(/\n{3,}/g, '\n\n')
}

// ── API Helpers ───────────────────────────────────────────────────────────────

async function apiFetch(path, options = {}) {
  const res = await fetch(`${BASE_URL}${path}`, {
    ...options,
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  })
  if (!res.ok) throw new Error(`${path} HTTP ${res.status}`)
  return res.json()
}

async function fetchTick(pair) {
  return apiFetch(`/api/scalper/tick?pair=${encodeURIComponent(pair)}&timeframe=5m`)
}

async function fetchSignal(tick, pair, strategy) {
  return apiFetch('/api/scalper/signal', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ ...tick, pair, strategy }),
  })
}

async function fetchRiskState() {
  if (cachedRisk && Date.now() - riskCachedAt < RISK_CACHE_MS) return cachedRisk
  const acct      = await apiFetch('/api/account')
  const balance   = acct.balance   || 0
  const realizedPL = acct.realizedPL || 0  // negative = loss today
  const openCount = (acct.openTrades || []).length
  const dailyLossPct = (balance > 0 && realizedPL < 0)
    ? Math.abs(realizedPL) / balance
    : 0
  cachedRisk   = { balance, openCount, dailyLossPct }
  riskCachedAt = Date.now()
  return cachedRisk
}

async function placeOrder(pair, direction, signal) {
  const slPips = toPips(pair, signal.entry - signal.sl)
  const tpPips = toPips(pair, signal.tp   - signal.entry)
  return apiFetch('/api/orders', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({
      pair,
      direction,
      strategy:      { riskPct: 1, slPips, tpPips },
      aiConfidence:  signal.confidence,
      checklistScore: (signal.reasons || []).length,
      currentPrice:  signal.entry,
      userId:        WORKER_USER_ID || undefined,
    }),
  })
}

// ── Signal Processor ──────────────────────────────────────────────────────────

async function processSignal(pair, tick, strategy, session) {
  lastSigFetch.set(pair, Date.now())
  stats.sigChecks++

  let signal
  try {
    signal = await fetchSignal(tick, pair, strategy)
  } catch (e) {
    stats.errors++
    console.error(`[signal] ${pair}:`, e.message)
    wlog('error', `Signal fetch failed: ${e.message}`, { pair, session })
    return
  }

  const dir  = signal.direction
  const conf = signal.confidence ?? 0

  console.log(
    `[${pair}] ${strategy}/${session} → ${dir} ${conf}%` +
    (tick.simulated ? ' (sim)' : ` (${tick.broker})`)
  )

  // Log every signal check to Supabase (ML data + UI visibility)
  wlog('signal',
    `${dir} ${conf}% — ${strategy}`,
    { pair, session, metadata: { direction: dir, confidence: conf, strategy, session, simulated: tick.simulated, entry: signal.entry, sl: signal.sl, tp: signal.tp, reasons: signal.reasons } }
  )

  // Save all non-HOLD signals to DB for ML training data, regardless of confidence
  if (WORKER_USER_ID && dir !== 'HOLD') {
    const pip     = pipSize(pair)
    const atr     = tick.atr || 0.0005
    const slDist  = atr * 1.5
    const tpDist  = atr * 2.5
    const entry   = signal.entry || tick.price
    const sl      = signal.sl  || (dir === 'BUY' ? entry - slDist : entry + slDist)
    const tp      = signal.tp  || (dir === 'BUY' ? entry + tpDist : entry - tpDist)

    sbInsertReturning('signals', {
      user_id:            WORKER_USER_ID,
      pair,
      timeframe:          'scalper-worker',
      direction:          dir,
      confidence:         conf,
      checklist_score:    (signal.reasons || []).length,
      reasons:            signal.reasons,
      risk_note:          signal.risk_note,
      acted_on:           false,
      outcome:            'PENDING',
      indicator_snapshot: tick,
    }).then(row => {
      if (row?.id) trackSignal(row.id, pair, dir, entry, sl, tp)
    }).catch(() => {})
  }

  if (dir === 'HOLD' || conf < CONFIDENCE_MIN) return

  // Hard block: never act on simulated data in live mode
  if (tick.simulated) {
    if (WORKER_MODE === 'live') {
      console.warn(`[risk] LIVE ORDER BLOCKED — simulated market data detected for ${pair}. MT5 EA may be disconnected or all live feeds unavailable.`)
      wlog('error', `Simulated data in LIVE mode — order blocked`, { pair, session, metadata: { reason: 'simulated_data', broker: tick.broker } })
    }
    return
  }

  // Alert cooldown
  const coolKey = `${pair}:${dir}`
  const lastAt  = alertCooldowns.get(coolKey) || 0
  if (Date.now() - lastAt < ALERT_COOL_MS) {
    const minLeft = Math.ceil((ALERT_COOL_MS - (Date.now() - lastAt)) / 60_000)
    console.log(`[cooldown] ${coolKey} — ${minLeft}m left`)
    return
  }
  alertCooldowns.set(coolKey, Date.now())
  stats.alerts++
  wlog('alert', `${dir} ${pair} — confidence ${conf}%`, { pair, session, metadata: { direction: dir, confidence: conf, strategy, session } })

  // Risk guards + order placement (live mode only)
  let placed = false
  if (WORKER_MODE === 'live') {
    if (tradingHalted) {
      console.log('[risk] trading halted — skipping order')
    } else {
      let risk
      try { risk = await fetchRiskState() } catch { /* skip order on error */ }

      if (risk) {
        if (risk.dailyLossPct >= 0.03) {
          tradingHalted = true
          if (!haltNotified) {
            haltNotified = true
            await tgSend('🛑 <b>Daily loss limit reached (3%)</b> — trading halted for today.\nWorker still scanning and alerting in paper mode.')
          }
        } else if (risk.openCount >= 3) {
          console.log(`[risk] ${risk.openCount}/3 trades open — skipping order`)
        } else {
          try {
            const result = await placeOrder(pair, dir, signal)
            if (result.success) {
              placed = true
              stats.trades++
              console.log(`[order] ✓ ${pair} ${dir} → trade ${result.tradeId} @ ${result.filledPrice}`)
              wlog('order', `${dir} order placed`, { pair, session, metadata: { direction: dir, success: true, tradeId: result.tradeId, filledPrice: result.filledPrice, lots: result.lots } })
            } else {
              console.log(`[order] blocked: ${(result.reasons || []).join(', ')}`)
              wlog('order', `${dir} order blocked: ${(result.reasons || []).join(', ')}`, { pair, session, metadata: { direction: dir, success: false, reasons: result.reasons } })
            }
          } catch (e) {
            console.error('[order]', e.message)
          }
        }
      }
    }
  }

  // Telegram alert
  await tgSend(formatAlert(pair, strategy, session, signal, placed ? 'live' : 'paper'))

  // Signal already saved to DB earlier (before the confidence gate) for ML training
}

// ── Sweep ─────────────────────────────────────────────────────────────────────

async function runSweep() {
  stats.sweeps++

  const marketOpen = isMarketOpen()
  const session    = marketOpen ? getSession() : 'CLOSED'

  // Ping Supabase every 6 sweeps (~1 min) regardless of market state
  // so the Worker Logs page shows the worker is alive during weekends too
  if (stats.sweeps % 6 === 0) {
    await wlog('info',
      marketOpen
        ? `▶ Sweep #${stats.sweeps} · ${session} · ${stats.sigChecks} checks · ${stats.alerts} alerts`
        : `⏸ Sweep #${stats.sweeps} · Market closed — next open Sun 22:00 UTC`,
      {
        session,
        metadata: { sweeps: stats.sweeps, sigChecks: stats.sigChecks, alerts: stats.alerts, errors: stats.errors, market: marketOpen ? '✅ OPEN' : '🔴 CLOSED' },
      }
    )
  }

  if (!marketOpen) {
    if (stats.sweeps % 360 === 0)
      console.log(`[sweep #${stats.sweeps}] Market closed — waiting for Sunday 22:00 UTC`)
    return
  }

  const now = new Date().toISOString().slice(11, 19)
  console.log(`── sweep #${stats.sweeps}  ${now} UTC  [${session}] ──`)

  // Phase 1: fetch all ticks concurrently
  const tickResults = await Promise.allSettled(
    PAIRS.map(async pair => ({ pair, tick: await fetchTick(pair) }))
  )

  // Build a price map for outcome tracking
  const ticksByPair = {}
  for (const r of tickResults) {
    if (r.status === 'fulfilled') ticksByPair[r.value.pair] = r.value.tick
  }

  // Check if any tracked signals have resolved
  await checkPendingOutcomes(ticksByPair)

  // Phase 2: pre-filter — build signal candidate queue
  const queue = []
  for (const r of tickResults) {
    if (r.status !== 'fulfilled') { stats.errors++; continue }
    const { pair, tick } = r.value
    const strategy       = getStrategy(pair, session)
    if (Date.now() - (lastSigFetch.get(pair) || 0) < SIG_COOLDOWN_MS) continue
    if (!hasSignalCondition(tick, strategy)) continue
    queue.push({ pair, tick, strategy })
  }

  if (queue.length)
    console.log(`[pre-filter] ${queue.length}/${PAIRS.length} pairs qualify for signal check`)

  // Phase 3: process signals in batches (limit concurrent Claude calls)
  for (let i = 0; i < queue.length; i += MAX_SIG_BATCH) {
    const batch = queue.slice(i, i + MAX_SIG_BATCH)
    await Promise.allSettled(
      batch.map(({ pair, tick, strategy }) => processSignal(pair, tick, strategy, session))
    )
  }
}

// ── Heartbeat ─────────────────────────────────────────────────────────────────

async function sendHeartbeat() {
  const uptimeH = ((Date.now() - stats.startTime) / 3_600_000).toFixed(1)
  const lines = [
    `💓 <b>SybexForexAI Worker — Heartbeat</b>`,
    ``,
    `Mode     : ${WORKER_MODE.toUpperCase()}${tradingHalted ? ' (halted)' : ''}`,
    `Session  : ${getSession()}`,
    `Market   : ${isMarketOpen() ? '✅ OPEN' : '🔴 CLOSED'}`,
    `Uptime   : ${uptimeH} h`,
    `Sweeps   : ${stats.sweeps.toLocaleString()}`,
    `Checked  : ${stats.sigChecks} signals`,
    `Alerts   : ${stats.alerts} fired`,
    WORKER_MODE === 'live' ? `Trades   : ${stats.trades} placed` : null,
    `Errors   : ${stats.errors}`,
    `⏱ ${new Date().toUTCString()}`,
  ].filter(l => l !== null).join('\n')

  console.log('[heartbeat] sending')
  await tgSend(lines)
  wlog('heartbeat', `Uptime ${uptimeH}h · Sweeps ${stats.sweeps} · Alerts ${stats.alerts}`, {
    metadata: {
      uptimeH: +uptimeH,
      sweeps:  stats.sweeps,
      sigChecks: stats.sigChecks,
      alerts:  stats.alerts,
      trades:  stats.trades,
      errors:  stats.errors,
      market:  isMarketOpen() ? '✅ OPEN' : '🔴 CLOSED',
      session: getSession(),
      mode:    WORKER_MODE.toUpperCase(),
      pairs:   PAIRS,
    },
  })
}

// ── Midnight Restart ──────────────────────────────────────────────────────────
// Exit at midnight UTC so DO App Platform / PM2 restarts with clean memory.

function scheduleMidnightRestart() {
  const now  = new Date()
  const next = new Date(Date.UTC(
    now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1
  ))
  const ms = next - now
  console.log(`[worker] Daily restart scheduled in ${(ms / 3_600_000).toFixed(1)}h (${next.toUTCString()})`)
  setTimeout(async () => {
    console.log('[worker] Midnight restart — clearing memory')
    await tgSend('🔄 <b>SybexForexAI Worker</b> — daily midnight restart (memory clear)')
    process.exit(0)
  }, ms)
}

// ── Shutdown Handlers ─────────────────────────────────────────────────────────

let running = true

async function shutdown(sig) {
  console.log(`[worker] ${sig}`)
  running = false
  if (sig === 'SIGTERM')
    await tgSend('🛑 <b>SybexForexAI Worker</b> — graceful shutdown (SIGTERM)')
  process.exit(0)
}
process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT',  () => shutdown('SIGINT'))
process.on('uncaughtException', e => console.error('[uncaught]', e.message))
process.on('unhandledRejection', e => console.error('[unhandled]', e))

// ── Main Loop ─────────────────────────────────────────────────────────────────

;(async () => {
  console.log(`[worker] SybexForexAI background scanner`)
  console.log(`[worker] Mode   : ${WORKER_MODE.toUpperCase()}`)
  console.log(`[worker] Target : ${BASE_URL}`)
  console.log(`[worker] Pairs  : ${PAIRS.join(' | ')}`)
  console.log(`[worker] Poll   : ${POLL_MS / 1000}s | Alert threshold: ≥${CONFIDENCE_MIN}%`)

  scheduleMidnightRestart()
  setInterval(sendHeartbeat, HEARTBEAT_MS)

  const startMsg = [
    `🚀 <b>SybexForexAI Worker Started</b>`,
    `Mode     : ${WORKER_MODE.toUpperCase()}`,
    `Interval : 10 seconds`,
    `Pairs    : ${PAIRS.join(', ')}`,
    `Strategy : session-aware rotation`,
    `Threshold: confidence ≥ ${CONFIDENCE_MIN}%`,
    `⏱ ${new Date().toUTCString()}`,
  ].join('\n')
  await tgSend(startMsg)
  wlog('info', `Worker started — mode: ${WORKER_MODE.toUpperCase()}`, { metadata: { mode: WORKER_MODE, pairs: PAIRS, threshold: CONFIDENCE_MIN } })

  // Main polling loop — honours 10-second interval accounting for sweep duration
  while (running) {
    const t0 = Date.now()
    try {
      await runSweep()
    } catch (e) {
      stats.errors++
      console.error('[sweep error]', e.message)
      wlog('error', `Sweep error: ${e.message}`)
    }
    const elapsed = Date.now() - t0
    const wait    = Math.max(0, POLL_MS - elapsed)
    if (running && wait > 0) await new Promise(r => setTimeout(r, wait))
  }
})()
