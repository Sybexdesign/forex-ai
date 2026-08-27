#!/usr/bin/env node
/**
 * SybexForexAI — 24/7 Background Scalper Worker
 *
 * - 10-second polling across XAU/USD and XAG/USD (concurrent tick fetch + pre-filter)
 * - Breakout strategy 24/7 for metals — pre-filter (ADX>25 + BB squeeze) guards quality
 * - Two-stage scan: fast indicator pre-filter → Claude signal only when needed
 * - Risk guards: live strategy pulled every 5 min — riskPct, maxLoss, maxPositions, minStrength, SL/TP all driven from /api/strategy
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
// Explicit demo/live tag for the connected account. The worker honours WORKER_MODE
// to decide whether to actually place orders, but ACCOUNT_TYPE is a separate operator
// signal showing whether the broker_configs row targets a demo or live account.
// Surfaced in every order log + startup banner so it's impossible to accidentally
// route live signals to a live account thinking it was demo.
const ACCOUNT_TYPE = (process.env.ACCOUNT_TYPE || 'demo').toLowerCase()
// User-impersonation JWT (sub = WORKER_USER_ID, role = 'authenticated'). When set,
// every apiFetch sends it as Authorization: Bearer …, so /api/account and /api/orders
// resolve the correct per-user broker_configs row via getBroker(authToken) in
// lib/brokers/index.ts. Without it, those routes fall back to the env-default
// broker singleton, which has no per-user balance and effectively blocks live orders.
const WORKER_SERVICE_JWT = process.env.WORKER_SERVICE_JWT

const POLL_MS          = 10_000       // 10 s per sweep
const SIG_COOLDOWN_MS  = 60_000       // 1 min between Claude calls per pair
const ALERT_COOL_MS    = 15 * 60_000  // 15 min per pair+direction alert
const RISK_CACHE_MS    = 30_000       // 30 s — matches EA balance push cadence so the daily-loss halt and openCount stay close to live; also invalidated on order/outcome/broker-switch
const STRATEGY_REFRESH_MS = 5 * 60_000  // re-pull live strategy every 5 min

// SL/TP clamp bounds — see AutoTradePage MIRROR_SL_CAP comment. Floor = user's
// liveStrategy.slPips/tpPips; outer cap = these constants. Keep in sync with the
// browser values; both code paths feed the same /api/orders endpoint.
// Diagnostic resolved 2026-08-25 (audit Phase 1.3): the raised values were
// originally a TEMP test for retcode 10013. The XAU min-stop floor (20 pips)
// is now the correct constraint; the cap stays at 35 for SL and 70 for TP to
// match lib/trade-levels.ts. Mirrored in components/pages/AutoTradePage.tsx:32.
const MIRROR_SL_CAP = 35
const MIRROR_TP_CAP = 70

// Server-side auto-trade execution (Fix 6 — mirror execution audit).
// PAIR_COOLDOWN_MS matches AutoTradePage so browser + worker can't double-trade.
const PAIR_COOLDOWN_MS    = 5 * 60_000
const lastPairPlacedRef   = new Map()  // pair → ms timestamp of last auto-trade placement
const HEARTBEAT_MS     = 30 * 60_000
const FETCH_TIMEOUT_MS = 45_000       // Claude API can take 10-15 s
const MAX_SIG_BATCH    = 3            // max concurrent Claude calls per sweep

// Live strategy snapshot, refreshed every STRATEGY_REFRESH_MS from /api/strategy.
// Defaults mirror DEFAULT_STRATEGY in lib/supabase.ts so the worker has sensible
// values before the first fetch completes (and if the fetch ever fails).
let liveStrategy = {
  style: 'Day Trader',
  riskPct: 1,
  maxLoss: 3,
  maxPositions: 2,
  minStrength: 80,    // raised from 65 — see lib/supabase.ts (DEFAULT_STRATEGY)
  tpPips: 50,
  slPips: 25,
  watchlist: ['XAU/USD', 'XAG/USD'],
  sessionStart: 0,
  sessionEnd: 24,
  hardDailyStop: true,
  hardNews: true,
  demoLock: false,
  // Server-side auto-trade gate (Fix 6). All three default to safe-off so the
  // worker won't autonomously execute until the user explicitly flips
  // strategies.auto_trade_enabled=TRUE AND the worker is on WORKER_MODE=live.
  autoTradeEnabled:  false,
  autoTradeSections: ['scalp'],
  autoTradePairs:    ['XAU/USD', 'XAG/USD'],
}

// ── Pairs + Strategy Defaults ─────────────────────────────────────────────────

const PAIRS = ['XAU/USD', 'XAG/USD']

const PAIR_STRATEGY = {
  'XAU/USD': 'Breakout',
  'XAG/USD': 'Breakout',
}

// ── Session Detection ─────────────────────────────────────────────────────────
// Market week: Sunday 22:00 UTC → Friday 22:00 UTC

// Both helpers accept an optional Date so callers can thread a single instant
// through one sweep. Calling new Date() separately inside each one allowed the
// same sweep to straddle an hour boundary (e.g. isMarketOpen saw h=20 while the
// log line printed at h=21) — the sweep header could then show [New York] at
// exactly 21:00:00 UTC even though the daily close window had begun.
function isMarketOpen(d = new Date()) {
  const day = d.getUTCDay()   // 0=Sun 6=Sat
  const h   = d.getUTCHours()
  const m   = d.getUTCMinutes()
  if (day === 6) return false                                  // Saturday: always closed
  if (day === 0 && h < 22) return false                       // Sunday before 22:00
  if (day === 5 && (h > 22 || (h === 22 && m >= 0))) return false // Friday after 22:00
  if (h === 21 && day !== 0) return false                      // Daily close 21:00–21:59 UTC (broker reopens 22:00 = 11pm BST)
  return true
}

function getSession(d = new Date()) {
  // The daily close window (21:00–21:59 UTC) is always CLOSED regardless of
  // the named-session band it sits inside — callers normally check isMarketOpen
  // first, but this defensive early-return makes the label correct even when
  // getSession is invoked standalone (e.g. by the heartbeat or per-pair logs).
  if (!isMarketOpen(d)) return 'CLOSED'
  const h = d.getUTCHours()
  if (h >= 22 || h < 7)  return 'Asian'    // 22:00–07:00 UTC  – ranging
  if (h >= 7  && h < 13) return 'London'   // 07:00–13:00 UTC  – trending
  if (h >= 13 && h < 16) return 'Overlap'  // 13:00–16:00 UTC  – highest volatility
  return 'New York'                          // 16:00–22:00 UTC  – trending
}

function getStrategy(pair, session) {
  // Metals use Scalp — Breakout's BB-squeeze pre-filter is too restrictive
  // for normal market conditions and the regime-aware effectiveMinStrength
  // gate on Scalp signals is what we actually want gating execution. The
  // browser path on AutoTradePage already calls Scalp for XAU/XAG; this
  // matches that behaviour so worker + browser see the same signals.
  if (pair.startsWith('XA')) return 'Scalp'
  return PAIR_STRATEGY[pair] || 'Momentum'
}

// ── Auto-trade window: London-NY overlap (golden window) ─────────────────────
// Policy 2026-06-09: TIGHTENED from 12:00-15:59 → 12:00-13:59 UTC weekdays.
// Reason: hourly P/L on 2026-06-09 showed hour 12 = +$173 (7W/0L), hour 13 ≈
// break-even, hour 14 = −$71, hour 15 = −$33. The mirror edge degraded sharply
// after 13:00. Single positive allowlist; outside this 2-hour window auto-
// execution is suppressed entirely. Telegram + worker_logs continue to track
// signals so we can audit what was missed.
function isLondonNYOverlap(d = new Date()) {
  const utcDay  = d.getUTCDay()    // 0=Sun, 6=Sat
  const utcHour = d.getUTCHours()
  const isWeekday = utcDay >= 1 && utcDay <= 5
  const isOverlap = utcHour >= 12 && utcHour < 14
  return isWeekday && isOverlap
}
function nextOverlapInfo(d = new Date()) {
  const utcDay  = d.getUTCDay()
  const utcHour = d.getUTCHours()
  const utcMin  = d.getUTCMinutes()
  if (utcDay >= 1 && utcDay <= 5 && utcHour < 12) {
    const m = (12 - utcHour) * 60 - utcMin
    return `today 12:00 UTC (in ${Math.floor(m/60)}h ${m%60}m)`
  }
  if (utcDay >= 1 && utcDay <= 4 && utcHour >= 14) {
    const m = (24 - utcHour + 12) * 60 - utcMin
    return `tomorrow 12:00 UTC (in ${Math.floor(m/60)}h ${m%60}m)`
  }
  if (utcDay === 5 && utcHour >= 14) return 'Monday 12:00 UTC'
  if (utcDay === 6) return 'Monday 12:00 UTC'
  if (utcDay === 0) return 'Monday 12:00 UTC'
  return 'calculating…'
}

// ── Session direction bias (precious metals only) ─────────────────────────────
// Derived from XAU/USD and XAG/USD signal outcome analysis across 1,139 resolved
// signals. Gold has strong, repeatable intraday directional regimes driven by
// session liquidity. Counter-trend signals have near-zero win rates in each regime:
//
//   Asian  22-06 UTC: BUY  0%, SELL 100% → SELL only
//   London 07-12 UTC: BUY  0%, SELL 100% → SELL only
//   NY+LON 13-16 UTC: BUY 100%, SELL  0% → BUY only
//   NY     17-21 UTC: BUY  4%, SELL  87% → SELL only
//
// The function returns the allowed direction for a given UTC hour, or null if the
// pair is not a metal (no filtering applied). A returned value of 'ANY' means both
// directions are permitted (currently unused — reserved for future regime expansion).
function getMetalSessionBias(pair) {
  if (!pair.startsWith('XAU') && !pair.startsWith('XAG')) return null
  const h = new Date().getUTCHours()
  if (h >= 13 && h < 17) return 'BUY'   // NY+LON overlap — bull regime
  return 'SELL'                           // Asian / London / NY — bear regime
}

// ── Indicator Pre-filter ──────────────────────────────────────────────────────
// Avoids calling Claude unless the market shows a genuine setup.

function hasSignalCondition(tick, strategy) {
  const { rsi14, adx, bbWidth, bbUpper, bbLower, bbMiddle, macdHistogram, price, buyPressure, tickVolume, volSMA20 } = tick
  const relBbWidth = price > 0 ? bbWidth / price : bbWidth
  switch (strategy) {
    case 'Momentum':      return (rsi14 < 42 || rsi14 > 58) && adx > 18
    case 'Mean Reversion': return rsi14 < 38 || rsi14 > 62
    // Scalp: skip the pre-filter — the regime-aware effectiveMinStrength gate
    // downstream (in processSignal) decides whether the signal qualifies.
    // 60s per-pair cooldown caps Claude calls at 2/min total across XAU+XAG.
    case 'Scalp':         return true
    case 'Breakout': {
      if (relBbWidth >= 0.004) return false  // no squeeze — skip
      if (adx <= 20) return false            // weak trend = false breakout
      if (volSMA20 > 0 && tickVolume < volSMA20 * 0.8) return false  // thin-volume breakouts are false
      // Price must be pressing toward the band edge (outer 30% of band width), not just above/below midline.
      // A price barely above mid in a squeeze is still in the consolidation zone — not a breakout.
      const bbWidthVal  = bbUpper - bbLower
      const buyZoneMin  = bbLower + bbWidthVal * 0.70  // top 30% of band
      const sellZoneMax = bbLower + bbWidthVal * 0.30  // bottom 30% of band
      const buySetup  = price >= buyZoneMin  && macdHistogram > 0
      const sellSetup = price <= sellZoneMax && macdHistogram < 0
      return buySetup || sellSetup
    }
    default:              return buyPressure < 0.38 || buyPressure > 0.62
  }
}

// ── Direction Inference ───────────────────────────────────────────────────────
// Infers the likely signal direction from 5m tick — same logic as the pre-filter.
// Used to confirm 5m aligns with the HTF direction (never used as primary authority).

function inferDirection(tick) {
  const mid = tick.bbMiddle || (tick.bbUpper + tick.bbLower) / 2
  if (tick.price > mid && tick.macdHistogram > 0) return 'BUY'
  if (tick.price < mid && tick.macdHistogram < 0) return 'SELL'
  return null
}

// Top-down HTF direction — 15m is the authority, 5m must confirm.
// Returns 'BUY', 'SELL', or null (ambiguous — no trade allowed when null).
// Uses persistent EMA relationship (ema20 > ema50), not emaCrossSignal which only
// fires on the one candle where EMA crosses — missing the entire steady trend thereafter.
function inferHTFDirection(htfTick) {
  if (!htfTick || htfTick.simulated) return null
  const ema20AboveEma50 = htfTick.ema20 > htfTick.ema50
  const htfBullish = ema20AboveEma50  && htfTick.macdHistogram > 0 && htfTick.rsi14 > 50
  const htfBearish = !ema20AboveEma50 && htfTick.macdHistogram < 0 && htfTick.rsi14 < 50
  if (htfBullish) return 'BUY'
  if (htfBearish) return 'SELL'
  return null
}

// ── State ─────────────────────────────────────────────────────────────────────

const lastSigFetch   = new Map()   // pair → ms timestamp
const alertCooldowns = new Map()   // `${pair}:${direction}` → ms timestamp
const mlMissingAlerts = new Map()  // pair → ms timestamp of last ML-veto-missing Telegram alert
const stalePriceTrack = new Map()  // pair → { price: number, count: number }
const htfCache        = new Map()  // `${pair}:${tf}` → { tick, at }
const STALE_SKIP_COUNT = 12        // skip signal after N identical consecutive prices (~2 min at 10s sweeps)
const HTF_CACHE_MS    = 30_000     // 30s — prevents serving a candle that closed on the previous bar
let   cachedRisk     = null
let   riskCachedAt   = 0
let   lastCbClearedAt = null  // CB ISO timestamp we've already announced "cleared" for — dedup
let   lastCbArmedAt   = null  // CB ISO timestamp we've already announced "armed" for — dedup
let   tradingHalted  = false
let   haltNotified   = false

// ── Admin cache reset ─────────────────────────────────────────────────────────
// Polls /api/worker/cache-reset every sweep. When the admin clears caches from
// the Admin page, this endpoint returns { reset: true } and the worker resets
// all in-memory state so the next sweep starts fresh.
let _lastCacheResetCheck = 0
const CACHE_RESET_CHECK_MS = 30_000  // check every 30s (every ~3 sweeps)

async function checkForCacheReset() {
  const now = Date.now()
  if (now - _lastCacheResetCheck < CACHE_RESET_CHECK_MS) return
  _lastCacheResetCheck = now
  try {
    const data = await apiFetch('/api/worker/cache-reset')
    if (data?.reset) {
      console.log('[worker] ⚡ Admin cache reset received — clearing in-memory state')
      // Clear all in-memory caches
      lastSigFetch.clear()
      alertCooldowns.clear()
      mlMissingAlerts.clear()
      stalePriceTrack.clear()
      htfCache.clear()
      lastPairPlacedRef.clear()
      pendingSignals.clear()
      cachedRisk = null
      riskCachedAt = 0
      tradingHalted = false
      haltNotified = false
      lastCbClearedAt = null
      lastCbArmedAt = null
      wlog('info', 'Admin cache reset applied — in-memory state cleared', { metadata: { ts: new Date().toISOString() } })
      tgSend('🧹 <b>Cache Reset Applied</b>\n\nWorker in-memory state cleared by admin.\nRisk cache, HTF cache, cooldowns, pending signals all reset.')
        .catch(() => {})
    }
  } catch (e) {
    // Silent — don't spam logs if the endpoint is briefly unavailable
  }
}

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

// Latest unexpired direction-confirmation for (user, pair). Used by the
// auto-trade gate — operator must have clicked TEST/CHECK MARKET DIRECTION
// at most ~5min ago for the worker to be allowed to execute on this pair.
// Returns null when no row exists, on transient DB errors, or when
// WORKER_USER_ID isn't configured (worker can't be associated with a user).
//
// The table check constraint guarantees only 5m confirmations are persisted,
// so the worker's gate is effectively "5m confirmations only" without needing
// to filter on timeframe here. 1m confirmations are operator-advisory.
async function fetchLatestDirectionConfirmation(pair) {
  if (!SUPABASE_URL || !SUPABASE_KEY || !WORKER_USER_ID) return null
  try {
    const nowIso = new Date().toISOString()
    const url = `${SUPABASE_URL}/rest/v1/direction_confirmations`
      + `?user_id=eq.${WORKER_USER_ID}`
      + `&pair=eq.${encodeURIComponent(pair)}`
      + `&expires_at=gt.${encodeURIComponent(nowIso)}`
      + `&order=analyzed_at.desc&limit=1`
    const res = await fetch(url, {
      headers: {
        'apikey':        SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
      },
      signal: AbortSignal.timeout(5_000),
    })
    if (!res.ok) {
      console.error(`[sb/direction_confirmations]`, res.status, await res.text())
      return null
    }
    const rows = await res.json()
    return Array.isArray(rows) && rows.length > 0 ? rows[0] : null
  } catch (e) {
    console.error('[sb/direction_confirmations]', e.message)
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

// ── Signal Reconciliation (Scalp vs Mirror) ───────────────────────────────────
// Observability/scoring layer that captures scalp and mirror signal snapshots
// at generation time, then resolves them against the live market price after
// the stated timeframe (1m/5m) has elapsed. Used to compute rolling win-rate
// comparisons between the two signal paths.
//
// Config values pulled from env — not hardcoded:
//   SIGNAL_RECON_NOISE_THRESHOLD_PIPS — minimum movement (in pips) for a signal
//     to be scored WIN/LOSS. Below this, outcome = INCONCLUSIVE (noise, not
//     confirmation). Default 0.3 pips.
//   SIGNAL_RECON_RESOLVE_BATCH — max rows to resolve per sweep. Default 20.
//
// IMPORTANT: This is an observability layer ONLY. It does NOT gate or alter
// auto-trade execution in any way. A scheduling bug here must never trigger
// unintended trades.

const RECON_NOISE_THRESHOLD_PIPS = parseFloat(process.env.SIGNAL_RECON_NOISE_THRESHOLD_PIPS || '0.3')
const RECON_RESOLVE_BATCH        = parseInt(process.env.SIGNAL_RECON_RESOLVE_BATCH || '20', 10)

// Captures a scalp or mirror signal snapshot into signal_reconciliation.
// Called at signal generation time (in processSignal) for both the scalp
// direction and its mirror inverse. Each gets its OWN row — they are separate
// predictions graded against the same outcome.
async function captureSignalReconciliation({ signalType, pair, direction, entryPrice, timeframe, signalId }) {
  if (!SUPABASE_URL || !SUPABASE_KEY || !WORKER_USER_ID) return
  if (!direction) return
  if (!entryPrice || entryPrice <= 0) return
  try {
    await sbInsert('signal_reconciliation', {
      user_id:     WORKER_USER_ID,
      signal_type: signalType,          // 'scalp' | 'mirror'
      pair,
      direction,                        // 'BUY' | 'SELL' | 'HOLD'
      entry_price: entryPrice,
      timeframe,                        // '1m' | '5m'
      generated_at: new Date().toISOString(),
      signal_id:   signalId || null,
      outcome:     'PENDING',
    })
    console.log(`[recon] captured ${signalType} ${pair} ${direction} @ ${entryPrice} (${timeframe})`)
  } catch (e) {
    console.error('[recon] capture failed:', e.message)
  }
}


// Fetches pending reconciliation rows that are due for resolution
// (generated_at + timeframe <= now). Returns [] on any failure.
async function fetchDueReconciliations() {
  if (!SUPABASE_URL || !SUPABASE_KEY || !WORKER_USER_ID) return []
  try {
    const nowIso = new Date().toISOString()
    // Fetch all PENDING rows for this user, then filter in JS for due ones.
    // The table is small per-user so this is fine. We use the index on
    // (generated_at, timeframe) to keep it fast.
    const url = `${SUPABASE_URL}/rest/v1/signal_reconciliation`
      + `?user_id=eq.${WORKER_USER_ID}`
      + `&outcome=eq.PENDING`
      + `&order=generated_at.asc`
      + `&limit=${RECON_RESOLVE_BATCH}`
    const res = await fetch(url, {
      headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` },
      signal:  AbortSignal.timeout(10_000),
    })
    if (!res.ok) { console.error('[recon] fetch failed:', res.status, await res.text()); return [] }
    const rows = await res.json()
    if (!Array.isArray(rows)) return []

    // Filter to rows where generated_at + timeframe <= now
    const due = rows.filter(r => {
      const genMs = new Date(r.generated_at).getTime()
      const tfMs  = (r.timeframe === '1m' ? 60 : 300) * 1000
      return Date.now() >= genMs + tfMs
    })
    return due
  } catch (e) {
    console.error('[recon] fetch error:', e.message)
    return []
  }
}

// Resolves a single reconciliation row against the live market price.
// Uses the SAME price feed as the worker (fetchTick → /api/scalper/tick),
// so spread differences can't create false mismatches.
async function resolveReconciliation(row) {
  try {
    const tick = await fetchTick(row.pair)
    if (!tick || tick.simulated) {
      // Simulated data — cannot resolve against a real price. Leave PENDING.
      console.log(`[recon] ${row.id.slice(0, 8)} skip — simulated feed for ${row.pair}`)
      return
    }
    const resolvedPrice = tick.price
    const entryPrice    = parseFloat(row.entry_price)
    const pip           = pipSize(row.pair)
    const movementPips  = Math.abs(resolvedPrice - entryPrice) / pip

    let outcome
    if (row.direction === 'HOLD') {
      // A HOLD signal doesn't commit to a direction — there is no directional
      // bet to grade. It's inherently inconclusive (the model abstained).
      outcome = 'INCONCLUSIVE'
    } else if (movementPips < RECON_NOISE_THRESHOLD_PIPS) {
      // Below noise threshold — not enough movement to confirm either way.
      outcome = 'INCONCLUSIVE'
    } else if (row.direction === 'BUY') {
      outcome = resolvedPrice > entryPrice ? 'WIN' : 'LOSS'
    } else { // SELL
      outcome = resolvedPrice < entryPrice ? 'WIN' : 'LOSS'
    }


    await sbUpdate('signal_reconciliation', row.id, {
      resolved_at:    new Date().toISOString(),
      resolved_price: resolvedPrice,
      outcome,
      movement_pips:  +movementPips.toFixed(2),
    })
    console.log(`[recon] ${row.signal_type} ${row.pair} ${row.direction} → ${outcome} (${movementPips.toFixed(1)} pips, entry=${entryPrice}, resolved=${resolvedPrice})`)
  } catch (e) {
    console.error(`[recon] resolve failed for ${row.id.slice(0, 8)}:`, e.message)
  }
}

// Stale-PENDING alert — dedup key so we only alert once per stale batch.
let lastStaleReconAlertAt = 0
const STALE_RECON_ALERT_COOLDOWN_MS = 30 * 60_000  // 30 min between alerts

// Detects PENDING reconciliation rows that are well past their due time
// (generated_at + timeframe elapsed by > 2× the timeframe). These indicate the
// worker was down or a sweep missed them — silent gaps in the win-rate sample.
// Alert-only (Telegram + worker_logs); never blocks or alters anything.
async function alertStaleReconciliations() {
  if (!SUPABASE_URL || !SUPABASE_KEY || !WORKER_USER_ID) return
  if (Date.now() - lastStaleReconAlertAt < STALE_RECON_ALERT_COOLDOWN_MS) return
  try {
    const url = `${SUPABASE_URL}/rest/v1/signal_reconciliation`
      + `?user_id=eq.${WORKER_USER_ID}`
      + `&outcome=eq.PENDING`
      + `&order=generated_at.asc`
      + `&limit=100`

    const res = await fetch(url, {
      headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` },
      signal:  AbortSignal.timeout(10_000),
    })
    if (!res.ok) return
    const rows = await res.json()
    if (!Array.isArray(rows)) return

    // Count rows that are > 2× their timeframe past due
    const stale = rows.filter(r => {
      const genMs = new Date(r.generated_at).getTime()
      const tfMs  = (r.timeframe === '1m' ? 60 : 300) * 1000
      return Date.now() >= genMs + tfMs * 2
    })
    if (stale.length === 0) return

    lastStaleReconAlertAt = Date.now()
    const oldest = stale[0]
    const oldestAgeMin = Math.round((Date.now() - new Date(oldest.generated_at).getTime()) / 60_000)
    console.warn(`[recon] ${stale.length} stale PENDING row(s) — oldest ${oldestAgeMin} min old (${oldest.pair} ${oldest.signal_type})`)
    wlog('warn', `Signal reconciliation backlog: ${stale.length} stale PENDING row(s)`, {
      metadata: { staleCount: stale.length, oldestAgeMin, oldestPair: oldest.pair, oldestType: oldest.signal_type },
    })
    await tgSend(
      `⚠️ <b>SIGNAL RECONCILIATION BACKLOG</b>\n\n` +
      `${stale.length} signal(s) are stuck PENDING past their resolution window.\n` +
      `Oldest: ${oldest.pair} ${oldest.signal_type} (${oldestAgeMin} min overdue)\n\n` +
      `This usually means the worker was down or a sweep missed them.\n` +
      `Win-rate sample may have gaps.`
    ).catch(() => {})
  } catch (e) {
    console.warn('[recon] stale-alert failed:', e.message)
  }
}

// Sweep hook — resolves any reconciliation rows that are due, and alerts on
// stale PENDING rows (worker-down / missed-sweep gaps). Both are observability
// only — never gate or alter auto-trade execution.
async function resolvePendingReconciliations() {
  const due = await fetchDueReconciliations()
  if (due.length > 0) {
    console.log(`[recon] resolving ${due.length} due signal(s)`)
    // Resolve sequentially to avoid hammering the price feed
    for (const row of due) {
      await resolveReconciliation(row)
    }
  }
  // Alert on stale PENDING rows (past their resolution window by > 2× timeframe).
  // Runs every sweep regardless of whether any rows were due, so a backlog is
  // caught even when the due-filter happens to return nothing. Runs after
  // resolution so freshly-resolved rows don't trigger a false alert.
  await alertStaleReconciliations().catch(e =>
    console.warn('[recon] stale-alert failed:', e.message)
  )
}





// ── Direction-bias detector (auto-section-switch) ─────────────────────────────
// After 3 consecutive LOSSes on the currently-active section, flip sections so
// the worker stops fighting the AI's current calibration regime. Polled every
// 60s; uses lastAutoSectionSwitchAt cooldown so we don't oscillate while the
// new section's trades land.

const AUTO_SECTION_SWITCH_COOLDOWN_MS = 15 * 60_000  // 15 min between auto-flips
let   lastAutoSectionSwitchAt         = 0

// Fetches the latest N closed trades for a specific source on XAU/USD, ordered
// most-recent first. Returns [] on any failure (we always fail-open here — the
// bias detector is a nice-to-have, not a safety guard).
async function fetchRecentTradesBySource(source, n = 3) {
  if (!SUPABASE_URL || !SUPABASE_KEY || !WORKER_USER_ID) return []
  try {
    const url = `${SUPABASE_URL}/rest/v1/trades`
      + `?user_id=eq.${WORKER_USER_ID}`
      + `&pair=eq.XAU%2FUSD`
      + `&source=eq.${source}`
      + `&result=in.%28WIN%2CLOSS%29`
      + `&order=created_at.desc`
      + `&limit=${n}`
      + `&select=source,result,pl_usd,created_at`
    const res = await fetch(url, {
      headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` },
      signal:  AbortSignal.timeout(10_000),
    })
    if (!res.ok) return []
    return await res.json()
  } catch (e) {
    console.warn('[bias] trade-fetch failed:', e.message)
    return []
  }
}

// Posts the new section to /api/strategy. Uses apiFetch so the WORKER_SERVICE_JWT
// is included; the POST handler accepts a partial autoTrade payload so settings
// stay untouched.
async function postAutoTradeSection(newSection) {
  if (!WORKER_USER_ID) return false
  try {
    await apiFetch('/api/strategy', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        userId:    WORKER_USER_ID,
        autoTrade: { sections: [newSection] },
      }),
    })
    return true
  } catch (e) {
    console.warn('[bias] strategy-update failed:', e.message)
    return false
  }
}

async function evaluateSectionBias() {
  // DISABLED 2026-06-08 — operator decision: mirror is the permanent default.
  // The bias detector's only function was flipping between scalp and mirror
  // sections after 3 consecutive losses, which contradicts the "always mirror"
  // policy. Regime classifier and CB trigger continue to handle threshold and
  // pause logic; direction is never auto-switched. Keep the function body
  // intact below the early-return so re-enabling is a one-line change.
  return

  // eslint-disable-next-line no-unreachable
  if (!liveStrategy.autoTradeEnabled) return
  if (!Array.isArray(liveStrategy.autoTradeSections) || liveStrategy.autoTradeSections.length !== 1) return
  if (Date.now() - lastAutoSectionSwitchAt < AUTO_SECTION_SWITCH_COOLDOWN_MS) return

  const current = liveStrategy.autoTradeSections[0]
  if (current !== 'scalp' && current !== 'mirror') return

  const recent = await fetchRecentTradesBySource(current, 3)
  // Need exactly 3 LOSS results in the most recent 3 to trigger
  if (recent.length < 3) return
  const losses = recent.filter(t => t.result === 'LOSS').length
  if (losses < 3) return

  const next = current === 'mirror' ? 'scalp' : 'mirror'
  const ok   = await postAutoTradeSection(next)
  if (!ok) {
    console.warn(`[bias] ${current}→${next} update failed — will retry on next interval`)
    return
  }

  lastAutoSectionSwitchAt = Date.now()
  // Local mirror so the worker's auto-trade gate uses the new section before
  // the next loadStrategy() refresh picks it up via API.
  liveStrategy.autoTradeSections = [next]

  const aiState   = next === 'scalp' ? 'calibrated (follow AI direction)' : 'miscalibrated (inverse AI direction)'
  const reason    = next === 'scalp'
    ? 'AI appears calibrated in current market — switching to scalp'
    : 'AI appears miscalibrated in current market — switching to mirror'
  console.log(`[bias] 3 consecutive ${current} LOSSes → auto-switching to ${next}`)
  wlog('info', `auto-section-switch: ${current} → ${next}`, {
    metadata: { from: current, to: next, trigger: '3 consecutive losses', recent: recent.map(t => ({ at: t.created_at, pl: t.pl_usd })) },
  })
  await tgSend(
    `🔄 <b>AUTO-SECTION SWITCH</b>\n` +
    `\n` +
    `Last 3 ${current} trades on XAU/USD all LOST\n` +
    `Switching to <b>${next.toUpperCase()}</b> (${aiState})\n` +
    `Reason: ${reason}\n` +
    `\n` +
    `Worker auto-trade gate now uses ${next}.`
  )
}

// ── Direction-loss streak gate ────────────────────────────────────────────────
// Blocks placement when 3 consecutive LOSSes have been recorded on a given
// broker-side direction. Counter is in-memory, seeded from history on startup,
// then maintained per-trade by reconcileClosedTrades() which polls the trades
// table for rows closed since lastReconciledAt. Direction = executionDirection
// = broker side (sectionDir after mirror inversion), matching trades.direction.

const directionLosses = { BUY: 0, SELL: 0 }
const directionStreakAlerted = { BUY: false, SELL: false }
let   lastReconciledAt          = null              // ISO timestamp; null = uninitialised
const DIRECTION_RECONCILE_MS    = 60_000

async function fetchRecentTradesByDirection(direction, n = 3) {
  if (!SUPABASE_URL || !SUPABASE_KEY || !WORKER_USER_ID) return []
  try {
    const url = `${SUPABASE_URL}/rest/v1/trades`
      + `?user_id=eq.${WORKER_USER_ID}`
      + `&pair=eq.XAU%2FUSD`
      + `&direction=eq.${direction}`
      + `&result=in.%28WIN%2CLOSS%29`
      + `&order=closed_at.desc.nullslast`
      + `&limit=${n}`
      + `&select=direction,result,pl_usd,closed_at,created_at`
    const res = await fetch(url, {
      headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` },
      signal:  AbortSignal.timeout(10_000),
    })
    if (!res.ok) return []
    return await res.json()
  } catch (e) {
    console.warn('[dir-loss] trade-fetch failed:', e.message)
    return []
  }
}

// Seed counters from history so the gate reflects an ongoing streak across
// worker restarts. Sets lastReconciledAt to now so reconcileClosedTrades only
// processes truly new closures from here forward.
async function seedDirectionLosses() {
  for (const d of ['BUY', 'SELL']) {
    const recent = await fetchRecentTradesByDirection(d, 3)
    let streak = 0
    for (const t of recent) {
      if (t.result === 'LOSS') streak++
      else break
    }
    directionLosses[d] = streak
    directionStreakAlerted[d] = streak >= 3
  }
  lastReconciledAt = new Date().toISOString()
  console.log(`[dir-loss] seeded — BUY=${directionLosses.BUY} SELL=${directionLosses.SELL} since=${lastReconciledAt}`)
}

// Polls for trades closed since lastReconciledAt and applies per-trade
// increment/reset. Ascending order so streaks update in the same sequence the
// broker recorded them.
async function reconcileClosedTrades() {
  if (!SUPABASE_URL || !SUPABASE_KEY || !WORKER_USER_ID) return
  if (!lastReconciledAt) return
  try {
    const url = `${SUPABASE_URL}/rest/v1/trades`
      + `?user_id=eq.${WORKER_USER_ID}`
      + `&pair=eq.XAU%2FUSD`
      + `&result=in.%28WIN%2CLOSS%29`
      + `&closed_at=gt.${encodeURIComponent(lastReconciledAt)}`
      + `&order=closed_at.asc`
      + `&select=direction,result,pl_usd,closed_at`
    const res = await fetch(url, {
      headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` },
      signal:  AbortSignal.timeout(10_000),
    })
    if (!res.ok) return
    const rows = await res.json()
    for (const trade of rows) {
      if (trade.result === 'LOSS') {
        directionLosses[trade.direction] = (directionLosses[trade.direction] || 0) + 1
        if (directionLosses[trade.direction] >= 3 && !directionStreakAlerted[trade.direction]) {
          directionStreakAlerted[trade.direction] = true
          console.log(`[auto] ${trade.direction} direction blocked — 3 consecutive losses`)
          await tgSend(
            `⚠️ <b>DIRECTION BLOCK</b>\n` +
            `${trade.direction} blocked after 3 consecutive losses\n` +
            `Mirror will skip ${trade.direction} signals until a win`
          ).catch(() => {})
        }
      } else if (trade.result === 'WIN') {
        directionLosses[trade.direction] = 0
        directionStreakAlerted[trade.direction] = false
      }
      if (trade.closed_at) lastReconciledAt = trade.closed_at
    }
  } catch (e) {
    console.warn('[dir-loss] reconcile failed:', e.message)
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
      // Invalidate the risk cache — a position just closed so openCount is now lower.
      // Without this, the next signal would still see the pre-close count for up to 2 min
      // and could be incorrectly throttled by the maxPositions gate.
      cachedRisk = null
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

function formatAlert(pair, strategy, session, signal, mode, placement) {
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

  // Optional placement block — only emitted on live placements that returned
  // lot info. Shows lots + source (manual/auto) + max-loss USD so the operator
  // can verify the position size matches the configured override.
  let placementBlock = ''
  if (mode === 'live' && placement && typeof placement.lots === 'number') {
    const pipPerLot = pair.includes('XAU') ? 10 : pair.includes('JPY') ? 6.8 : 10
    const maxLoss   = placement.lots * pipPerLot * (placement.slPips || +slPips)
    const sourceTag = placement.source === 'manual' ? 'manual' : 'auto'
    placementBlock = [
      ``,
      `Lots   : <b>${placement.lots}</b> (${sourceTag})`,
      `Max loss: $${maxLoss.toFixed(2)}` + (placement.section ? `  [${placement.section}]` : ''),
    ].join('\n')
  }

  const regimeLine = signal.marketRegime
    ? `Regime: ${signal.marketRegime}${typeof signal.adx === 'number' ? ` (ADX ${signal.adx.toFixed(1)})` : ''}`
    : ''

  return [
    `${emoji} <b>${dir} ${pair}</b>  [${strategy} · ${session}]`,
    `Confidence: <b>${signal.confidence}%</b>  ${badge}`,
    regimeLine,
    ``,
    `Entry  : <code>${f(entry)}</code>`,
    `SL     : <code>${f(sl)}</code>  (${slPips} pips)`,
    `TP     : <code>${f(tp)}</code>  (${tpPips} pips)`,
    `R:R    : 1 : ${rr}`,
    placementBlock,
    ``,
    reasons,
    signal.risk_note ? `\n⚠ ${signal.risk_note}` : '',
    `⏱ ${new Date().toUTCString()}`,
  ].filter(Boolean).join('\n').replace(/\n{3,}/g, '\n\n')
}

// ── API Helpers ───────────────────────────────────────────────────────────────

async function apiFetch(path, options = {}) {
  // Always send the worker's user-impersonation JWT (when configured) so server
  // routes that call getBroker(authToken) resolve the correct per-user
  // broker_configs row instead of falling to the env-default singleton.
  const headers = { ...(options.headers || {}) }
  if (WORKER_SERVICE_JWT && !headers.Authorization && !headers.authorization) {
    headers.Authorization = `Bearer ${WORKER_SERVICE_JWT}`
  }
  const res = await fetch(`${BASE_URL}${path}`, {
    ...options,
    headers,
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

// ── HTF Alignment ─────────────────────────────────────────────────────────────
// Fetches 15m indicators and checks whether the higher-timeframe trend agrees
// with the 5m signal direction before we spend an AI call on it.

async function fetchHTFTick(pair) {
  const key = `${pair}:15m`
  const hit = htfCache.get(key)
  if (hit && Date.now() - hit.at < HTF_CACHE_MS) return hit.tick
  const tick = await apiFetch(`/api/scalper/tick?pair=${encodeURIComponent(pair)}&timeframe=15m`)
  htfCache.set(key, { tick, at: Date.now() })
  return tick
}

async function isHTFAligned(pair, direction) {
  try {
    const htf = await fetchHTFTick(pair)
    if (htf.simulated) return true  // HTF feed unavailable — don't block on missing data
    // Use persistent EMA state (ema20 > ema50), not emaCrossSignal which only fires on the cross candle.
    // In a steady trend emaCrossSignal = 'FLAT', so checking it misses the whole trend.
    const ema20AboveEma50 = htf.ema20 > htf.ema50
    const htfBullish = ema20AboveEma50  && htf.macdHistogram > 0 && htf.rsi14 > 50
    const htfBearish = !ema20AboveEma50 && htf.macdHistogram < 0 && htf.rsi14 < 50
    const aligned    = direction === 'BUY' ? htfBullish : htfBearish
    console.log(`[htf] ${pair} 15m: ema20${ema20AboveEma50 ? '>' : '<'}ema50 macd=${htf.macdHistogram?.toFixed(4)} rsi=${htf.rsi14} → ${aligned ? '✅ aligned' : '❌ misaligned'} for ${direction}`)
    return aligned
  } catch (e) {
    console.warn(`[htf] ${pair} fetch failed: ${e.message} — allowing through`)
    return true  // never block on a fetch error
  }
}

async function loadStrategy() {
  if (!WORKER_USER_ID) return  // no user → keep defaults
  try {
    const data = await apiFetch(`/api/strategy?userId=${encodeURIComponent(WORKER_USER_ID)}`)
    if (data?.settings && typeof data.settings === 'object') {
      liveStrategy = { ...liveStrategy, ...data.settings }
    }
    // Fix 6 — also merge the auto-trade gate so the worker knows whether to
    // execute autonomously. Defaults preserve safe-off when /api/strategy
    // doesn't return the field (older deploys / migration not yet applied).
    if (data?.autoTrade && typeof data.autoTrade === 'object') {
      liveStrategy.autoTradeEnabled  = !!data.autoTrade.enabled
      liveStrategy.autoTradeSections = Array.isArray(data.autoTrade.sections) ? data.autoTrade.sections : ['scalp']
      liveStrategy.autoTradePairs    = Array.isArray(data.autoTrade.pairs)    ? data.autoTrade.pairs    : ['XAU/USD','XAG/USD']
    }
    const lotMode = (typeof liveStrategy.manualLots === 'number' && liveStrategy.manualLots > 0)
      ? `manual=${liveStrategy.manualLots}lot`
      : 'auto'
    console.log(`[strategy] loaded — minStrength=${liveStrategy.minStrength}% riskPct=${liveStrategy.riskPct}% SL=${liveStrategy.slPips}p TP=${liveStrategy.tpPips}p maxPos=${liveStrategy.maxPositions} sizing=${lotMode} | autoEnabled=${liveStrategy.autoTradeEnabled} sections=[${liveStrategy.autoTradeSections.join(',')}] pairs=[${liveStrategy.autoTradePairs.join(',')}]`)
  } catch (e) {
    console.warn('[strategy] fetch failed — using cached values:', e.message)
  }
}

async function fetchRiskState() {
  // Serve cache unless TTL expired OR broker identity changed (account switch).
  if (cachedRisk && Date.now() - riskCachedAt < RISK_CACHE_MS) return cachedRisk
  const acct      = await apiFetch('/api/account')
  const balance   = acct.balance   || 0
  const realizedPL = acct.realizedPL || 0  // negative = loss today
  const openCount = (acct.openTrades || []).length
  const dailyLossPct = (balance > 0 && realizedPL < 0)
    ? Math.abs(realizedPL) / balance
    : 0
  // Detect broker switch via two signals (either fires):
  //   1. Broker NAME changed (e.g. MT5 Direct → OANDA): different adapter resolved
  //   2. last_switched_at advanced: same broker name but config row was re-activated
  //      (e.g. re-saved credentials or flipped is_active off then back on)
  // Both invalidate the cache, both log to worker_logs so the operator can audit.
  const nameChanged = cachedRisk && cachedRisk.broker && acct.broker && cachedRisk.broker !== acct.broker
  const stampChanged = cachedRisk && acct.lastSwitchedAt && cachedRisk.lastSwitchedAt &&
                       acct.lastSwitchedAt !== cachedRisk.lastSwitchedAt
  if (nameChanged || stampChanged) {
    const reason = nameChanged ? `name '${cachedRisk.broker}' → '${acct.broker}'` : `last_switched_at advanced to ${acct.lastSwitchedAt}`
    console.log(`[worker] Account switch detected — reconnecting broker immediately (${reason})`)
    wlog('info', `Account switch detected: ${reason} · balance now ${balance}`, { metadata: { from: cachedRisk.broker, to: acct.broker, lastSwitchedAt: acct.lastSwitchedAt, balance } })
  }
  // Circuit-breaker transition detection: when the previous fetch saw an active
  // CB and the current fetch sees it expired, fire the Telegram CLEARED alert
  // once. Stored in module state so it survives across cache refreshes.
  const cbCurrent = acct.circuitBreakerUntil || null
  const cbCurMs   = cbCurrent ? new Date(cbCurrent).getTime() : 0
  const cbWasActive = cachedRisk && cachedRisk.circuitBreakerUntil
                   && new Date(cachedRisk.circuitBreakerUntil).getTime() > riskCachedAt
  const cbNowActive = cbCurMs > Date.now()
  if (cbWasActive && !cbNowActive && lastCbClearedAt !== cbCurrent) {
    lastCbClearedAt = cbCurrent
    console.log(`[worker] Circuit breaker cleared — auto-trade resumed (was until ${cbCurrent})`)
    wlog('info', `Circuit breaker cleared — auto-trade resumed`, { metadata: { wasUntil: cbCurrent } })
    tgSend('✅ <b>CIRCUIT BREAKER CLEARED</b>\n\nAuto-trade resumed\nNext qualifying signal will execute normally.').catch(() => {})
  }
  // ARMED detection: the new SQL trigger arms CB inline when a loss is written.
  // Dedup on lastCbArmedAt so we only alert once per arming event.
  const armedAt = acct.lastCbArmedAt || null
  if (armedAt && cbNowActive && lastCbArmedAt !== armedAt) {
    lastCbArmedAt = armedAt
    const pair    = acct.lastCbArmedPair || 'unknown'
    const pl      = Number(acct.lastCbArmedPl   || 0)
    const oneR    = Number(acct.lastCbArmedOneR || 0)
    const untilUtc = cbCurrent ? new Date(cbCurrent).toUTCString().slice(17, 25) : '—'
    console.warn(`[worker] CIRCUIT BREAKER ARMED — ${pair} lost $${Math.abs(pl).toFixed(2)} (1R=$${oneR.toFixed(2)}); pausing auto-trade until ${cbCurrent}`)
    wlog('warn', `Circuit breaker armed: ${pair} loss $${pl} (1R=$${oneR})`, {
      pair, metadata: { reason: 'realised_loss', pl, oneR, armedAt, until: cbCurrent },
    })
    tgSend(
      `⚡ <b>CIRCUIT BREAKER ARMED</b>\n\n` +
      `Reason: Loss exceeded 0.85R on ${pair}\n` +
      `Last trade: <code>-$${Math.abs(pl).toFixed(2)}</code> (1R = $${oneR.toFixed(2)})\n` +
      `Auto-trade paused for <b>15 minutes</b>\n` +
      `Resumes at: ${untilUtc} UTC\n\n` +
      `All signals will be logged but not executed during this window.`
    ).catch(() => {})
  }
  cachedRisk   = {
    balance, openCount, dailyLossPct,
    broker: acct.broker,
    lastSwitchedAt: acct.lastSwitchedAt || null,
    // Circuit-breaker timestamp written by mt5-sync after a >1R loss. Worker
    // skips auto-trade execution while Date.now() < circuitBreakerUntil.
    circuitBreakerUntil: cbCurrent,
  }
  riskCachedAt = Date.now()
  return cachedRisk
}

// Decision logger for the auto-trade engine. Every skip/execute event lands in
// worker_logs with a reason code so the operator can audit why a signal didn't
// (or did) fire. Reason values: executed | skipped-confidence | skipped-adx |
// skipped-cooldown | skipped-session-daily-close | skipped-sunday-preopen |
// skipped-maxpositions | skipped-disabled | skipped-paper-mode |
// skipped-pair-filter | skipped-section-disabled | skipped-staleness
async function logAutoTradeDecision(reason, pair, direction, signal, extra = {}) {
  return wlog('order', `auto-trade ${reason}: ${pair} ${direction}${signal?.marketRegime ? ` [${signal.marketRegime}]` : ''}`, {
    pair,
    session: getSession(),
    metadata: {
      reason,
      direction,
      confidence:           signal?.confidence,
      marketRegime:         signal?.marketRegime         ?? null,
      effectiveMinStrength: signal?.effectiveMinStrength ?? null,
      suggestedSection:     signal?.suggestedSection     ?? null,
      adx:                  signal?.adx                  ?? null,
      ...extra,
    },
  })
}

// section: 'scalp' (signal direction) or 'mirror' (inverted direction)
async function placeOrder(pair, direction, signal, section = 'scalp') {
  // Send the full live strategy so runRiskGuards() in lib/risk.ts can enforce
  // maxPositions, maxLoss, hardDailyStop, hardNews, and session times — not just
  // sizing/SL/TP. Sized off the user's configured riskPct, not a hardcoded 1%.
  // The worker derives SL/TP from the AI signal's price levels and applies the
  // same Option C floor/cap clamp the browser uses, then overrides slPips/tpPips
  // in the strategy payload so /api/orders sizes off the clamped values.
  const pip = pipSize(pair)
  const sourceSlPips = signal.sl && signal.entry ? Math.abs(signal.entry - signal.sl) / pip : null
  const sourceTpPips = signal.tp && signal.entry ? Math.abs(signal.tp   - signal.entry) / pip : null
  const floorSl      = liveStrategy.slPips || 18
  const floorTp      = liveStrategy.tpPips || 36
  const clampedSl    = sourceSlPips !== null
    ? Math.min(MIRROR_SL_CAP, Math.max(floorSl, sourceSlPips))
    : floorSl
  const clampedTp    = sourceTpPips !== null
    ? Math.min(MIRROR_TP_CAP, Math.max(floorTp, sourceTpPips))
    : floorTp
  const nowIso       = new Date().toISOString()
  // Source attribution: 'scalp' for forward direction, 'mirror' for inverse.
  // signal_id_ref carries a worker- prefix so audit queries can isolate
  // server-placed trades from browser-placed trades within the same source.
  const source       = section === 'mirror' ? 'mirror' : 'scalp'
  const signalRef    = `worker-${section}-${pair.replace('/', '')}-${Date.now()}`
  return apiFetch('/api/orders', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({
      pair,
      direction,
      // Spread liveStrategy and override slPips/tpPips with the clamped values so
      // orders/route.ts sizes the position against the realised stop distance.
      strategy:            { ...liveStrategy, slPips: clampedSl, tpPips: clampedTp },
      aiConfidence:        signal.confidence,
      checklistScore:      (signal.reasons || []).length,
      currentPrice:        signal.entry,
      userId:              WORKER_USER_ID || undefined,
      maxConcurrentTrades: liveStrategy.maxPositions,
      // Audit attribution — see 20260606_trades_source_tracking migration.
      source,
      source_sl_pips:      sourceSlPips,
      source_tp_pips:      sourceTpPips,
      signal_at:           nowIso,
      signal_confidence:   signal.confidence,
      signal_id_ref:       signalRef,
    }),
  })
}

// ── Signal Processor ──────────────────────────────────────────────────────────

async function processSignal(pair, tick, strategy, session, direction) {
  lastSigFetch.set(pair, Date.now())
  stats.sigChecks++

  // HTF alignment: check 15m trend before spending an AI call.
  // Scalp skips this — the regime classifier handles ranging conditions where
  // 15m is inherently ambiguous, and the regime-aware effectiveMinStrength gate
  // downstream provides the actual filter. Browser path doesn't apply HTF either.
  if (direction && strategy !== 'Scalp') {
    const aligned = await isHTFAligned(pair, direction)
    if (!aligned) {
      console.log(`[htf] ${pair} — 15m disagrees with 5m ${direction} setup — skipping AI call`)
      wlog('info', `HTF skip: ${pair} ${direction} — 15m trend does not confirm 5m setup`, {
        pair, session, metadata: { direction, reason: 'htf_misaligned' },
      })
      return
    }
  }

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

  // ── Session direction gate (precious metals) ──────────────────────────────
  // Block signals that go against the statistically dominant session direction.
  // Evidence: XAU/USD BUY has 0% win rate in Asian/London/NY sessions; SELL has
  // 0% win rate during NY+LON overlap. Counter-session signals are systematically
  // wrong — suppressing them avoids placing losing trades and polluting ML data.
  //
  // Mirror sections flip the signal direction, so we now check inside the section
  // loop (further down) against each section's effective direction. Here we only
  // pre-compute the bias so it's available there. Skipping the whole signal at
  // this layer would suppress mirror trades that ARE bias-aligned (e.g. signal
  // BUY in SELL-only session → scalp blocked, but mirror flips to SELL = allowed).
  const sessionBias = getMetalSessionBias(pair)

  console.log(
    `[${pair}] ${strategy}/${session} → ${dir} ${conf}%` +
    (tick.simulated ? ' (sim)' : ` (${tick.broker})`)
  )

  // Log every signal check to Supabase (ML data + UI visibility)
  wlog('signal',
    `${dir} ${conf}% — ${strategy}${signal.marketRegime ? ` [${signal.marketRegime}]` : ''}`,
    { pair, session, metadata: {
      direction: dir, confidence: conf, strategy, session, simulated: tick.simulated,
      entry: signal.entry, sl: signal.sl, tp: signal.tp, reasons: signal.reasons,
      marketRegime:         signal.marketRegime         ?? null,
      effectiveMinStrength: signal.effectiveMinStrength ?? null,
      suggestedSection:     signal.suggestedSection     ?? null,
      adx:                  signal.adx                  ?? tick.adx ?? null,
      agreementScore:       signal.agreementScore       ?? null,
      agreementVotes:       signal.agreementVotes       ?? null,
      htfBias15m:           signal.htfBias15m           ?? null,
      htfBias1h:            signal.htfBias1h            ?? null,
      htfAction:            signal.htfAction            ?? null,
      thresholdSource:      signal.thresholdSource      ?? null,
    } }
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
      indicator_snapshot: {
        ...tick,
        _regime: {
          marketRegime:         signal.marketRegime         ?? null,
          effectiveMinStrength: signal.effectiveMinStrength ?? null,
          suggestedSection:     signal.suggestedSection     ?? null,
          adx:                  signal.adx                  ?? tick.adx ?? null,
        },
        // Engine/gate audit trail from /api/scalper/signal — spot-check
        // mechanism for verifying predictions against a chart.
        _audit: signal._audit ?? null,
      },
    }).then(row => {
      if (row?.id) trackSignal(row.id, pair, dir, entry, sl, tp)
    }).catch(() => {})

  }

  // ── Signal Reconciliation capture ───────────────────────────────────────
  // Snapshot the scalp signal (and its mirror inverse) into
  // signal_reconciliation. Each gets its own row — they are separate
  // predictions graded against the same outcome. The timeframe is 5m
  // (the worker's canonical scalp timeframe). Fire-and-forget — failures
  // here must never block signal processing.
  //
  // Captured for EVERY signal — including HOLD — so the accuracy metric
  // reflects the full prediction distribution, not just the signals the
  // model was confident enough to act on. HOLD has no mirror inverse (it
  // doesn't pick a side), so only the scalp row is written for HOLD.
  //
  // The mirror signal in this system IS the inverted scalp direction
  // (see direction-check/route.ts: "Mirror = same 5 results with direction
  // inverted"), so the mirror row is the true mirror prediction, not a
  // synthetic stand-in.
  if (WORKER_USER_ID) {
    const mirrorDir = dir === 'BUY' ? 'SELL' : 'BUY'
    const signalId  = `worker-${pair.replace('/', '')}-${Date.now()}`
    captureSignalReconciliation({
      signalType: 'scalp',
      pair,
      direction:  dir,
      entryPrice: signal.entry || tick.price,
      timeframe:  '5m',
      signalId,
    }).catch(() => {})
    if (dir !== 'HOLD') {
      captureSignalReconciliation({
        signalType: 'mirror',
        pair,
        direction:  mirrorDir,
        entryPrice: signal.entry || tick.price,
        timeframe:  '5m',
        signalId,
      }).catch(() => {})
    }
  }



  // Dynamic minStrength with user-strategy hard floor. Regime-aware
  // effectiveMinStrength (ranging=65, weak-trend=68, trending=72, strong=100)
  // can RAISE the bar (strong-trend → 100 suppresses) but never LOWER it below
  // the user's configured minStrength — that field is the operator's floor.
  // Previously the regime could lower the gate (e.g. weak-trend=68 < user 72),
  // letting sub-threshold signals fire. Floor restored 2026-06-11 after live
  // mirror cancellation diagnosis.
  const regimeMin = typeof signal.effectiveMinStrength === 'number'
    ? signal.effectiveMinStrength
    : liveStrategy.minStrength
  const effMin   = Math.max(liveStrategy.minStrength, regimeMin)

  // Per-signal regime audit log — shows the gate decision for every signal so
  // the operator can see exactly why each one passed or skipped.
  const regimeLabel = signal.marketRegime ?? 'n/a'
  const adxLabel    = typeof signal.adx === 'number'
    ? signal.adx.toFixed(1)
    : (typeof tick.adx === 'number' ? tick.adx.toFixed(1) : 'n/a')
  console.log(`[signal] ${pair} ADX=${adxLabel} regime=${regimeLabel} ` +
      `conf=${conf} effMin=${effMin} → ${dir !== 'HOLD' && conf >= effMin ? 'PASS' : 'SKIP'}`)

  if (dir === 'HOLD') {
    // Bug-fix 2026-06-08: previously a silent return. Now logged for audit.
    await logAutoTradeDecision('skipped-hold', pair, dir, signal, { conf, effMin })
    return
  }
  if (conf < effMin) {
    // Bug-fix 2026-06-08: previously a silent return. Now logged for audit so
    // the operator can see why a signal didn't fire.
    await logAutoTradeDecision('skipped-confidence', pair, dir, signal, { conf, effMin })
    return
  }

  // ── Agreement-score gate (audit Phase 2, item 8) ────────────────────────────
  // The unified Signal Agreement Score (5M/15M/1H/ML/rule, 0-100) tells us how
  // many independent engines agree with the final direction. When at least
  // three components have an opinion and the agreement is low, the engines are
  // contradicting each other — executing is betting against the consensus.
  //   ≥3 votes and agreement < 40%  → skip (low agreement)
  //   <3 votes or null score         → pass (not enough data to judge)
  // The browser path displays the same score; this gate makes the worker use it.
  const agreementScore = typeof signal.agreementScore === 'number' ? signal.agreementScore : null
  const opinionated    = Array.isArray(signal.agreementVotes)
    ? signal.agreementVotes.filter(v => v && v.direction).length
    : 0
  const MIN_AGREEMENT_PCT  = 40
  const MIN_AGREEMENT_VOTES = 3
  if (agreementScore !== null && opinionated >= MIN_AGREEMENT_VOTES && agreementScore < MIN_AGREEMENT_PCT) {
    console.warn(`[agreement] ${pair} ${dir} ${conf}% — agreement ${agreementScore}% (${opinionated} engines) below ${MIN_AGREEMENT_PCT}% — skipping` +
      `\n  votes: ${JSON.stringify(signal.agreementVotes || [])}`)
    await logAutoTradeDecision('skipped-low-agreement', pair, dir, signal, {
      agreementScore, opinionated, votes: signal.agreementVotes || [],
    })
    return
  }

  // Hard block: never act on simulated data in live mode
  if (tick.simulated) {
    if (WORKER_MODE === 'live') {
      console.warn(`[risk] LIVE ORDER BLOCKED — simulated market data detected for ${pair}. MT5 EA may be disconnected or all live feeds unavailable.`)
      wlog('error', `Simulated data in LIVE mode — order blocked`, { pair, session, metadata: { reason: 'simulated_data', broker: tick.broker } })
      await logAutoTradeDecision('skipped-simulated-data', pair, dir, signal, { broker: tick.broker })
    }
    return
  }

  // ML-veto visibility (audit 2026-07-02). The XGBoost win-probability gate in
  // /api/scalper/signal only runs when the ML service answered — signal.ml is
  // null when it was down or timed out, meaning this signal was NEVER vetted by
  // the second engine. Alert-only for now (frequency data will decide whether
  // to block); the trade itself proceeds unchanged.
  if (
    signal.ml == null &&
    WORKER_MODE === 'live' &&
    liveStrategy.autoTradeEnabled &&
    liveStrategy.autoTradePairs.includes(pair)
  ) {
    console.warn(`[ml] ${pair} ${dir} ${conf}% passed gates WITHOUT ML veto — ML service unreachable at signal time`)
    wlog('warn', `ML veto missing: ${pair} ${dir} ${conf}% — signal not vetted by XGBoost (service unreachable)`, {
      pair, session, metadata: { direction: dir, confidence: conf, reason: 'ml_veto_missing' },
    })
    const lastMlAlert = mlMissingAlerts.get(pair) || 0
    if (Date.now() - lastMlAlert > ALERT_COOL_MS) {
      mlMissingAlerts.set(pair, Date.now())
      tgSend(`⚠️ <b>ML veto missing</b>\n\n${pair} ${dir} ${conf}% passed all gates but was <b>not vetted by the XGBoost engine</b> (ML service unreachable at signal time).\nTrade handling is unchanged — alert only.\n⏱ ${new Date().toUTCString()}`)
    }
  }

  // Telegram-alert cooldown — Bug-fix 2026-06-08: this used to `return` from the
  // function, silently blocking auto-trade execution for 15 min after every
  // alert on the same pair+direction. That was a major hidden gate. The fix:
  // the cooldown now ONLY suppresses the Telegram alert + alert-level log; the
  // auto-trade execution block below runs regardless. The per-pair execution
  // cooldown (PAIR_COOLDOWN_MS = 5 min via lastPairPlacedRef) is the actual
  // anti-overtrading guard.
  const coolKey = `${pair}:${dir}`
  const lastAt  = alertCooldowns.get(coolKey) || 0
  const alertCooldownActive = Date.now() - lastAt < ALERT_COOL_MS
  if (!alertCooldownActive) {
    alertCooldowns.set(coolKey, Date.now())
    stats.alerts++
    wlog('alert', `${dir} ${pair} — confidence ${conf}%${signal.marketRegime ? ` [${signal.marketRegime}]` : ''}`, {
      pair, session, metadata: {
        direction: dir, confidence: conf, strategy, session,
        marketRegime:         signal.marketRegime         ?? null,
        effectiveMinStrength: signal.effectiveMinStrength ?? null,
        suggestedSection:     signal.suggestedSection     ?? null,
        adx:                  signal.adx                  ?? tick.adx ?? null,
      },
    })
  } else {
    const minLeft = Math.ceil((ALERT_COOL_MS - (Date.now() - lastAt)) / 60_000)
    console.log(`[alert-cooldown] ${coolKey} — ${minLeft}m left; suppressing Telegram alert (execution continues)`)
  }

  // ── Server-side auto-trade execution (Fix 6 — 24/7 mirror engine) ──────────
  // Triple-locked: WORKER_MODE=live AND auto_trade_enabled=true (per-user DB
  // flag, defaults FALSE) AND signal passes every gate. Browser path still
  // exists in parallel; this just makes the worker an independent autonomous
  // executor so closing the browser doesn't stop trading.
  let placed = false
  // Captures the most recent successful placement so the Telegram alert below
  // can show actual lots + sizing source (manual vs auto). Stays null on
  // paper/blocked/halt paths.
  let lastPlacement = null

  // Direction-confirmation deadman-switch — auto-trade only runs when the
  // operator has clicked TEST/CHECK MARKET DIRECTION in the last 5 minutes
  // (= the 5m candle window the confirmation is bound to) AND the confirmed
  // direction matches the current signal direction. Per operator brief:
  // "Auto Trade may only execute when Signal Status = ACTIVE". Fetched only
  // when the cheap upstream gates would otherwise have passed, so we don't
  // waste DB round-trips during disabled / paper-mode / pair-filtered states.
  let directionConfirmation = null
  if (
    WORKER_MODE === 'live' &&
    liveStrategy.autoTradeEnabled &&
    liveStrategy.autoTradePairs.includes(pair)
  ) {
    directionConfirmation = await fetchLatestDirectionConfirmation(pair)
  }

  // The confirmation row stores the WINNING group's direction — already
  // inverted when recommended='mirror' (direction-check API persists the
  // majority of the INVERTED results in that case). Translate back to
  // scalp-signal space before comparing against the worker's signal `dir`,
  // otherwise a mirror-recommended confirmation can never match and the gate
  // silently blocks every trade it was meant to allow.
  const invertDir = (d) => (d === 'BUY' ? 'SELL' : d === 'SELL' ? 'BUY' : 'HOLD')
  const confirmationExpectedDir = directionConfirmation
    ? (directionConfirmation.recommended === 'mirror'
        ? invertDir(directionConfirmation.direction)
        : directionConfirmation.direction)
    : null

  if (WORKER_MODE !== 'live') {
    logAutoTradeDecision('skipped-paper-mode', pair, dir, signal)
  } else if (!liveStrategy.autoTradeEnabled) {
    logAutoTradeDecision('skipped-disabled', pair, dir, signal)
  } else if (!liveStrategy.autoTradePairs.includes(pair)) {
    logAutoTradeDecision('skipped-pair-filter', pair, dir, signal, { allowedPairs: liveStrategy.autoTradePairs })
  } else if (!directionConfirmation) {
    // No unexpired confirmation row for this pair — operator hasn't clicked
    // TEST/CHECK MARKET DIRECTION in the last 5 min (or WORKER_USER_ID is
    // unset, or the DB query failed transiently — all surface here).
    logAutoTradeDecision('skipped-no-confirmation', pair, dir, signal, {
      hint: WORKER_USER_ID
        ? 'No active 5m direction confirmation. Click TEST/CHECK MARKET DIRECTION to enable auto-trade for the next 5 min.'
        : 'WORKER_USER_ID not configured — worker cannot associate confirmations',
    })
  } else if (confirmationExpectedDir !== dir) {
    // Confirmation exists but disagrees with the worker's current signal —
    // operator confirmed BUY, worker is now seeing SELL (or vice versa).
    // Also covers HOLD confirmations (HOLD never matches BUY/SELL).
    // Conservative: skip and wait for the operator to re-confirm.
    logAutoTradeDecision('skipped-confirmation-direction-mismatch', pair, dir, signal, {
      confirmedDirection: directionConfirmation.direction,
      recommended:        directionConfirmation.recommended,
      expectedDir:        confirmationExpectedDir,
      confirmedAt:        directionConfirmation.analyzed_at,
      confirmedExpires:   directionConfirmation.expires_at,
    })
  } else if (tradingHalted) {
    logAutoTradeDecision('skipped-daily-loss-halted', pair, dir, signal)
  } else if (!isLondonNYOverlap()) {
    // Single allowlist: only 12:00-13:59 UTC Mon-Fri. Replaces daily-close +
    // sunday-pre-open + per-section session-bias gates.
    const now = new Date()
    logAutoTradeDecision('skipped-outside-overlap', pair, dir, signal, {
      utcHour: now.getUTCHours(),
      utcDay:  now.getUTCDay(),
      nextWindow: nextOverlapInfo(now),
    })
  } else {
    {
      // Per-pair cooldown — matches the browser's 5-min PAIR_COOLDOWN_MS so
      // browser + worker never double-trade a pair within the same window.
      const lastPlaced = lastPairPlacedRef.get(pair) || 0
      if (Date.now() - lastPlaced < PAIR_COOLDOWN_MS) {
        const remainingS = Math.round((PAIR_COOLDOWN_MS - (Date.now() - lastPlaced)) / 1000)
        logAutoTradeDecision('skipped-cooldown', pair, dir, signal, { remainingS })
      } else {
        let risk
        try { risk = await fetchRiskState() } catch { /* skip on error */ }

        // Circuit breaker (Fix 3 — large-loss cooldown). Set by mt5-sync after
        // any close with loss >1R. Pauses auto-trade for 15 min so a gap-through
        // doesn't compound into back-to-back losses.
        if (risk && risk.circuitBreakerUntil) {
          const cbUntilMs = new Date(risk.circuitBreakerUntil).getTime()
          if (Date.now() < cbUntilMs) {
            const remainingS = Math.round((cbUntilMs - Date.now()) / 1000)
            logAutoTradeDecision('skipped-circuit-breaker', pair, dir, signal, { remainingS, until: risk.circuitBreakerUntil })
            await tgSend(formatAlert(pair, strategy, session, signal, 'paper'))
            return
          }
        }

        if (risk) {
          // Daily loss halt is balance-relative. liveStrategy.maxLoss (% as a
          // number, e.g. 3 = 3%) × live balance. Scales automatically with account size.
          const maxLossFrac = (liveStrategy.maxLoss || 3) / 100
          if (risk.dailyLossPct >= maxLossFrac) {
            tradingHalted = true
            if (!haltNotified) {
              haltNotified = true
              const lossUSD  = (risk.dailyLossPct * risk.balance).toFixed(2)
              const limitUSD = (maxLossFrac        * risk.balance).toFixed(2)
              await tgSend(`🛑 <b>Daily loss limit reached (${liveStrategy.maxLoss}%)</b> — trading halted for today.\nLoss: $${lossUSD} / Limit: $${limitUSD} of $${risk.balance.toFixed(2)} balance.\nWorker still scanning and alerting in paper mode.`)
            }
            logAutoTradeDecision('skipped-daily-loss-halted', pair, dir, signal)
          } else {
            // Iterate sections — place scalp first, then mirror. Each placement
            // re-checks maxPositions against an incrementing local counter so
            // both can fire only if there's room for both.
            let openLocal   = risk.openCount
            let placedAny   = false
            // lastPlacement declared at outer scope (above) so the formatAlert
            // call after the loop can read it; updated below on each successful
            // placement. Last writer wins if both sections fire.
            for (const section of liveStrategy.autoTradeSections) {
              if (section !== 'scalp' && section !== 'mirror') {
                logAutoTradeDecision('skipped-section-disabled', pair, dir, signal, { section })
                continue
              }
              // Only the confirmation's recommended section may fire —
              // otherwise a scalp-recommended BUY confirmation would also
              // place the contradicting mirror SELL in the same pass.
              if (section !== directionConfirmation.recommended) {
                logAutoTradeDecision('skipped-section-not-recommended', pair, dir, signal, {
                  section,
                  recommended: directionConfirmation.recommended,
                })
                continue
              }
              if (openLocal >= liveStrategy.maxPositions) {
                logAutoTradeDecision('skipped-maxpositions', pair, dir, signal, { section, openLocal, maxPositions: liveStrategy.maxPositions })
                continue
              }
              const sectionDir = section === 'mirror'
                ? (dir === 'BUY' ? 'SELL' : 'BUY')
                : dir
              // Per-section session-bias check REMOVED 2026-06-08 — the 12-16
              // UTC overlap allowlist is the single session gate now.
              if ((directionLosses[sectionDir] || 0) >= 3) {
                await logAutoTradeDecision('skipped-direction-streak', pair, sectionDir, signal, {
                  direction:         sectionDir,
                  consecutiveLosses: directionLosses[sectionDir],
                  section,
                })
                continue
              }
              try {
                const result = await placeOrder(pair, sectionDir, signal, section)
                if (result.success) {
                  placedAny = true
                  openLocal++
                  stats.trades++
                  lastPlacement = {
                    lots:   result.lots,
                    source: (typeof liveStrategy.manualLots === 'number' && liveStrategy.manualLots > 0) ? 'manual' : 'auto',
                    section,
                    slPips: result.stopLossPips ?? null,
                  }
                  console.log(`[order] ✓ [${ACCOUNT_TYPE.toUpperCase()}] ${section.toUpperCase()} ${pair} ${sectionDir} → trade ${result.tradeId} @ ${result.filledPrice} lots=${result.lots} (${lastPlacement.source})`)
                  await logAutoTradeDecision('executed', pair, sectionDir, signal, {
                    section,
                    tradeId:     result.tradeId,
                    filledPrice: result.filledPrice,
                    lots:        result.lots,
                    lotSource:   lastPlacement.source,
                  })
                } else {
                  console.log(`[order] blocked (${section}): ${(result.reasons || []).join(', ')}`)
                  await logAutoTradeDecision('skipped-server-blocked', pair, sectionDir, signal, { section, reasons: result.reasons })
                }
              } catch (e) {
                console.error('[order]', e.message)
                await logAutoTradeDecision('skipped-error', pair, sectionDir, signal, { section, error: e.message })
              }
            }
            if (placedAny) {
              placed = true
              lastPairPlacedRef.set(pair, Date.now())
              // Invalidate the risk cache — openCount just changed; serving the
              // stale value lets the next signal slip past maxPositions.
              cachedRisk = null
            }
          }
        }
      }
    }
  }

  // Telegram alert — pass lastPlacement so live alerts include lots + source.
  // Null on paper/blocked/halt paths; formatAlert ignores it for non-'live' mode.
  await tgSend(formatAlert(pair, strategy, session, signal, placed ? 'live' : 'paper', lastPlacement))

  // Signal already saved to DB earlier (before the confidence gate) for ML training
}

// ── Sweep ─────────────────────────────────────────────────────────────────────

async function runSweep() {
  stats.sweeps++

  // Check for admin-triggered cache reset (throttled to every 30s)
  await checkForCacheReset().catch(() => {})

  // Snapshot the sweep instant once and pass it to every time-dependent helper.
  // Calling new Date() inside each (isMarketOpen, getSession, log timestamp) used
  // to let the same sweep straddle an hour boundary — most visibly at exactly
  // 21:00:00 UTC where the daily close window starts.
  const sweepAt    = new Date()
  const marketOpen = isMarketOpen(sweepAt)
  const session    = marketOpen ? getSession(sweepAt) : 'CLOSED'

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

  const now = sweepAt.toISOString().slice(11, 19)
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

  // Signal Reconciliation — resolve any scalp/mirror signals that are due
  // (generated_at + timeframe elapsed). Observability layer only — never
  // gates or alters auto-trade execution.
  await resolvePendingReconciliations().catch(e =>
    console.error('[recon] sweep resolve failed:', e.message)
  )

  // Phase 2a: fast sync pre-filter — no I/O, builds candidate list

  const candidates = []
  for (const r of tickResults) {
    if (r.status !== 'fulfilled') { stats.errors++; continue }
    const { pair, tick } = r.value
    const strategy       = getStrategy(pair, session)
    if (Date.now() - (lastSigFetch.get(pair) || 0) < SIG_COOLDOWN_MS) continue

    // Stale data guard: skip if MT5 EA is sending identical prices repeatedly
    const stale = stalePriceTrack.get(pair)
    if (stale && stale.price === tick.price) {
      const newCount = stale.count + 1
      stalePriceTrack.set(pair, { price: tick.price, count: newCount })
      if (newCount >= STALE_SKIP_COUNT) {
        // Alert on first detection, then every 30 sweeps (~5 min) while still frozen
        const isFirstAlert  = newCount === STALE_SKIP_COUNT
        const isRepeatAlert = newCount > STALE_SKIP_COUNT && (newCount - STALE_SKIP_COUNT) % 30 === 0
        if (isFirstAlert || isRepeatAlert) {
          const mins = Math.round(newCount * POLL_MS / 60_000)
          console.warn(`[stale] ${pair} price ${tick.price} unchanged for ${newCount} sweeps (~${mins} min) — MT5 EA frozen?`)
          wlog('warn', `Stale price detected: ${pair} = ${tick.price} for ${newCount}+ sweeps — MT5 EA may be frozen`, { pair, session, metadata: { price: tick.price, staleCount: newCount } })
          tgSend(`⚠️ <b>Stale Price Alert</b>\n\n${pair} = ${tick.price}\nUnchanged for ${newCount} sweeps (~${mins} min)\n\n🔌 MT5 EA may be frozen. Check MetaTrader connection.\n⏱ ${new Date().toUTCString()}`)
        }
        continue
      }
    } else {
      // Price is moving again — if we were previously stale, send a recovery notice
      const prev = stalePriceTrack.get(pair)
      if (prev && prev.count >= STALE_SKIP_COUNT) {
        console.log(`[stale] ${pair} price resumed after ${prev.count} stale sweeps`)
        wlog('info', `Stale price cleared: ${pair} price resumed movement after ${prev.count} sweeps`, { pair, session, metadata: { price: tick.price, prevStaleCount: prev.count } })
        tgSend(`✅ <b>Price Feed Resumed</b>\n\n${pair} is now updating again.\nWas frozen for ${prev.count} sweeps (~${Math.round(prev.count * POLL_MS / 60_000)} min).\n⏱ ${new Date().toUTCString()}`)
      }
      stalePriceTrack.set(pair, { price: tick.price, count: 1 })
    }

    if (!hasSignalCondition(tick, strategy)) continue
    candidates.push({ pair, tick, strategy })
  }

  // Phase 2b: Fix 3 — top-down HTF filter (15m is the authority, 5m must confirm)
  // Fetch HTF for all candidates concurrently; cache means this is near-zero cost on repeat sweeps.
  const queue = []
  if (candidates.length) {
    const htfFetches = await Promise.allSettled(
      candidates.map(c =>
        fetchHTFTick(c.pair)
          .then(h => ({ pair: c.pair, htf: h }))
          .catch(() => ({ pair: c.pair, htf: null }))
      )
    )
    const htfByPair = {}
    for (const r of htfFetches) {
      if (r.status === 'fulfilled') htfByPair[r.value.pair] = r.value.htf
    }

    for (const cand of candidates) {
      const htfTick = htfByPair[cand.pair]
      const htfDir  = inferHTFDirection(htfTick)  // 15m primary direction
      const dir5m   = inferDirection(cand.tick)   // 5m confirming direction

      // Scalp: skip HTF macro-bias check HERE. The 15M/1H bias filter now runs
      // server-side in /api/scalper/signal (audit Phase 2, item 6), so both the
      // worker AND the browser path get identical multi-timeframe filtering.
      // Ranging regimes produce ambiguous 15m trends by definition; the signal
      // route only penalises a CLEAR opposing HTF bias, so ranging setups still
      // pass. Avoids double HTF fetches.
      if (cand.strategy === 'Scalp') {
        queue.push({ ...cand, direction: dir5m || htfDir || null })
        continue
      }

      if (!htfDir) {
        // 15m trend is ambiguous — no fallback to 5m; no macro bias = no trade
        console.log(`[prefilter] ${cand.pair} skip — 15m trend ambiguous (EMA/MACD/RSI not aligned)`)
        continue
      }

      if (dir5m !== htfDir) {
        // 5m setup contradicts the confirmed 15m trend — trading against the macro bias
        console.log(`[prefilter] ${cand.pair} skip — 5m ${dir5m} contradicts 15m ${htfDir}`)
        wlog('info', `HTF prefilter skip: ${cand.pair} 5m=${dir5m} vs 15m=${htfDir}`, {
          pair: cand.pair, session, metadata: { dir5m, htfDir, reason: 'htf_prefilter' },
        })
        continue
      }

      queue.push({ ...cand, direction: htfDir })
    }
  }

  if (queue.length)
    console.log(`[pre-filter] ${queue.length}/${PAIRS.length} pairs qualify for signal check`)

  // Phase 3: process signals in batches (limit concurrent Claude calls)
  for (let i = 0; i < queue.length; i += MAX_SIG_BATCH) {
    const batch = queue.slice(i, i + MAX_SIG_BATCH)
    await Promise.allSettled(
      batch.map(({ pair, tick, strategy, direction }) => processSignal(pair, tick, strategy, session, direction))
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
    `Window   : ${isLondonNYOverlap() ? '🟢 LONDON-NY OVERLAP (active)' : '⚪ closed — next: ' + nextOverlapInfo()}`,
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

// London-NY overlap boundary alerts — fires at exactly 12:00 and 14:00 UTC on
// weekdays. Self-reschedules on each fire so it runs indefinitely. Wrapped in
// try/catch so a tgSend failure doesn't kill the loop.
let _overlapStartStats = null  // snapshot at open: { trades, alerts, balance, t }
async function fireOverlapAlert(kind) {
  try {
    const now = new Date()
    if (kind === 'open') {
      _overlapStartStats = { trades: stats.trades, alerts: stats.alerts, t: Date.now() }
      let extra = ''
      try {
        const acct = await apiFetch('/api/account').catch(() => null)
        if (acct?.balance) extra = `\nBalance: $${Number(acct.balance).toFixed(2)}`
      } catch {}
      await tgSend(
        `🟢 <b>LONDON-NY OVERLAP OPEN</b>\n` +
        `Auto-trading active for next 2 hours (12:00-13:59 UTC)${extra}\n` +
        `⏱ ${now.toUTCString().slice(17, 25)} UTC`
      )
      wlog('info', 'London-NY overlap window opened', { metadata: { kind, ts: now.toISOString() } })
    } else {
      const placed = _overlapStartStats ? stats.trades - _overlapStartStats.trades : stats.trades
      const alerted = _overlapStartStats ? stats.alerts - _overlapStartStats.alerts : stats.alerts
      await tgSend(
        `🔴 <b>LONDON-NY OVERLAP CLOSED</b>\n` +
        `Auto-trading paused until ${nextOverlapInfo(now)}\n` +
        `Trades placed: ${placed} · Alerts: ${alerted}\n` +
        `⏱ ${now.toUTCString().slice(17, 25)} UTC`
      )
      wlog('info', 'London-NY overlap window closed', { metadata: { kind, ts: now.toISOString(), placed, alerted } })
      _overlapStartStats = null
    }
  } catch (e) {
    console.error('[overlap-alert]', e?.message)
  }
}
function scheduleOverlapBoundaryAlerts() {
  function nextBoundaryMs() {
    const now = new Date()
    const day = now.getUTCDay()
    // candidate times: today 12:00, today 14:00, tomorrow 12:00, monday 12:00
    const candidates = []
    const todayBase = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
    if (day >= 1 && day <= 5) {
      candidates.push({ t: todayBase + 12*3600_000, kind: 'open'  })
      candidates.push({ t: todayBase + 14*3600_000, kind: 'close' })
    }
    // next weekday's 12:00 (skip Sat/Sun)
    let addDays = 1
    while (true) {
      const cand = new Date(todayBase + addDays * 86400_000)
      const candDay = cand.getUTCDay()
      if (candDay >= 1 && candDay <= 5) {
        candidates.push({ t: cand.getTime() + 12*3600_000, kind: 'open' })
        break
      }
      addDays++
      if (addDays > 8) break
    }
    const future = candidates.filter(c => c.t > now.getTime()).sort((a,b) => a.t - b.t)
    return future[0] || null
  }
  function arm() {
    const next = nextBoundaryMs()
    if (!next) { setTimeout(arm, 60_000); return }
    const delay = Math.max(0, next.t - Date.now())
    console.log(`[overlap] next ${next.kind} boundary in ${(delay/60_000).toFixed(1)} min (${new Date(next.t).toUTCString()})`)
    setTimeout(async () => {
      await fireOverlapAlert(next.kind)
      arm()
    }, delay)
  }
  arm()
}

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
    process.exit(1)  // non-zero exit triggers DO App Platform auto-restart
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
  console.log(`[worker] Account: ${ACCOUNT_TYPE.toUpperCase()}${ACCOUNT_TYPE === 'live' ? '  ⚠ LIVE — orders affect real money' : ''}`)
  console.log(`[worker] Target : ${BASE_URL}`)
  console.log(`[worker] Pairs  : ${PAIRS.join(' | ')}`)
  console.log(`[worker] Auth   : ${WORKER_SERVICE_JWT ? `JWT (${WORKER_SERVICE_JWT.length} chars) — per-user broker_configs` : 'NONE — env-default broker (multi-account disabled)'}`)
  if (WORKER_MODE === 'live' && !WORKER_SERVICE_JWT) {
    console.warn('[worker] ⚠ WORKER_SERVICE_JWT not set — live orders will use env-default broker, not the per-user MT5/OANDA account. Set WORKER_SERVICE_JWT to enable per-user routing.')
  }
  // Preflight: hit /api/account once so the operator sees immediately whether the
  // JWT resolves to the expected broker_configs row. If the JWT is missing/invalid
  // this surfaces at startup instead of failing silently on the first live order.
  try {
    const acct = await apiFetch('/api/account')
    console.log(`[worker] Broker : ${acct.broker || 'unknown'} · balance=${acct.balance ?? 'n/a'} ${acct.currency || ''} · openTrades=${(acct.openTrades || []).length}`)
    wlog('info', `Broker resolved at startup: ${acct.broker || 'unknown'}`, { metadata: { broker: acct.broker, balance: acct.balance, currency: acct.currency, hasJwt: !!WORKER_SERVICE_JWT } })
    if (WORKER_MODE === 'live' && /simulation/i.test(acct.broker || '')) {
      console.warn('[worker] ⚠ Broker resolved to Simulation in live mode — orders will be blocked. Check WORKER_SERVICE_JWT and the active broker_configs row.')
    }
  } catch (e) {
    console.warn(`[worker] Preflight /api/account failed: ${e.message} — worker will continue but per-user broker routing may not be active`)
  }
  // Initial strategy pull before the first sweep so the very first signal honours user settings
  await loadStrategy()
  setInterval(loadStrategy, STRATEGY_REFRESH_MS)
  console.log(`[worker] Poll   : ${POLL_MS / 1000}s | Alert threshold: ≥${liveStrategy.minStrength}%`)
  console.log(`[worker] Window : London-NY Overlap 12:00-13:59 UTC weekdays only`)
  console.log(`[worker] Status : ${isLondonNYOverlap() ? '🟢 OVERLAP ACTIVE' : '⚪ closed — next: ' + nextOverlapInfo()}`)
  // Profit-target safety check — surface a warning if profitFixedUsd is 0 or
  // null so the operator notices before trades start firing without a TP.
  try {
    const acct0 = await apiFetch('/api/account').catch(() => null)
    const ptUsd = Number(acct0?.profitFixedUsd ?? 0)
    if (!isFinite(ptUsd) || ptUsd <= 0) {
      console.warn(`[worker] WARNING — profit-target disabled (profitFixedUsd=${acct0?.profitFixedUsd ?? 'null'}). Trades will rely on SL/TP/trail/decay only.`)
      wlog('warn', 'Profit target disabled at worker startup', { metadata: { profitFixedUsd: acct0?.profitFixedUsd ?? null } })
      await tgSend(
        `⚠️ <b>PROFIT TARGET DISABLED</b>\n\n` +
        `Worker started but <code>profitFixedUsd</code> is 0 / null.\n` +
        `Trades will rely on SL / TP / trailing stop / decay exit only.\n\n` +
        `Set <b>Fixed USD Target</b> on the AutoTrade page to enable.`
      ).catch(() => {})
    } else {
      console.log(`[worker] Profit target: $${ptUsd.toFixed(2)} × ${acct0?.profitTargetPct ?? '?'}% = $${(ptUsd * (acct0?.profitTargetPct ?? 0) / 100).toFixed(2)} per-trade close`)
    }
  } catch (e) {
    console.warn(`[worker] profit-target safety check failed (continuing): ${e?.message}`)
  }

  scheduleMidnightRestart()
  setInterval(sendHeartbeat, HEARTBEAT_MS)
  // Seed direction-loss counters from history, then poll for newly-closed
  // trades and apply per-trade increment/reset (telegram alert on first time
  // a direction crosses 3 consecutive losses).
  await seedDirectionLosses().catch(e => console.warn('[dir-loss] seed failed:', e.message))
  setInterval(() => { reconcileClosedTrades().catch(() => {}) }, DIRECTION_RECONCILE_MS)
  // Direction-bias detector schedule REMOVED 2026-06-08. The function itself
  // early-returns now (see evaluateSectionBias). Operator policy: mirror is
  // the permanent default; direction is never auto-switched.
  // London-NY overlap open/close Telegram notifications — fires once at the
  // exact boundary (12:00 and 14:00 UTC weekdays).
  scheduleOverlapBoundaryAlerts()

  const startMsg = [
    `🚀 <b>SybexForexAI Worker Started</b>`,
    `Mode     : ${WORKER_MODE.toUpperCase()}`,
    `Interval : 10 seconds`,
    `Pairs    : ${PAIRS.join(', ')}`,
    `Window   : London-NY Overlap 12:00-13:59 UTC weekdays`,
    `Status   : ${isLondonNYOverlap() ? '🟢 ACTIVE' : '⚪ closed — next: ' + nextOverlapInfo()}`,
    `Threshold: confidence ≥ ${liveStrategy.minStrength}%`,
    `⏱ ${new Date().toUTCString()}`,
  ].join('\n')
  await tgSend(startMsg)
  wlog('info', `Worker started — mode: ${WORKER_MODE.toUpperCase()}`, { metadata: { mode: WORKER_MODE, pairs: PAIRS, threshold: liveStrategy.minStrength } })

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
