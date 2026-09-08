// lib/execution-guards.mjs
// ─────────────────────────────────────────────────────────────────────────────
// Shared pre-execution guards for the Auto Trade path (Production hardening).
//
//   • SIGNAL_MAX_AGE_SECONDS — ONE authoritative signal TTL. Default 150 s:
//     a closed-M5-candle entry is actionable only while that candle is fresh.
//     The same value is used by the worker's closed-candle freshness guard,
//     /api/orders stale-signal rejection, the /api/scalper/signal response
//     (signalTtlSeconds), and (via that response) the UI action deadline.
//     Env: SIGNAL_MAX_AGE_SECONDS
//   • SIGNAL_ENTRY_DRIFT_PCT — max tolerated price drift between the signal
//     reference entry and the live execution price, as a percentage of price.
//     Default 0.25%. Env: SIGNAL_ENTRY_DRIFT_PCT
//
// NOTE (drift basis): percentage drift is a reasonable default and identical
// for BUY and SELL (symmetric, sign-independent). For XAU/USD an ATR-relative or
// pip-distance limit is more semantically meaningful; we do NOT change the live
// threshold until that alternative is validated against historical signal vs
// execution data (Phase note).
// ─────────────────────────────────────────────────────────────────────────────

export function signalMaxAgeSeconds() {
  const v = parseInt(process.env.SIGNAL_MAX_AGE_SECONDS || '150', 10)
  return Number.isFinite(v) && v > 0 ? v : 150
}

export function entryDriftPctLimit() {
  const v = parseFloat(process.env.SIGNAL_ENTRY_DRIFT_PCT || '0.25')
  return Number.isFinite(v) && v > 0 ? v : 0.25
}

/** Symmetric percentage drift between reference and live price (BUY/SELL same). */
export function computeDriftPct(referencePrice, livePrice) {
  const ref = Number(referencePrice)
  const live = Number(livePrice)
  if (!Number.isFinite(ref) || !Number.isFinite(live) || !(ref > 0) || !(live > 0)) return null
  return (Math.abs(live - ref) / ref) * 100
}

/**
 * Deterministic pre-execution guard evaluation. Returns ok + exact gate/reason.
 * Missing optional metadata (no signal_at / no reference price) is intentionally
 * backward-compatible and does NOT block (ok:true, skipped:true for those gates).
 */
export function evaluateExecutionGuards(opts = {}) {
  const nowMs = Number.isFinite(opts.nowMs) ? opts.nowMs : Date.now()
  const ttlSeconds = Number.isFinite(opts.ttlSeconds) ? opts.ttlSeconds : signalMaxAgeSeconds()
  const driftLimitPct = Number.isFinite(opts.driftPctLimit) ? opts.driftPctLimit : entryDriftPctLimit()

  // 1) Stale signal (age anchored to the signal's generation/evaluation time).
  const sigAtMs = opts.signalAtMs !== undefined && opts.signalAtMs !== null && opts.signalAtMs !== ''
    ? Number(opts.signalAtMs) : null
  if (sigAtMs !== null && Number.isFinite(sigAtMs)) {
    const ageSec = Math.round((nowMs - sigAtMs) / 1000)
    if (ageSec > ttlSeconds) {
      return {
        ok: false, gate: 'stale_signal',
        reason: `Signal expired — ${ageSec}s old (max ${ttlSeconds}s). A fresh closed-candle signal is required.`,
      }
    }
  }

  // 2) Entry drift (reference vs live execution price).
  const driftPct = computeDriftPct(opts.referencePrice, opts.livePrice)
  if (driftPct !== null && driftPct > driftLimitPct) {
    return {
      ok: false, gate: 'entry_drift',
      reason: `Price moved beyond entry tolerance — reference ${Number(opts.referencePrice)} vs live ${Number(opts.livePrice)} (${driftPct.toFixed(2)}% > ${driftLimitPct}%). Re-scan for a fresh signal.`,
    }
  }

  // 3) Duplicate execution (an OPEN trade already exists for this signal).
  if (opts.signalRef && opts.openTradeExists) {
    return {
      ok: false, gate: 'duplicate_signal',
      reason: 'Duplicate execution — an OPEN trade already exists for this signal',
    }
  }

  return { ok: true, gate: null, reason: null }
}
