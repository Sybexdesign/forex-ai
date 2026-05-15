#!/usr/bin/env node
/**
 * SybexForexAI — Background Scalper Worker
 * Polls tick + signal for 6 pairs every 30 s, fires Telegram alerts on confidence ≥ 70.
 * Designed to run as a Digital Ocean App Platform "worker" component (no HTTP port).
 */

const BASE_URL       = process.env.APP_URL || 'https://forex.sybexdesigns.co.uk'
const BOT_TOKEN      = process.env.TELEGRAM_BOT_TOKEN
const CHAT_ID        = process.env.TELEGRAM_CHAT_ID
const POLL_INTERVAL  = 30_000   // 30 s between full sweeps
const PAIR_STAGGER   = 5_000    // 5 s between pairs within a sweep
const COOLDOWN_MS    = 15 * 60 * 1000  // 15 min per pair+direction
const HEARTBEAT_MS   = 4 * 60 * 60 * 1000  // 4-hour summary
const FETCH_TIMEOUT  = 45_000   // 45 s – Claude API can be slow

const PAIRS = [
  { pair: 'EUR/USD', timeframe: '5m', strategy: 'Momentum'      },
  { pair: 'GBP/USD', timeframe: '5m', strategy: 'Momentum'      },
  { pair: 'USD/JPY', timeframe: '5m', strategy: 'Momentum'      },
  { pair: 'AUD/USD', timeframe: '5m', strategy: 'Mean Reversion' },
  { pair: 'USD/CAD', timeframe: '5m', strategy: 'Momentum'      },
  { pair: 'XAU/USD', timeframe: '5m', strategy: 'Breakout'      },
]

// cooldown map: `${pair}:${direction}` → timestamp of last alert
const cooldowns = new Map()

// stats for heartbeat summary
const stats = { sweeps: 0, signals: 0, alerts: 0, errors: 0, startTime: Date.now() }

// ─── Telegram helpers ──────────────────────────────────────────────────────────

async function tgSend(text) {
  if (!BOT_TOKEN || !CHAT_ID) { console.log('[TG skip]', text.slice(0, 80)); return }
  try {
    const res = await fetch(
      `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`,
      {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ chat_id: CHAT_ID, text, parse_mode: 'HTML' }),
        signal:  AbortSignal.timeout(10_000),
      }
    )
    if (!res.ok) console.error('[TG]', res.status, await res.text())
  } catch (e) {
    console.error('[TG]', e.message)
  }
}

function formatAlert(pair, strategy, signal) {
  const dir   = signal.direction
  const emoji = dir === 'BUY' ? '🟢' : '🔴'
  const entry = +signal.entry
  const sl    = +signal.sl
  const tp    = +signal.tp
  const risk  = Math.abs(entry - sl)
  const rew   = Math.abs(tp - entry)
  const rr    = risk > 0 ? (rew / risk).toFixed(2) : '—'
  const conf  = signal.confidence

  const dp = pair.includes('JPY') ? 3 : pair.startsWith('XAU') ? 2 : 5
  const fmt = n => n.toFixed(dp)

  const reasonLines = (signal.reasons || []).map(r => `  • ${r}`).join('\n')

  return [
    `${emoji} <b>${dir} ${pair}</b> — ${strategy}`,
    `Confidence: <b>${conf}%</b>`,
    ``,
    `Entry : <code>${fmt(entry)}</code>`,
    `SL    : <code>${fmt(sl)}</code>`,
    `TP    : <code>${fmt(tp)}</code>`,
    `R:R   : 1 : ${rr}`,
    ``,
    `<b>Reasons:</b>`,
    reasonLines,
    ``,
    signal.risk_note ? `⚠ ${signal.risk_note}` : '',
    ``,
    `⏱ ${new Date().toUTCString()}`,
  ].filter(l => l !== undefined).join('\n')
}

// ─── API fetch helpers ─────────────────────────────────────────────────────────

async function fetchTick(pair, timeframe) {
  const url = `${BASE_URL}/api/scalper/tick?pair=${encodeURIComponent(pair)}&timeframe=${timeframe}`
  const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT) })
  if (!res.ok) throw new Error(`tick HTTP ${res.status}`)
  return res.json()
}

async function fetchSignal(tick, pair, strategy) {
  const res = await fetch(`${BASE_URL}/api/scalper/signal`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ ...tick, pair, strategy }),
    signal:  AbortSignal.timeout(FETCH_TIMEOUT),
  })
  if (!res.ok) throw new Error(`signal HTTP ${res.status}`)
  return res.json()
}

// ─── Core scan loop ────────────────────────────────────────────────────────────

async function scanPair({ pair, timeframe, strategy }) {
  try {
    const tick   = await fetchTick(pair, timeframe)
    const signal = await fetchSignal(tick, pair, strategy)

    const dir  = signal.direction
    const conf = signal.confidence ?? 0

    console.log(`[scan] ${pair} ${strategy} → ${dir} ${conf}% (${tick.broker}${tick.simulated ? ' sim' : ''})`)

    if (dir === 'HOLD' || conf < 70) return

    stats.signals++

    // cooldown check
    const key     = `${pair}:${dir}`
    const lastAt  = cooldowns.get(key) || 0
    const elapsed = Date.now() - lastAt
    if (elapsed < COOLDOWN_MS) {
      const remaining = Math.ceil((COOLDOWN_MS - elapsed) / 60_000)
      console.log(`[cooldown] ${key} — ${remaining} min left, skipping`)
      return
    }

    cooldowns.set(key, Date.now())
    stats.alerts++

    const msg = formatAlert(pair, strategy, signal)
    console.log(`[alert] sending ${key}`)
    await tgSend(msg)

  } catch (e) {
    stats.errors++
    console.error(`[scan] ${pair} error:`, e.message)
  }
}

async function runSweep() {
  stats.sweeps++
  console.log(`\n── Sweep #${stats.sweeps} at ${new Date().toISOString()} ──`)

  for (let i = 0; i < PAIRS.length; i++) {
    if (i > 0) await sleep(PAIR_STAGGER)
    await scanPair(PAIRS[i])
  }
}

// ─── Heartbeat ─────────────────────────────────────────────────────────────────

async function sendHeartbeat() {
  const uptimeH = ((Date.now() - stats.startTime) / 3_600_000).toFixed(1)
  const msg = [
    `💓 <b>SybexForexAI Worker — Heartbeat</b>`,
    ``,
    `Uptime  : ${uptimeH} h`,
    `Sweeps  : ${stats.sweeps}`,
    `Signals : ${stats.signals}`,
    `Alerts  : ${stats.alerts}`,
    `Errors  : ${stats.errors}`,
    `Pairs   : ${PAIRS.map(p => p.pair).join(', ')}`,
    ``,
    `⏱ ${new Date().toUTCString()}`,
  ].join('\n')
  console.log('[heartbeat] sending')
  await tgSend(msg)
}

// ─── Utilities ─────────────────────────────────────────────────────────────────

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

// ─── Entrypoint ────────────────────────────────────────────────────────────────

let running = true

process.on('SIGTERM', async () => {
  console.log('[worker] SIGTERM received — shutting down gracefully')
  running = false
  await tgSend('🛑 <b>SybexForexAI Worker</b> — graceful shutdown (SIGTERM)')
  process.exit(0)
})

process.on('SIGINT', async () => {
  console.log('[worker] SIGINT received — shutting down')
  running = false
  process.exit(0)
})

;(async () => {
  console.log(`[worker] Starting — BASE_URL: ${BASE_URL}`)
  await tgSend(
    `🚀 <b>SybexForexAI Worker Started</b>\n` +
    `Scanning ${PAIRS.length} pairs every ${POLL_INTERVAL / 1000}s\n` +
    `Pairs: ${PAIRS.map(p => p.pair).join(', ')}\n` +
    `Alert threshold: confidence ≥ 70%\n` +
    `⏱ ${new Date().toUTCString()}`
  )

  // Schedule 4-hour heartbeat
  setInterval(sendHeartbeat, HEARTBEAT_MS)

  // Main scan loop
  while (running) {
    await runSweep()
    if (running) await sleep(POLL_INTERVAL)
  }
})()
