// lib/outcome-contracts.mjs
// ─────────────────────────────────────────────────────────────────────────────
// SybexForexAI — COMMON OUTCOME TAXONOMY + ENGINE CONTRACT REGISTRY (Phase 3)
//
// There are four outcome engines that answer DIFFERENT questions. They are NOT
// interchangeable. This module is the single place that documents each engine's
// contract and maps outcome values to an unambiguous taxonomy, so new analytics
// (outcome_reconciliation, the API, the UI) never conflate them.
//
// Values here are taken from the Phase 3 source audit (see the report), not
// invented. Engine semantics can only be changed by updating this registry AND
// the corresponding writer.
// ─────────────────────────────────────────────────────────────────────────────

// ── Outcome value taxonomy ────────────────────────────────────────────────────
export const O_PREDICTION = {
  WIN: 'WIN', LOSS: 'LOSS', INCONCLUSIVE: 'INCONCLUSIVE', PENDING: 'PENDING',
}
export const O_SIGNAL_LABEL = { WIN: 'WIN', LOSS: 'LOSS', PENDING: 'PENDING' }
export const O_RECONCILIATION = { WIN: 'WIN', LOSS: 'LOSS', INCONCLUSIVE: 'INCONCLUSIVE', PENDING: 'PENDING' }
export const O_EXECUTION = {
  WIN: 'WIN', LOSS: 'LOSS', BREAKEVEN: 'BREAKEVEN', OPEN: 'OPEN',
}

// ── Outcome-source attribution values ─────────────────────────────────────────
export const OUTCOME_SOURCES = {
  PREDICTION_RESOLVER: 'PREDICTION_RESOLVER',
  LABEL_CRON: 'LABEL_CRON',
  WORKER_TRACKER: 'WORKER_TRACKER',
  RECONCILIATION: 'RECONCILIATION',
  BROKER: 'BROKER',
  TRADE_MANAGER: 'TRADE_MANAGER',
  MANUAL: 'MANUAL',
}

// ── Contract versions (so unlike historical semantics are never compared silently)
export const CONTRACT_VERSIONS = {
  PREDICTION_V1: 'prediction_v1',
  PREDICTION_V2_PHASE2: 'prediction_v2_phase2', // canonical 15-min M5-close contract
  LABEL_LEGACY: 'label_legacy',
  RECONCILE_V1: 'reconcile_v1',
  LIVE_TRACKER_LEGACY: 'live_tracker_legacy',
}

// Writers that can touch the LEGACY signals.outcome column (documented Phase 3
// finding — the column is multi-writer and must never be read as a single
// unambiguous contract). Attribution lives in signals.outcome_source for new rows.
export const SIGNALS_OUTCOME_WRITERS = ['LABEL_CRON', 'WORKER_TRACKER', 'MANUAL']

// ── Outcome contract registry (audited values) ────────────────────────────────
export const OUTCOME_CONTRACTS = {
  prediction_logs: {
    purpose: 'prediction_quality',
    horizonMinutes: 15,
    sampling: 'closed_m5_close',
    timeout: 'INCONCLUSIVE',
    resolution: 'TP_BEFORE_SL',
    version: 'prediction_v2_phase2',
    writers: ['PREDICTION_RESOLVER'],
    question: 'Did TP get reached before SL on the 3 future M5 closes (15 min)?',
  },
  signal_label_legacy: {
    purpose: 'legacy_signal_label',
    horizonMinutes: 30,
    sampling: 'm5_high_low',
    timeout: 'LOSS',
    version: 'label_legacy',
    writers: ['LABEL_CRON'],
    question: 'Did the M5 candles touch TP at any point in ~30 min (else LOSS)?',
  },
  signal_live_tracker: {
    purpose: 'signal_live_outcome',
    horizonMinutes: 240,
    sampling: 'live_worker_close',
    timeout: null,
    version: 'live_tracker_legacy',
    writers: ['WORKER_TRACKER'],
    question: 'Did the live price reach TP/SL while the worker tracked the signal (<=4h)?',
  },
  reconciliation: {
    purpose: 'directional_accuracy',
    horizonMinutes: 5,
    sampling: 'snapshot',
    timeout: 'INCONCLUSIVE',
    version: 'reconcile_v1',
    writers: ['RECONCILIATION'],
    question: 'Was the direction correct ~5 minutes after the signal (>=0.3 pip)?',
  },
  execution: {
    purpose: 'realised_trade_performance',
    horizonMinutes: null,
    sampling: 'broker_execution',
    timeout: null,
    version: null,
    writers: ['BROKER', 'TRADE_MANAGER', 'MANUAL', 'WORKER_TRACKER'],
    question: 'What actually happened to the money?',
  },
}

/**
 * Whether two engine contracts measure the SAME underlying question. Only then is
 * an outcome difference a genuine CONTRACT_CONFLICT; otherwise it is a
 * VALUE_DIFFERENCE caused by the engines answering different questions.
 */
export function sameQuestion(aKey, bKey) {
  const s = (k) => {
    if (k === 'prediction') return OUTCOME_CONTRACTS.prediction_logs.purpose
    if (k === 'signalLabel') return OUTCOME_CONTRACTS.signal_label_legacy.purpose
    if (k === 'signalLive') return OUTCOME_CONTRACTS.signal_live_tracker.purpose
    if (k === 'reconciliation') return OUTCOME_CONTRACTS.reconciliation.purpose
    if (k === 'execution') return OUTCOME_CONTRACTS.execution.purpose
    return k
  }
  return s(aKey) === s(bKey)
}

/** Human label for a taxonomy/engine key (for UI/API diagnostics). */
export const OUTCOME_LABELS = {
  prediction: 'Prediction (15-min M5-close TP/SL)',
  signalLabel: 'Signal label (30-min M5 high/low)',
  signalLive: 'Signal live tracker (<=4h worker TP/SL)',
  reconciliation: 'Reconciliation (5-min directional)',
  execution: 'Execution (realised broker P&L)',
}
