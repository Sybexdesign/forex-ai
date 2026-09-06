// lib/outcome-reconciliation.mjs
// ─────────────────────────────────────────────────────────────────────────────
// SybexForexAI — CROSS-ENGINE OUTCOME COMPARISON CORE (Phase 3)
//
// Pure, deterministic helpers that answer:
//   • do two engines agree on the same underlying decision?
//   • if not, WHICH engines disagree and WHY (a value difference vs a genuine
//     contract conflict)?
//
// No DB access here — this module is shared by the reconciliation API, the
// backfill script, the Historical Intelligence UI data, and the unit tests.
// Engine contracts live in ./outcome-contracts.mjs (single source of truth).
// ─────────────────────────────────────────────────────────────────────────────

export const AGREEMENT = {
  FULL: 'FULL_AGREEMENT',
  PARTIAL: 'PARTIAL_AGREEMENT',
  DISAGREEMENT: 'DISAGREEMENT',
  NOT_COMPARABLE: 'NOT_COMPARABLE',
  PARTIAL_DATA: 'PARTIAL_DATA',
}
export const MISMATCH = {
  PRED_VS_RECON: 'PREDICTION_VS_RECONCILIATION_MISMATCH',
  PRED_VS_LABEL: 'PREDICTION_VS_SIGNAL_LABEL_MISMATCH',
  PRED_VS_EXEC: 'PREDICTION_VS_EXECUTION_MISMATCH',
  DIR_CORRECT_TRADE_LOST: 'DIRECTION_CORRECT_BUT_TRADE_LOST',
  DIR_WRONG_TRADE_PROFITABLE: 'DIRECTION_WRONG_BUT_TRADE_PROFITABLE',
  HORIZON: 'TIME_HORIZON_DISAGREEMENT',
  SAMPLING: 'SAMPLING_METHOD_DISAGREEMENT',
  TIMEOUT: 'TIMEOUT_RULE_DISAGREEMENT',
  EXEC_MGMT: 'EXECUTION_MANAGEMENT_DIVERGENCE',
}
export const REASON = {
  DIFFERENT_HORIZON: 'DIFFERENT_HORIZON',
  INTRACANDLE_TOUCH: 'INTRACANDLE_TOUCH',
  CLOSE_ONLY_SAMPLING: 'CLOSE_ONLY_SAMPLING',
  HIGH_LOW_SAMPLING: 'HIGH_LOW_SAMPLING',
  TIMEOUT_DIFFERENCE: 'TIMEOUT_DIFFERENCE',
  ENTRY_REANCHORED: 'ENTRY_REANCHORED',
  SLIPPAGE: 'SLIPPAGE',
  BREAKEVEN: 'BREAKEVEN',
  TRAILING_STOP: 'TRAILING_STOP',
  TIME_EXIT: 'TIME_EXIT',
  MANUAL_EXIT: 'MANUAL_EXIT',
  LATE_EXECUTION: 'LATE_EXECUTION',
  NO_EXECUTION: 'NO_EXECUTION',
  MISSING_SAMPLES: 'MISSING_SAMPLES',
  NO_TOUCH: 'NO_TOUCH',
  UNKNOWN: 'UNKNOWN',
}

const norm = (x) => (x === null || x === undefined ? null : String(x).toUpperCase())

const absent = (v) => v === null || v === 'PENDING' || v === 'OPEN' || v === 'NO_TRADE' || v === ''

/**
 * Deterministic pairwise comparison between two engines of the SAME underlying
 * decision. `pair` ∈ 'prediction|signalLabel|reconciliation|signalLive|execution'.
 * Returns { agree:boolean|null, className:string|null, reasons:string[] }.
 *   agree === null  → the pair is NOT comparable (missing/abstaining side).
 */
export function comparePair(pair, outcomeA, outcomeB, flags = {}) {
  const a = norm(outcomeA)
  const b = norm(outcomeB)
  const reasons = []
  if (absent(a) && absent(b)) return { agree: null, className: AGREEMENT.NOT_COMPARABLE, reasons: [REASON.MISSING_SAMPLES] }
  if (absent(a) || absent(b)) {
    const missingExec = pair === 'execution' || pair.endsWith('execution')
    return {
      agree: null,
      className: missingExec ? AGREEMENT.NOT_COMPARABLE : AGREEMENT.PARTIAL_DATA,
      reasons: absent(b) ? [REASON.NO_EXECUTION] : [REASON.MISSING_SAMPLES],
    }
  }

  if (a === b) return { agree: true, className: AGREEMENT.FULL, reasons: [] }

  if (pair === 'prediction|reconciliation') {
    reasons.push(REASON.DIFFERENT_HORIZON)
    return { agree: false, className: MISMATCH.HORIZON, reasons }
  }
  if (pair === 'prediction|signalLabel') {
    if (a === 'INCONCLUSIVE' && b === 'WIN') {
      reasons.push(REASON.HIGH_LOW_SAMPLING, REASON.CLOSE_ONLY_SAMPLING, REASON.INTRACANDLE_TOUCH)
      return { agree: false, className: MISMATCH.SAMPLING, reasons }
    }
    if (a === 'INCONCLUSIVE' && b === 'LOSS') {
      reasons.push(REASON.TIMEOUT_DIFFERENCE)
      return { agree: false, className: MISMATCH.TIMEOUT, reasons }
    }
    reasons.push(REASON.DIFFERENT_HORIZON, REASON.INTRACANDLE_TOUCH)
    return { agree: false, className: MISMATCH.PRED_VS_LABEL, reasons }
  }
  if (pair === 'prediction|execution') {
    if (a === 'INCONCLUSIVE') {
      return { agree: null, className: AGREEMENT.NOT_COMPARABLE, reasons: [REASON.NO_TOUCH] }
    }
    if (b === 'BREAKEVEN') {
      reasons.push(REASON.BREAKEVEN)
      return { agree: false, className: MISMATCH.EXEC_MGMT, reasons }
    }
    if (a === 'WIN' && b === 'LOSS') {
      if (flags.lateEntry) reasons.push(REASON.LATE_EXECUTION)
      if (flags.entryReanchored) reasons.push(REASON.ENTRY_REANCHORED)
      if (flags.slippage) reasons.push(REASON.SLIPPAGE)
      if (flags.trailing || flags.slTightened) reasons.push(REASON.TRAILING_STOP)
      if (flags.manual) reasons.push(REASON.MANUAL_EXIT)
      if (reasons.length === 0) reasons.push(REASON.UNKNOWN)
      reasons.unshift(REASON.EXEC_MGMT)
      return { agree: false, className: MISMATCH.PRED_VS_EXEC, reasons }
    }
    if (a === 'LOSS' && b === 'WIN') {
      if (flags.lateEntry) reasons.push(REASON.LATE_EXECUTION)
      if (flags.entryReanchored) reasons.push(REASON.ENTRY_REANCHORED)
      if (reasons.length === 0) reasons.push(REASON.UNKNOWN)
      return { agree: false, className: MISMATCH.DIR_WRONG_TRADE_PROFITABLE, reasons }
    }
    return { agree: false, className: MISMATCH.PRED_VS_EXEC, reasons: [REASON.UNKNOWN] }
  }
  // Remaining pairs (label/exec, recon/exec, label/recon …): value difference.
  if (b === 'BREAKEVEN' || a === 'BREAKEVEN') reasons.push(REASON.BREAKEVEN)
  if (reasons.length === 0) reasons.push(REASON.DIFFERENT_HORIZON)
  return { agree: false, className: AGREEMENT.PARTIAL, reasons }
}


/** Deterministic diagnosis reasons for a full four/five-engine record. */
export function diagnose(rec, flags = {}) {
  const r = []
  if (!rec.prediction && !rec.reconciliation && !rec.signalLabel && !rec.execution) return [REASON.UNKNOWN]
  const pairs = [
    ['prediction|reconciliation', rec.prediction, rec.reconciliation],
    ['prediction|signalLabel', rec.prediction, rec.signalLabel],
    ['prediction|execution', rec.prediction, rec.execution],
    ['signalLabel|execution', rec.signalLabel, rec.execution],
    ['reconciliation|execution', rec.reconciliation, rec.execution],
  ]
  for (const [pair, a, b] of pairs) {
    if (!a || !b) continue
    const c = comparePair(pair, a, b, flags)
    for (const reason of c.reasons) if (!r.includes(reason)) r.push(reason)
  }
  // A prediction that was never executed is not an unexplained disagreement.
  if (rec.prediction && !rec.execution && !r.includes(REASON.NO_EXECUTION)) r.push(REASON.NO_EXECUTION)
  if (r.length === 0 && flags.executionManagement) r.push(REASON.EXEC_MGMT)
  return r.length ? r : [REASON.UNKNOWN]
}

/**
 * Top-level four-engine class for one linked record.
 * NOT_COMPARABLE   → execution absent (nothing comparable against money).
 * PARTIAL_DATA     → a non-execution engine is missing.
 * FULL_AGREEMENT   → prediction, signalLabel, reconciliation, execution all
 *                    present and identical (WIN×4 or LOSS×4).
 * PARTIAL_AGREEMENT → some pairs agree, none conflict on same-question pairs.
 * DISAGREEMENT     → at least one same-question pair disagrees.
 */
export function classifyRecord(rec, flags = {}) {
  const has = (x) => !!norm(x)
  const present = { p: has(rec.prediction), l: has(rec.signalLabel), r: has(rec.reconciliation), e: has(rec.execution) }
  if (!present.p && !present.l && !present.r && !present.e) return AGREEMENT.NOT_COMPARABLE
  if (present.p && !present.e) return AGREEMENT.NOT_COMPARABLE
  if (present.p && !present.r) return AGREEMENT.PARTIAL_DATA

  if (present.p && present.l && present.r && present.e) {
    const vals = [rec.prediction, rec.signalLabel, rec.reconciliation, rec.execution]
    const first = norm(vals[0])
    if (vals.every((v) => norm(v) === first) && (first === 'WIN' || first === 'LOSS')) return AGREEMENT.FULL
  }
  const pairs = [
    ['prediction|signalLabel', rec.prediction, rec.signalLabel],
    ['prediction|reconciliation', rec.prediction, rec.reconciliation],
    ['prediction|execution', rec.prediction, rec.execution],
  ]
  for (const [pair, a, b] of pairs) {
    if (!norm(a) || !norm(b)) continue
    if (comparePair(pair, a, b, flags).agree === false) return AGREEMENT.DISAGREEMENT
  }
  return AGREEMENT.PARTIAL
}

/** Single-candidate linkage key for identical-engine records (user+pair+candle). */
export function linkKey(userId, pair, candleCloseIso) {
  return `${String(userId)}|${pair}|${String(candleCloseIso)}`
}

/**
 * Build a summary of pairwise agreement + disagreement causes + confusion
 * matrices over an array of linked records. Pure and UI/API ready.
 */
export function summarize(records) {
  const out = {
    records: records.length,
    fourEngine: { FULL_AGREEMENT: 0, PARTIAL_AGREEMENT: 0, DISAGREEMENT: 0, NOT_COMPARABLE: 0, PARTIAL_DATA: 0 },
    pairwise: {},
    causes: {},
    matrices: {},
    notComparableCount: 0,
  }
  const pairDefs = [
    ['prediction|reconciliation', 'Prediction ↔ Reconciliation', (r) => r.prediction, (r) => r.reconciliation],
    ['prediction|signalLabel', 'Prediction ↔ Signal Label', (r) => r.prediction, (r) => r.signalLabel],
    ['prediction|execution', 'Prediction ↔ Execution', (r) => r.prediction, (r) => r.execution],
    ['signalLabel|execution', 'Signal Label ↔ Execution', (r) => r.signalLabel, (r) => r.execution],
    ['reconciliation|execution', 'Reconciliation ↔ Execution', (r) => r.reconciliation, (r) => r.execution],
  ]
  for (const [, label] of pairDefs) {
    out.pairwise[label] = { n: 0, agree: 0, disagree: 0, notComparable: 0, agreementPct: null }
    out.matrices[label] = { rows: {} }
  }
  for (const rec of records) {
    const four = classifyRecord(rec)
    out.fourEngine[four] = (out.fourEngine[four] || 0) + 1
    if (four === AGREEMENT.NOT_COMPARABLE || four === AGREEMENT.PARTIAL_DATA) out.notComparableCount++
    for (const reason of diagnose(rec)) out.causes[reason] = (out.causes[reason] || 0) + 1
    for (const [key, label, getA, getB] of pairDefs) {
      const a = norm(getA(rec)), b = norm(getB(rec))
      const p = out.pairwise[label]
      const m = out.matrices[label]
      if (!a || !b) continue
      const cmp = comparePair(key, a, b)
      p.n++
      if (cmp.agree === true) p.agree++
      else if (cmp.agree === false) p.disagree++
      else p.notComparable++
      m.rows[a] = m.rows[a] || { WIN: 0, LOSS: 0, INCONCLUSIVE: 0, BREAKEVEN: 0 }
      m.rows[a][b] = (m.rows[a][b] || 0) + 1
    }
  }
  for (const [, label] of pairDefs) {
    const p = out.pairwise[label]
    p.agreementPct = p.n > 0 ? +((100 * p.agree) / p.n).toFixed(1) : null
  }
  return out
}

