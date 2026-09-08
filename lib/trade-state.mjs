// lib/trade-state.mjs
// ─────────────────────────────────────────────────────────────────────────────
// Durable trade-manager state helpers (Production hardening).
//
// trade-manager state is persisted inside broker_configs.config.tradeState and
// restored on every EA sync. These pure helpers make that persistence safe:
//   • mergeTradeState() is MONOTONIC — it can never lose protection markers
//     (break-even applied, profit-lock applied, partial state, reversal alert)
//     or lower a recorded peak profit. Stops themselves live on the broker and
//     are only ever advanced by trade-manager at runtime, never regressed here.
//   • The sequence guard (mt5-sync) uses stateSeq so an older process cannot
//     overwrite newer management state during a serverless cold-start overlap.
// ─────────────────────────────────────────────────────────────────────────────

const monotonicFlag = (k, prev, next) => !!(prev?.[k] || next?.[k])
const maxNum = (a, b) => {
  const na = a === undefined || a === null || !Number.isFinite(Number(a)) ? -Infinity : Number(a)
  const nb = b === undefined || b === null || !Number.isFinite(Number(b)) ? -Infinity : Number(b)
  return Math.max(na, nb)
}

/**
 * Merge previous (durably stored) trade state with the freshly-computed state.
 * Guarantees protection markers are never lost across restarts/overlaps and
 * peakProfit never decreases.
 */
export function mergeTradeState(prev, next) {
  const prevMap = prev && typeof prev === 'object' ? prev : {}
  const nextMap = next && typeof next === 'object' ? next : {}
  const keys = new Set([...Object.keys(prevMap), ...Object.keys(nextMap)])
  const out = {}
  for (const key of keys) {
    const p = prevMap[key] && typeof prevMap[key] === 'object' ? prevMap[key] : {}
    const n = nextMap[key] && typeof nextMap[key] === 'object' ? nextMap[key] : {}
    if (!n.originalEntry && !p.originalEntry) continue
    out[key] = {
      ...p,
      ...n,
      // Protection markers are sticky — never cleared by a restart or overlap.
      beApplied:      monotonicFlag('beApplied', p, n),
      partialLocked:  monotonicFlag('partialLocked', p, n),
      reversalAlertSent: monotonicFlag('reversalAlertSent', p, n),
      // Peak profit / extreme excursion can only ever grow.
      peakProfit: maxNum(p.peakProfit, n.peakProfit),
      // Keep the original opening timestamp (earliest known) so time-exits are
      // not reset by a restart.
      openedAt: p.openedAt || n.openedAt || null,
    }
  }
  return out
}

/** Read-only guard: flags if a candidate final state would regress any protected
 * marker vs the durably-persisted state (used for pre-write validation/audit). */
export function assertNoStateRegression(prev, candidate) {
  const prevMap = prev && typeof prev === 'object' ? prev : {}
  const candMap = candidate && typeof candidate === 'object' ? candidate : {}
  const keys = new Set([...Object.keys(prevMap), ...Object.keys(candMap)])
  const issues = []
  for (const key of keys) {
    const p = prevMap[key] || {}
    const c = candMap[key] || {}
    if (p.beApplied && !c.beApplied) issues.push(`${key}.beApplied`)
    if (p.partialLocked && !c.partialLocked) issues.push(`${key}.partialLocked`)
    if (p.reversalAlertSent && !c.reversalAlertSent) issues.push(`${key}.reversalAlertSent`)
    if (Number.isFinite(Number(p.peakProfit)) && (!Number.isFinite(Number(c.peakProfit)) || Number(c.peakProfit) < Number(p.peakProfit))) {
      issues.push(`${key}.peakProfit`)
    }
    if (p.openedAt && c.openedAt && new Date(c.openedAt).getTime() > new Date(p.openedAt).getTime()) {
      issues.push(`${key}.openedAt`)
    }
  }
  return { ok: issues.length === 0, issues }
}
