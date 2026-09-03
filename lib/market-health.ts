// lib/market-health.ts
// ─────────────────────────────────────────────────────────────────────────────
// Market-data health + broker-clock watchdog (audit fix 2026-09-03).
//
// The original production failure was silent: the MT5 EA stamps candle times in
// broker/server time (UTC+3) while candle-closed checks ran against the UTC
// server clock, so every signal was quietly blocked. This module makes the
// clock relationship explicit and ACTIVE:
//
//   • inferBrokerOffsetMs() — self-calibrates the fixed broker→UTC offset from
//     the candle array (whole-minute candidates ±14 h; prefers whole/half-hour
//     real-timezone offsets, a live forming-candle shape, and the most recently
//     consistent close). Cached 10 min per key.
//   • evaluateMarketHealth() — combines offset sanity, last-candle freshness
//     and "close is not impossibly far in the future" into an explicit
//     HEALTHY / STALE_FEED / TIME_ERROR verdict. When not HEALTHY the signal
//     pipeline MUST NOT generate (dataSuspended = true).
//
// Thresholds are env-overridable (MARKET_HEALTH_*). No credentials involved.
// ─────────────────────────────────────────────────────────────────────────────

export type MarketHealthStatus = 'HEALTHY' | 'STALE_FEED' | 'TIME_ERROR'

export interface MarketHealth {
  status: MarketHealthStatus
  healthy: boolean          // true ⇔ status === HEALTHY
  dataSuspended: boolean    // when true, signal generation must be suspended
  reason: string
  brokerOffsetSec: number
  lastCandleAgeSec: number  // seconds since the newest candle's CLOSE (UTC-corrected)
  lastCandleTime: string | null
  candleClosed: boolean
  staleAfterSec: number
  feedLatencyMs?: number
}

const _offsetCache = new Map<string, { at: number; off: number }>()

/** Clear calibration caches (admin cache resets). */
export function clearMarketHealthCache(): void {
  _offsetCache.clear()
}

export const MARKET_HEALTH_STALE_AFTER_SEC =
  () => parseInt(process.env.MARKET_HEALTH_STALE_AFTER_SEC || '1200', 10)  // 20 min default
const FUTURE_TOLERANCE_MS = 30 * 60_000   // close further in the future than this ⇒ clock error

export function inferBrokerOffsetMs(candles: any[], spanMs: number, now: number, cacheKey: string): number {
  if (!Array.isArray(candles) || candles.length < 2 || !(spanMs > 0)) return 0
  const times: number[] = []
  for (const c of candles) {
    const t = new Date(c?.time).getTime()
    if (Number.isFinite(t)) times.push(t)
  }
  if (times.length < 2) return 0
  const cached = _offsetCache.get(cacheKey)
  if (cached && now - cached.at < 10 * 60_000) return cached.off

  const lastOpen = times[times.length - 1]
  const maxOff = 14 * 3600_000
  let best = 0
  let bestScore = Number.MAX_SAFE_INTEGER
  for (let o = -maxOff; o <= maxOff; o += 60_000) {
    let closed = 0
    for (let i = 0; i < times.length; i++) {
      // UTC open = broker time − offset; candle closed when open + span ≤ now
      if (times[i] - o + spanMs <= now) closed++
    }
    // Live EA feeds include the in-progress candle (len−1 closed). Some feeds
    // only hold closed candles (all len closed). Both are valid.
    if (closed !== times.length - 1 && closed !== times.length) continue
    const formTier = closed === times.length - 1 ? 0 : 1
    const mod = ((o % 3600_000) + 3600_000) % 3600_000
    const hourTier = mod === 0 ? 0 : (mod === 1800_000 ? 1 : 2)
    const recency = Math.abs(now - (lastOpen - o + spanMs))
    // Timezone realism first (whole/half-hour), then live forming-candle shape,
    // then the most recently consistent close.
    const score = hourTier * 1e18 + formTier * 1e15 + recency
    if (score < bestScore) { bestScore = score; best = o }
  }
  _offsetCache.set(cacheKey, { at: now, off: best })
  return best
}

// ── Latest-closed-candle selection (audit fix 2026-09-04) ─────────────────────
// The MT5 EA sends the in-progress bar as the newest entry. Signals must be
// built exclusively from the latest FULLY CLOSED candle — never the forming
// bar. This helper identifies that candle from the broker-frame timestamps and
// the calibrated broker→UTC offset (the same single source of truth used for
// candleClosed / market-health).
//
// Timestamps are returned in the broker frame (same convention as the rest of
// the app: lastCandleTime / candle_close_time) so dedup keys and persistence
// stay consistent with existing rows. Only the CLOSURE TEST uses the UTC
// correction.

export interface ClosedCandleSelection {
  none: boolean               // no closed candle in the feed (e.g. empty / all bars still forming)
  formingPresent: boolean     // the newest bar is still in progress (normal, not an error)
  closedCount: number         // number of fully closed candles available
  newestTime: string | null   // broker-frame time of the newest bar (forming or closed)
  closedOpenTime: string | null    // broker-frame OPEN time of the latest closed candle
  closedCloseTime: string | null   // broker-frame CLOSE time of the latest closed candle
  newestIsForming: boolean
}

export function selectLatestClosedCandle(
  candles: any[],
  spanMs: number,
  now: number,
  cacheKey: string,
): ClosedCandleSelection {
  if (!Array.isArray(candles) || candles.length === 0 || !(spanMs > 0)) {
    return { none: true, formingPresent: false, closedCount: 0, newestTime: null,
      closedOpenTime: null, closedCloseTime: null, newestIsForming: false }
  }
  // Work on (originalIndex → time), sorted ascending by time (robust to either
  // feed orientation). The newest bar is the last in ascending order.
  const entries: { idx: number; time: number }[] = []
  for (let i = 0; i < candles.length; i++) {
    const t = new Date(candles[i]?.time).getTime()
    if (Number.isFinite(t)) entries.push({ idx: i, time: t })
  }
  if (entries.length === 0) {
    return { none: true, formingPresent: false, closedCount: 0, newestTime: null,
      closedOpenTime: null, closedCloseTime: null, newestIsForming: false }
  }
  entries.sort((a, b) => a.time - b.time)

  const offset = inferBrokerOffsetMs(candles, spanMs, now, cacheKey)
  const isClosed = (t: number) => t - offset + spanMs <= now
  const newest = entries[entries.length - 1]
  const newestIsForming = !isClosed(newest.time)

  let closedIdx = -1
  for (let i = entries.length - 1; i >= 0; i--) {
    if (isClosed(entries[i].time)) { closedIdx = i; break }
  }
  const none = closedIdx === -1
  const closedCount = none ? 0 : closedIdx + 1
  const closed = none ? null : entries[closedIdx]

  const iso = (t: number | null) => (t === null ? null : new Date(t).toISOString())
  return {
    none,
    formingPresent: entries.length > 0 && newestIsForming,
    closedCount,
    newestTime: iso(newest.time),
    closedOpenTime: closed ? iso(closed.time) : null,
    closedCloseTime: closed ? iso(closed.time + spanMs) : null,
    newestIsForming,
  }
}



/** Produce an explicit health verdict from a candle array + wall clock. */
export function evaluateMarketHealth(
  candles: any[],
  spanMs: number,
  now: number,
  opts: { pair: string; timeframe: string; feedLatencyMs?: number },
): MarketHealth {
  const lastRaw = candles?.length ? candles[candles.length - 1]?.time : null
  const lastTime = lastRaw === null || lastRaw === undefined ? null : new Date(lastRaw)
  const lastOpenMs = lastTime && Number.isFinite(lastTime.getTime()) ? lastTime.getTime() : NaN
  const offsetMs = Number.isFinite(lastOpenMs)
    ? inferBrokerOffsetMs(candles, spanMs, now, `${opts.pair}:${opts.timeframe}`)
    : 0
  const brokerOffsetSec = Math.round(offsetMs / 1000)
  const lastCandleTime = lastTime ? lastTime.toISOString() : null
  const candleClosed = Number.isFinite(lastOpenMs)
    ? now >= lastOpenMs - offsetMs + spanMs
    : false
  const lastClose = Number.isFinite(lastOpenMs) ? lastOpenMs - offsetMs + spanMs : now
  const lastCandleAgeSec = Math.max(0, Math.round((now - lastClose) / 1000))
  const staleAfterSec = MARKET_HEALTH_STALE_AFTER_SEC()

  let status: MarketHealthStatus = 'HEALTHY'
  let reason = 'Market data healthy'
  if (!Number.isFinite(lastOpenMs)) {
    status = 'TIME_ERROR'
    reason = 'No candle timestamps available — cannot verify the broker clock'
  } else if (lastClose - now > FUTURE_TOLERANCE_MS) {
    status = 'TIME_ERROR'
    reason = `Broker candle time is ${Math.round((lastClose - now) / 60000)}m ahead of the system clock`
  } else if (lastCandleAgeSec > staleAfterSec) {
    status = 'STALE_FEED'
    reason = `Last closed candle is ${Math.round(lastCandleAgeSec / 60)}m old — market data feed stalled`
  } else if (lastCandleAgeSec > 60) {
    // 1 min..stale threshold: still generating (HEALTHY) but note the age.
    reason = `Market data healthy (last close ${Math.round(lastCandleAgeSec / 60)}m ago)`
  }

  return {
    status,
    healthy: status === 'HEALTHY',
    dataSuspended: status !== 'HEALTHY',
    reason,
    brokerOffsetSec,
    lastCandleAgeSec,
    lastCandleTime,
    candleClosed,
    staleAfterSec,
    ...(opts.feedLatencyMs !== undefined ? { feedLatencyMs: opts.feedLatencyMs } : {}),
  }
}
