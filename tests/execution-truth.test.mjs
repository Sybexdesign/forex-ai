// tests/execution-truth.test.mjs
// Phase 4 — refreshable reconciliation, execution truth layer, lifecycle vs
// profitability, conversion/leakage analytics, idempotency.
// Run: npm run test:phase4
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  TRADE_STATUS, TRADE_RESULT, normaliseExecution, executionResult, realisedR,
  crossDomainClass, sampleConfidenceLabel, conversionEfficiency,
  executionQualityScore, diffRefresh, executionExpectancy,
} from '../lib/execution-truth.mjs'
import { classifyRecord, AGREEMENT } from '../lib/outcome-reconciliation.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// ── A — reconciliation refresh: exec NULL row later gains execution (same key, no dup)
{
  const t0 = { setup_key: 'k1', prediction_outcome: 'WIN', execution_outcome: null, execution_pnl_usd: null, agreement_class: 'NOT_COMPARABLE', disagreement_reasons: [], contract_versions: {} }
  const t1 = { ...t0, execution_outcome: 'WIN', execution_pnl_usd: 42, execution_closed_at: '2026-09-07T10:00:00Z', agreement_class: 'PARTIAL_AGREEMENT' }
  const diff1 = diffRefresh([t1], [t0])
  assert.deepEqual({ ins: diff1.inserted.length, upd: diff1.updated.length }, { ins: 0, upd: 1 }, 'A: same setup_key updated, no duplicate')
  assert.equal(diff1.deleted.length, 0)
  assert.equal(diffRefresh([t1], [t1]).updated.length, 0, 'A: idempotent when already current')
  console.log('PASS A: refresh updates the SAME setup_key row; idempotent second pass')
}

// ── B — derived classification refresh (NOT_COMPARABLE → other class)
{
  assert.equal(classifyRecord({ prediction: 'WIN', signalLabel: 'WIN', reconciliation: 'WIN', execution: null }), AGREEMENT.NOT_COMPARABLE)
  assert.equal(classifyRecord({ prediction: 'WIN', signalLabel: 'WIN', reconciliation: 'WIN', execution: 'WIN' }), AGREEMENT.FULL, 'B')
  console.log('PASS B: classification refreshes as domains arrive (NOT_COMPARABLE → FULL_AGREEMENT)')
}

// ── C — 'CLOSED' is a STATUS, result derived separately
{
  const closed = normaliseExecution({ result: 'CLOSED', closed_at: '2026-09-07T10:00:00Z' })
  assert.equal(closed.trade_status, TRADE_STATUS.CLOSED, 'C: lifecycle = CLOSED')
  assert.equal(closed.trade_result, TRADE_RESULT.UNKNOWN, 'C: no P&L → UNKNOWN, never guessed')
  const withPnl = normaliseExecution({ result: 'CLOSED', closed_at: '2026-09-07T10:00:00Z', netPnl: 25 })
  assert.equal(withPnl.trade_result, TRADE_RESULT.WIN, 'C: P&L-driven result')
  console.log('PASS C: CLOSED = status; profitability derived separately from realised P&L')
}

// ── D/E/F — result derivation from net P&L
{
  assert.equal(executionResult(50), 'WIN', 'D')
  assert.equal(executionResult(-30), 'LOSS', 'E')
  assert.equal(executionResult(0), 'BREAKEVEN', 'F')
  assert.equal(executionResult(0.005), 'BREAKEVEN', 'F: within epsilon')
  console.log('PASS D/E/F: net realised P&L → WIN / LOSS / BREAKEVEN')
}

// ── G/H — both truths kept
{
  assert.equal(crossDomainClass('WIN', 'LOSS'), 'PREDICTION_WIN_EXECUTION_LOSS', 'G')
  assert.equal(crossDomainClass('LOSS', 'WIN'), 'PREDICTION_LOSS_EXECUTION_WIN', 'H')
  console.log('PASS G/H: cross-domain classes preserve both truths')
}

// ── I — no execution is NOT execution-LOSS
{
  assert.equal(crossDomainClass('WIN', null), 'NO_EXECUTION', 'I')
  assert.equal(classifyRecord({ prediction: 'WIN', signalLabel: 'WIN', reconciliation: 'WIN', execution: null }), AGREEMENT.NOT_COMPARABLE, 'I')
  console.log('PASS I: no execution → NO_EXECUTION / NOT_COMPARABLE (never LOSS)')
}

// ── J — explicit lineage fields on new trade writes (orders route)
{
  const src = readFileSync(path.join(root, 'app', 'api', 'orders', 'route.ts'), 'utf8')
  for (const needle of ['trade_status:', 'prediction_log_id:', 'setup_id:', 'broker_ticket:']) {
    assert.ok(src.includes(needle), `J: orders route stores ${needle}`)
  }
  console.log('PASS J: new executions carry trade_status, prediction_log_id, setup_id, broker_ticket lineage')
}

// ── L — realised R validation
{
  assert.equal(realisedR(100, 50), 2.0, 'L: +100 on 50 risk → +2R')
  assert.equal(realisedR(-25, 50), -0.5, 'L: −25 on 50 risk → −0.5R')
  assert.equal(realisedR(10, 0), null, 'L: zero risk → NULL')
  assert.equal(realisedR(null, 50), null, 'L: missing P&L → NULL')
  console.log('PASS L: realised R = net P&L ÷ planned risk (guarded)')
}

// ── M/N — expectancy isolation + determinism
{
  const execs = [{ netPnl: 30, planned_risk_amount: 100 }, { netPnl: -20, planned_risk_amount: 100 }]
  const ee1 = executionExpectancy(execs)
  const ee2 = executionExpectancy(execs.map(e => ({ ...e, prediction_outcome: 'LOSS' })))
  assert.deepEqual(ee1, ee2, 'M: execution analytics ignore prediction/label fields')
  assert.deepEqual(executionExpectancy(execs), executionExpectancy([...execs].reverse()), 'N: order-independent')
  console.log('PASS M/N: execution expectancy isolated from prediction/label and deterministic')
}

// ── O — conversion efficiency formula + safeguards
{
  assert.deepEqual(conversionEfficiency(0.24, 0.4, 25), { efficiency: 60.0, reason: null }, 'O: 0.24/0.40 → 60%')
  assert.equal(conversionEfficiency(0.24, 0.4, 5).efficiency, null, 'O: tiny sample guarded')
  assert.equal(conversionEfficiency(0.24, 0, 25).efficiency, null, 'O: prediction expectancy 0 guarded')
  assert.equal(conversionEfficiency(-0.1, 0.4, 25).efficiency, null, 'O: negative exec expectancy guarded')
  console.log('PASS O: conversion efficiency formula + safeguards')
}

// ── P — raw broker facts never mutated by derived analytics
{
  const trade = Object.freeze({ netPnl: 40, planned_risk_amount: 100, pl_usd: 40 })
  assert.doesNotThrow(() => { executionExpectancy([trade]); executionQualityScore({ slippagePips: 1 }) })
  console.log('PASS P: derived analytics never mutate broker fact objects (frozen input safe)')
}

// ── Q — analytics consume attributed signal_label_outcome, not legacy ambiguity
{
  const routeSrc = readFileSync(path.join(root, 'app', 'api', 'outcome-reconciliation', 'route.ts'), 'utf8')
  assert.ok(routeSrc.includes('signal_label_outcome'), 'Q: label analytics read attributed signal_label_outcome')
  console.log('PASS Q: new analytics read signal_label_outcome (not the multi-writer legacy signals.outcome)')
}

// ── R — refresh idempotency: 1 setup_key → 1 row, unchanged on repeat
{
  const row = { setup_key: 'k9', prediction_outcome: 'WIN', execution_outcome: null, agreement_class: 'NOT_COMPARABLE', disagreement_reasons: [], contract_versions: {} }
  assert.equal(diffRefresh([row], []).inserted.length, 1)
  const again = diffRefresh([row], [row])
  assert.equal(again.unchanged.length, 1)
  assert.equal(again.inserted.length + again.updated.length, 0, 'R')
  console.log('PASS R: repeated refresh → one setup_key, one row, unchanged truth')
}

// ── sample-confidence bands
assert.equal(sampleConfidenceLabel(5), 'INSUFFICIENT_DATA')
assert.equal(sampleConfidenceLabel(30), 'LOW_CONFIDENCE')
assert.equal(sampleConfidenceLabel(60), 'MODERATE')
assert.equal(sampleConfidenceLabel(120), 'STRONG')
console.log('PASS : sample-confidence bands enforced (<20 insufficient … 100+ strong)')

console.log('\nAll execution-truth (Phase 4) tests passed.')

