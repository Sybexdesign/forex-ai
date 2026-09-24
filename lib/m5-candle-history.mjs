// lib/m5-candle-history.mjs
// ─────────────────────────────────────────────────────────────────────────────
// FORWARD-ONLY, IDEMPOTENT PERSISTENCE OF THE EXISTING MT5 M5 CANDLE FEED
//
// WHY THIS EXISTS
//   The only candle store the system has is
//   `broker_configs.config.candleCache`, which the EA overwrites on every sync
//   and which holds a ROLLING ~200 M5 bars (≈16.7 hours). Any v2 measurement
//   study wider than that window would silently lose its own evidence, and a
//   prediction older than ~16.7h could no longer be reconstructed at all.
//
// WHAT IT IS
//   A pure row-builder. It reads nothing and writes nothing; the caller
//   (app/api/mt5-sync/route.ts) performs the upsert. Keeping the shape logic
//   here makes it unit-testable without a database.
//
// IMMUTABILITY DESIGN (why the upsert is a genuine no-op)
//   Only bars that have already CLOSED are emitted:
//       barTimeMs + 300_000 <= nowMs
//   A closed M5 bar never changes again, so a re-seen bar produces a
//   byte-identical row. Combined with the (symbol, timeframe, bar_time) primary
//   key and `resolution=ignore-duplicates` on write, re-persisting the same
//   rolling cache rewrites NOTHING. That is what makes this safe to call on
//   every EA sync.
//
// NOT IN SCOPE
//   No M1 or tick collection, and no change to the EA feed. Those would need an
//   EA change and are deliberately excluded from this phase.
// ─────────────────────────────────────────────────────────────────────────────

import { M5_BAR_SECONDS } from './prediction-excursion.mjs'

/** Default timeframe key for the persisted history. */
export const CANDLE_HISTORY_TF = 'M5'

/** Table written by the ingestion point. */
export const CANDLE_HISTORY_TABLE = 'm5_candle_history'

/**
 * Parse a candleCache key such as `XAUUSD_M5` into its symbol and timeframe.
 * Returns null for keys that do not match, so an unexpected key is skipped
 * rather than stored under a guessed symbol.
 */
export function parseCandleCacheKey(key) {
  if (typeof key !== 'string') return null
  const m = /^([A-Z0-9.]+)_([A-Z0-9]+)$/.exec(key)
  if (!m) return null
  return { symbol: m[1], tf: m[2] }
}

/**
 * Build the rows to persist from one candleCache entry.
 *
 * @param {object}   p
 * @param {string}   p.symbol     e.g. 'XAUUSD'
 * @param {Array}    p.bars       EA compact bars: { t, o, h, l, c, v } (t = seconds)
 * @param {number}   p.nowMs      wall clock used to decide "closed"
 * @param {string}   [p.timeframe] defaults to M5
 * @returns {{ rows: object[], stats: object }}
 */
export function buildCandleHistoryRows({ symbol, bars, nowMs, timeframe = CANDLE_HISTORY_TF }) {
  const stats = { seen: 0, closed: 0, openSkipped: 0, invalid: 0, duplicates: 0 }
  if (typeof symbol !== 'string' || !symbol) return { rows: [], stats }
  if (!Array.isArray(bars)) return { rows: [], stats }

  const now = Number(nowMs)
  if (!Number.isFinite(now)) return { rows: [], stats }

  const byBarTime = new Map()
  for (const raw of bars) {
    stats.seen++
    if (!raw || typeof raw !== 'object') { stats.invalid++; continue }

    const rawT = Number(raw.t ?? raw.tMs)
    if (!Number.isFinite(rawT)) { stats.invalid++; continue }
    // EA bar times are epoch seconds (mt5direct.adapter: `new Date(c.t * 1000)`).
    const tMs = rawT > 1e12 ? rawT : rawT * 1000
    const barTime = Math.floor(tMs / 1000)

    const o = Number(raw.o ?? raw.open)
    const h = Number(raw.h ?? raw.high)
    const l = Number(raw.l ?? raw.low)
    const c = Number(raw.c ?? raw.close)
    const v = Number(raw.v ?? raw.volume ?? 0)
    if (![o, h, l, c].every(Number.isFinite)) { stats.invalid++; continue }
    if (!(h >= l) || !(h >= o && h >= c && l <= o && l <= c)) { stats.invalid++; continue }

    // Closed-only: an in-progress bar would be rewritten later, which would
    // break the immutability guarantee this whole module rests on.
    if (tMs + M5_BAR_SECONDS * 1000 > now) { stats.openSkipped++; continue }

    if (byBarTime.has(barTime)) stats.duplicates++
    byBarTime.set(barTime, {
      symbol,
      timeframe,
      bar_time: barTime,
      open_price: o,
      high_price: h,
      low_price: l,
      close_price: c,
      volume: Number.isFinite(v) ? v : 0,
    })
  }

  const rows = [...byBarTime.values()].sort((a, b) => a.bar_time - b.bar_time)
  stats.closed = rows.length
  return { rows, stats }
}

/**
 * Build rows for EVERY symbol/timeframe entry in a candleCache snapshot.
 * Only the requested timeframe is emitted; other timeframes are ignored so this
 * phase cannot accidentally start persisting M15/H1/H4.
 */
export function buildCandleHistoryRowsForCache(candleCache, nowMs, timeframe = CANDLE_HISTORY_TF) {
  const out = []
  const stats = { keys: 0, matched: 0, rows: 0, openSkipped: 0, invalid: 0, duplicates: 0 }
  if (!candleCache || typeof candleCache !== 'object') return { rows: out, stats }

  for (const [key, entry] of Object.entries(candleCache)) {
    stats.keys++
    const parsed = parseCandleCacheKey(key)
    if (!parsed || parsed.tf !== timeframe) continue
    if (!entry || !Array.isArray(entry.candles)) continue
    stats.matched++
    const { rows, stats: s } = buildCandleHistoryRows({
      symbol: parsed.symbol, bars: entry.candles, nowMs, timeframe,
    })
    out.push(...rows)
    stats.rows += rows.length
    stats.openSkipped += s.openSkipped
    stats.invalid += s.invalid
    stats.duplicates += s.duplicates
  }
  return { rows: out, stats }
}
