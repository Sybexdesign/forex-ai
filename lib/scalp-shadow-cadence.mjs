// lib/scalp-shadow-cadence.mjs
// ── THE SHADOW OBSERVATION CADENCE (Phase 3.2) ──────────────────────────────
//
// WHY THIS MODULE EXISTS
//
// Observation used to be reachable ONLY from `fetchRiskState()`, whose only caller
// is the auto-trade order path — after the signal, confidence, cooldown, hold and
// order-eligibility gates. The chain was:
//
//     BUY/SELL signal → confidence passes → cooldown expires → not HOLD
//       → fetchRiskState() → shadowHandoff(acct) → observer runs
//
// so in a flat market the observer NEVER RAN: no order attempt → no risk fetch →
// no handoff → no discovery, no health, no state-load diagnostic, no evidence.
// That is why production produced nothing even after the lifecycle and
// persistence repairs were correct.
//
// Observation is now sweep-driven and INDEPENDENT of signal/order flow.
//
// ── ONE CANONICAL ENTRY POINT ───────────────────────────────────────────────
//
// `observeOnce(acct)` is the single production call site. It is idempotent per
// account snapshot: the same snapshot object is never observed twice. A sweep that
// reuses a cached snapshot and an order attempt that fetched its own therefore
// cannot double-observe, and one snapshot can never be counted twice.
//
// ── TWO CADENCES, DELIBERATELY SEPARATE ─────────────────────────────────────
//
//   DISCOVERY  this module's `tick()` — how often a snapshot is handed over.
//   EVALUATION the runtime's SHADOW_EVAL_MS (60s), unchanged.
//
// Moving the handoff to the sweep does NOT evaluate more often: the runtime still
// throttles expensive analysis, with the existing first-seen bypass.
//
// ── TRAFFIC ─────────────────────────────────────────────────────────────────
//
// It reuses a fresh authoritative snapshot (same TTL the risk cache already uses)
// and only fetches when that snapshot has gone stale, so it adds no polling beyond
// the existing cadence.
//
// ── FAILURE ISOLATION ───────────────────────────────────────────────────────
//
// `tick()` cannot throw and returns a plain result object, so it can never
// interrupt the trading sweep. Failures are reported, never hidden.
//
// This module performs NO I/O of its own (`fetchAccount` is injected), imports no
// broker adapter, and cannot reach a broker write.

/**
 * @param {object} deps
 * @param {(acct:object) => void} deps.shadowHandoff   the observation handoff (cannot throw)
 * @param {() => Promise<object|null>} deps.fetchAccount  authoritative account fetch
 * @param {() => number} deps.getTrackedCount          how many lifecycles are tracked
 * @param {number} [deps.ttlMs]                        snapshot reuse window
 * @param {() => number} [deps.now]
 * @param {(msg:string, meta?:object) => void} [deps.log]  failure reporting
 */
export function createShadowObserver(deps = {}) {
  const {
    shadowHandoff, fetchAccount, getTrackedCount,
    ttlMs = 30_000, now = Date.now, log = () => {},
  } = deps

  for (const [name, fn] of Object.entries({ shadowHandoff, fetchAccount, getTrackedCount })) {
    if (typeof fn !== 'function') throw new Error(`scalp-shadow-cadence: missing dependency '${name}'`)
  }

  let lastObservedAcct = null      // identity of the last snapshot handed over
  let lastAcctSnapshot = null      // most recent authoritative snapshot, for reuse
  let lastAcctAt       = 0
  const counters = { handedOver: 0, deduped: 0, fetches: 0, reuses: 0, failures: 0, skippedIdle: 0 }

  /**
   * THE canonical observation entry point. Hands `acct` to the observer at most
   * once. Returns whether a handover happened.
   */
  function observeOnce(acct) {
    if (!acct || typeof acct !== 'object') return false
    if (acct === lastObservedAcct) { counters.deduped++; return false }
    lastObservedAcct = acct
    counters.handedOver++
    shadowHandoff(acct)
    return true
  }

  /** Publish an already-fetched snapshot so the tick can reuse it instead of re-fetching. */
  function publishSnapshot(acct) {
    if (!acct || typeof acct !== 'object') return false
    lastAcctSnapshot = acct
    lastAcctAt = now()
    return true
  }

  /**
   * The observation cadence, driven from the worker sweep. NEVER throws.
   * @returns {Promise<{action:string, observed?:boolean}>}
   */
  async function tick(marketOpen = true) {
    try {
      // Nothing to observe and no reason to poll: closed market, nothing tracked.
      if (!marketOpen && getTrackedCount() === 0) { counters.skippedIdle++; return { action: 'skipped:idle-closed-market' } }

      if (lastAcctSnapshot && (now() - lastAcctAt) < ttlMs) {
        counters.reuses++
        return { action: 'reused-snapshot', observed: observeOnce(lastAcctSnapshot) }
      }

      counters.fetches++
      const acct = await fetchAccount().catch(() => null)
      if (!acct) {
        counters.failures++
        // Observable, never silent (§7): a failed fetch is reported.
        try { log('scalp-shadow: observation cadence could not obtain an account snapshot (fetch failed or returned nothing)',
          { stage: 'shadowObservationTick' }) } catch { /* diagnostics must never break trading */ }
        return { action: 'fetch-failed' }
      }
      publishSnapshot(acct)
      return { action: 'fetched-snapshot', observed: observeOnce(acct) }
    } catch (e) {
      // Failure isolation: report, never propagate into the trading sweep.
      counters.failures++
      try { log(`scalp-shadow: observation cadence failed: ${e?.message || e}`,
        { stage: 'shadowObservationTick' }) } catch { /* diagnostics must never break trading */ }
      return { action: 'failed', error: e?.message || String(e) }
    }
  }

  /** Admin cache reset: forget in-memory caches, never durable facts. */
  function resetMemory() {
    lastObservedAcct = null
    lastAcctSnapshot = null
    lastAcctAt       = 0
  }

  return { observeOnce, tick, publishSnapshot, resetMemory, getStats: () => ({ ...counters }) }
}
