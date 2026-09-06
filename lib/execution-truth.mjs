// lib/execution-truth.mjs
// ─────────────────────────────────────────────────────────────────────────────
// SybexForexAI — EXECUTION TRUTH LAYER (Phase 4)
//
// Pure, deterministic helpers that separate TRADE LIFECYCLE (status) from
// TRADE PROFITABILITY (result), derive results ONLY from realised net P&L, and
// compute execution-analytics primitives (realised R, conversion efficiency,
// edge leakage, sample confidence, refresh diffs). No DB access — shared by the
// backfill script, refresh service, API, UI and tests.
//
// Rules enforced here:
//   • 'CLOSED' is a STATUS, never a result.
//   • execution result is derived from net realised P&L only — never from the
//     prediction, label or reconciliation verdict.
//   • realised R is NULL when planned risk is missing/invalid — never guessed.
//   • conversion/leakage metrics are guarded against tiny/zero/negative samples.
// ─────────────────────────────────────────────────────────────────────────────

export const TRADE_STATUS = {
  PENDING: 'PENDING', OPEN: 'OPEN', PARTIALLY_CLOSED: 'PARTIALLY_CLOSED',
  CLOSED: 'CLOSED', CANCELLED: 'CANCELLED', REJECTED: 'REJECTED', NO_FILL: 'NO_FILL',
}
export const TRADE_RESULT = {
  WIN: 'WIN', LOSS: 'LOSS', BREAKEVEN: 'BREAKEVEN',
  PARTIAL_WIN: 'PARTIAL_WIN', PARTIAL_LOSS: 'PARTIAL_LOSS', UNKNOWN: 'UNKNOWN',
}
export const EXECUTION_BE_EPSILON_USD = 0.01  // |net P&L| ≤ this ⇒ BREAKEVEN

export const EXECUTION_CONTRACT_VERSION = 'execution_v1'
export const EXECUTION_SOURCES = { BROKER: 'BROKER', MT5_SYNC: 'MT5_SYNC', ORDERS: 'ORDERS', MANUAL: 'MANUAL' }

const S = TRADE_STATUS, R = TRADE_RESULT

/**
 * Map the legacy/raw `result` column into lifecycle + profitability fields.
 * input = { result, status?, closedAt?, netPnl?, ... }
 * Returns { trade_status, trade_result, normalizedResult }.
 */
export function normaliseExecution(input) {
  const raw = String(input?.result ?? input?.status ?? '').toUpperCase().trim()
  const closed = !!(input?.closed_at || input?.closedAt)
  const netPnl = input?.netPnl !== undefined && input?.netPnl !== null && input?.netPnl !== ''
    ? Number(input.netPnl) : null
  const pnlKnown = netPnl !== null && Number.isFinite(netPnl)
  const epsilon = Number(input?.epsilon ?? EXECUTION_BE_EPSILON_USD)

  let tradeStatus = null
  let tradeResult = R.UNKNOWN
  switch (raw) {
    case 'OPEN': tradeStatus = closed ? S.CLOSED : S.OPEN; break
    case 'CLOSED': tradeStatus = S.CLOSED; break
    case 'WIN': case 'LOSS': case 'BREAKEVEN':
      tradeStatus = closed ? S.CLOSED : S.OPEN
      if (!pnlKnown) tradeResult = raw === 'BREAKEVEN' ? R.BREAKEVEN : (raw === 'WIN' ? R.WIN : R.LOSS)
      break
    case 'PENDING': tradeStatus = S.PENDING; break
    case 'PARTIALLY_CLOSED': case 'PARTIAL': tradeStatus = S.PARTIALLY_CLOSED; break
    case 'CANCELLED': tradeStatus = S.CANCELLED; break
    case 'REJECTED': tradeStatus = S.REJECTED; break
    case 'NO_FILL': tradeStatus = S.NO_FILL; break
    default: tradeStatus = null
  }
  if (tradeStatus === null) return { trade_status: null, trade_result: R.UNKNOWN, normalizedResult: null }

  if (pnlKnown) {
    tradeResult = executionResult(netPnl, epsilon)
  } else if (tradeStatus !== S.CLOSED && raw !== 'WIN' && raw !== 'LOSS' && raw !== 'BREAKEVEN') {
    tradeResult = R.UNKNOWN
  }

  const normalizedResult =
    tradeStatus === S.OPEN ? 'OPEN'
    : (tradeStatus === S.CLOSED && tradeResult !== R.UNKNOWN)
      ? (tradeResult === R.BREAKEVEN ? 'BREAKEVEN' : tradeResult === R.WIN ? 'WIN' : 'LOSS')
      : 'OPEN'
  return { trade_status: tradeStatus, trade_result: tradeResult, normalizedResult }
}

/** WIN/LOSS/BREAKEVEN/UNKNOWN from NET realised P&L only. */
export function executionResult(netPnl, epsilon = EXECUTION_BE_EPSILON_USD) {
  const v = Number(netPnl)
  if (!Number.isFinite(v)) return R.UNKNOWN
  if (v > epsilon) return R.WIN
  if (v < -epsilon) return R.LOSS
  return R.BREAKEVEN
}

/** realised R = net realised P&L ÷ planned initial monetary risk. NULL unless risk>0. */
export function realisedR(netPnl, plannedRiskAmount) {
  if (netPnl === null || netPnl === undefined || netPnl === '') return null
  const pnl = Number(netPnl)
  const risk = Number(plannedRiskAmount)
  if (!Number.isFinite(pnl) || !Number.isFinite(risk) || !(risk > 0)) return null
  return +(pnl / risk).toFixed(4)
}

/**
 * Cross-domain class for prediction + execution. Keeps BOTH truths visible —
 * never collapses them.
 */
export function crossDomainClass(prediction, execution) {
  const p = prediction ? String(prediction).toUpperCase() : null
  const e = execution ? String(execution).toUpperCase() : null
  if (!p) return e ? 'NO_PREDICTION' : 'NO_EXECUTION'
  if (!e || e === 'OPEN') return 'NO_EXECUTION'
  const map = {
    'WIN|WIN': 'PREDICTION_WIN_EXECUTION_WIN',
    'WIN|LOSS': 'PREDICTION_WIN_EXECUTION_LOSS',
    'LOSS|WIN': 'PREDICTION_LOSS_EXECUTION_WIN',
    'LOSS|LOSS': 'PREDICTION_LOSS_EXECUTION_LOSS',
    'INCONCLUSIVE|WIN': 'PREDICTION_INCONCLUSIVE_EXECUTION_WIN',
    'INCONCLUSIVE|LOSS': 'PREDICTION_INCONCLUSIVE_EXECUTION_LOSS',
    'INCONCLUSIVE|BREAKEVEN': 'PREDICTION_INCONCLUSIVE_EXECUTION_BE',
    'WIN|BREAKEVEN': 'PREDICTION_WIN_EXECUTION_BE',
    'LOSS|BREAKEVEN': 'PREDICTION_LOSS_EXECUTION_BE',
  }
  return map[`${p}|${e}`] || `PREDICTION_${p}_EXECUTION_${e}`
}

/** Sample-confidence band for execution analytics (<20 → INSUFFICIENT_DATA). */
export function sampleConfidenceLabel(n, thresholds = { low: 20, moderate: 50, strong: 100 }) {
  if (n < thresholds.low) return 'INSUFFICIENT_DATA'
  if (n < thresholds.moderate) return 'LOW_CONFIDENCE'
  if (n < thresholds.strong) return 'MODERATE'
  return 'STRONG'
}

/**
 * Prediction→execution conversion efficiency, with safeguards.
 * Returns { efficiency, reason } where efficiency is null when meaningless.
 */
export function conversionEfficiency(executionExpectancyR, predictionExpectancyR, executionSample = 0, thresholds = { low: 20 }) {
  const pe = Number(predictionExpectancyR); const ee = Number(executionExpectancyR)
  if (executionSample < thresholds.low) return { efficiency: null, reason: 'INSUFFICIENT_EXECUTION_SAMPLE' }
  if (!Number.isFinite(pe) || !Number.isFinite(ee)) return { efficiency: null, reason: 'MISSING_EXPECTANCY' }
  if (pe <= 0) return { efficiency: null, reason: 'PREDICTION_EXPECTANCY_NON_POSITIVE' }
  if (ee < 0) return { efficiency: null, reason: 'NEGATIVE_EXECUTION_EXPECTANCY' }
  const value = +(100 * ee / pe).toFixed(1)
  return { efficiency: Math.min(100, Math.max(0, value)), reason: null }
}

/** Edge leakage = prediction expectancy − execution expectancy (in R). */
export function edgeLeakage(predictionExpectancyR, executionExpectancyR) {
  const pe = Number(predictionExpectancyR); const ee = Number(executionExpectancyR)
  if (!Number.isFinite(pe) || !Number.isFinite(ee)) return null
  return +(pe - ee).toFixed(4)
}

/**
 * Execution quality score 0–100 (analytics only). Penalises measurable frictions:
 * slippage pips, entry delay seconds, spread pips, poor MFE capture, and
 * management exits. Never gates anything.
 */
export function executionQualityScore(input) {
  let score = 100
  const slip = Number(input?.slippagePips ?? 0) || 0
  const delayS = Math.max(0, (Number(input?.entryDelayMs ?? 0) || 0) / 1000)
  const spread = Number(input?.spreadPips ?? 0) || 0
  const mfeCapture = input?.mfeCaptureRatio !== undefined && input?.mfeCaptureRatio !== null ? Number(input.mfeCaptureRatio) : null
  const exitKind = String(input?.exitKind ?? '').toUpperCase()

  score -= Math.min(30, slip * 3)
  score -= Math.min(20, delayS / 5)
  score -= Math.min(15, spread * 1.5)
  if (mfeCapture !== null && Number.isFinite(mfeCapture)) {
    if (mfeCapture < 0.5) score -= 15
    else if (mfeCapture < 0.8) score -= 8
  }
  if (exitKind.includes('TIME_EXIT') || exitKind.includes('MANUAL')) score -= 10
  if (exitKind.includes('BREAKEVEN')) score -= 6
  return Math.max(0, Math.min(100, Math.round(score)))
}


// ── Refresh diffing (Phase 4) ─────────────────────────────────────────────────
// Compares freshly-derived reconciliation rows against what is already stored so
// callers can report inserted/updated/unchanged without delete-and-reinsert.
const REFRESH_FIELDS = [
  'prediction_outcome', 'prediction_resolved_at', 'signal_label_outcome', 'signal_label_source',
  'signal_label_resolved_at', 'reconciliation_outcome', 'reconciliation_resolved_at',
  'execution_outcome', 'execution_closed_at', 'execution_pnl_usd', 'execution_r',
  'agreement_class', 'disagreement_reasons', 'contract_versions',
]
const str = (v) => (v === undefined || v === null ? null : typeof v === 'object' ? JSON.stringify(v) : String(v))

export function diffRefresh(derivedRows, existingRows) {
  const existing = new Map(existingRows.map(r => [String(r.setup_key), r]))
  const out = { inserted: [], updated: [], unchanged: [], deleted: [] }
  const seen = new Set()
  for (const row of derivedRows) {
    const key = String(row.setup_key)
    seen.add(key)
    const old = existing.get(key)
    if (!old) { out.inserted.push(key); continue }
    const changed = REFRESH_FIELDS.some(f => str(old[f]) !== str(row[f]))
    if (changed) out.updated.push(key); else out.unchanged.push(key)
  }
  for (const key of existing.keys()) if (!seen.has(key)) out.deleted.push(key)
  return out
}

/** Execution expectancy metrics from an array of closed executions. */
export function executionExpectancy(executions, { epsilon = EXECUTION_BE_EPSILON_USD, plannedRiskFallback = null } = {}) {
  const rs = []
  for (const e of executions) {
    const pnl = Number(e?.netPnl ?? e?.net_realised_pnl ?? e?.pl_usd)
    if (!Number.isFinite(pnl)) continue
    let r = e?.realised_r !== undefined && e?.realised_r !== null && Number.isFinite(Number(e.realised_r)) ? Number(e.realised_r) : null
    if (r === null) {
      const risk = Number(e?.planned_risk_amount ?? e?.plannedRiskAmount ?? (plannedRiskFallback && Number(plannedRiskFallback)))
      r = risk > 0 ? Number(realisedR(pnl, risk)) : null
      if (r === null) continue
    }
    rs.push(r)
  }
  if (rs.length === 0) return null
  const mean = rs.reduce((a, b) => a + b, 0) / rs.length
  const wins = rs.filter(x => x > 0)
  const losses = rs.filter(x => x <= 0)
  const sorted = [...rs].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  const median = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
  const grossWin = wins.reduce((a, b) => a + b, 0)
  const grossLoss = Math.abs(losses.reduce((a, b) => a + b, 0))
  return {
    n: rs.length,
    avgRealisedR: +mean.toFixed(4),
    medianR: +median.toFixed(4),
    winRate: +(100 * wins.length / rs.length).toFixed(1),
    avgWinR: wins.length ? +(grossWin / wins.length).toFixed(4) : null,
    avgLossR: losses.length ? +(grossLoss / losses.length).toFixed(4) : null,
    profitFactor: grossLoss > 0 ? +(grossWin / grossLoss).toFixed(2) : (grossWin > 0 ? null : 0),
    sampleConfidence: sampleConfidenceLabel(rs.length),
  }
}

