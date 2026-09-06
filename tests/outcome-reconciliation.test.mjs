// tests/outcome-reconciliation.test.mjs
// Phase 3 — outcome-engine reconciliation, agreement classes, disagreement
// diagnosis, lineage + immutability. Pure unit tests against the exact modules
// the API/backfill/UI consume (lib/outcome-reconciliation.mjs,
// lib/outcome-linkage.mjs, lib/outcome-contracts.mjs).
// Run: npm run test:phase3
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  AGREEMENT, MISMATCH, REASON, comparePair, classifyRecord, diagnose, summarize,
} from '../lib/outcome-reconciliation.mjs'
import { linkRecords } from '../lib/outcome-linkage.mjs'
import { OUTCOME_CONTRACTS, SIGNALS_OUTCOME_WRITERS } from '../lib/outcome-contracts.mjs'

const flags = { lateEntry: true, entryReanchored: true, slippage: true }

// ── Test A — full agreement → FULL_AGREEMENT
{
  const rec = { prediction: 'WIN', signalLabel: 'WIN', reconciliation: 'WIN', execution: 'WIN' }
  assert.equal(classifyRecord(rec), AGREEMENT.FULL, 'A: WIN×4 → FULL_AGREEMENT')
  assert.equal(comparePair('prediction|execution', 'WIN', 'WIN').agree, true)
  console.log('PASS A: full four-engine agreement → FULL_AGREEMENT')
}

// ── Test B — different horizon (recon WIN @5m vs pred LOSS @15m)
{
  const cmp = comparePair('prediction|reconciliation', 'LOSS', 'WIN')
  assert.equal(cmp.className, MISMATCH.HORIZON, 'B: TIME_HORIZON_DISAGREEMENT')
  assert.ok(cmp.reasons.includes(REASON.DIFFERENT_HORIZON), 'B: reason DIFFERENT_HORIZON')
  console.log('PASS B: 5-min recon WIN vs 15-min prediction LOSS → TIME_HORIZON_DISAGREEMENT')
}

// ── Test C — intracandle touch: candle high hits TP, close never reaches
{
  const cmp = comparePair('prediction|signalLabel', 'INCONCLUSIVE', 'WIN')
  assert.equal(cmp.className, MISMATCH.SAMPLING, 'C: SAMPLING_METHOD_DISAGREEMENT')
  for (const r of [REASON.INTRACANDLE_TOUCH, REASON.HIGH_LOW_SAMPLING, REASON.CLOSE_ONLY_SAMPLING]) {
    assert.ok(cmp.reasons.includes(r), `C: reason ${r}`)
  }
  console.log('PASS C: high-touch TP with close-only prediction → SAMPLING_METHOD_DISAGREEMENT')
}

// ── Test D — timeout difference (prediction INC, legacy label timeout LOSS)
{
  const cmp = comparePair('prediction|signalLabel', 'INCONCLUSIVE', 'LOSS')
  assert.equal(cmp.className, MISMATCH.TIMEOUT, 'D: TIMEOUT_RULE_DISAGREEMENT')
  assert.ok(cmp.reasons.includes(REASON.TIMEOUT_DIFFERENCE))
  console.log('PASS D: prediction timeout INCONCLUSIVE vs label timeout LOSS → TIMEOUT_RULE_DISAGREEMENT')
}

// ── Test E — prediction correct, execution loses
{
  const cmp = comparePair('prediction|execution', 'WIN', 'LOSS', flags)
  assert.equal(cmp.className, MISMATCH.PRED_VS_EXEC, 'E: PREDICTION_VS_EXECUTION_MISMATCH')
  assert.ok(cmp.reasons[0] === REASON.EXEC_MGMT, 'E: first reason EXECUTION_MANAGEMENT_DIVERGENCE')
  assert.ok(cmp.reasons.includes(REASON.LATE_EXECUTION) && cmp.reasons.includes(REASON.ENTRY_REANCHORED))
  assert.equal(classifyRecord({ prediction: 'WIN', signalLabel: 'WIN', reconciliation: 'WIN', execution: 'LOSS' }), AGREEMENT.DISAGREEMENT)
  console.log('PASS E: prediction WIN + execution LOSS → PREDICTION_VS_EXECUTION_MISMATCH + EXECUTION_MANAGEMENT_DIVERGENCE')
}

// ── Test F — prediction loses, execution profitable
{
  const cmp = comparePair('prediction|execution', 'LOSS', 'WIN', flags)
  assert.equal(cmp.className, MISMATCH.DIR_WRONG_TRADE_PROFITABLE, 'F: DIRECTION_WRONG_BUT_TRADE_PROFITABLE')
  assert.ok(cmp.reasons.length > 0, 'F: explanation provided')
  console.log('PASS F: prediction LOSS + execution WIN → DIRECTION_WRONG_BUT_TRADE_PROFITABLE (with explanation)')
}

// ── Test G — no execution → NOT_COMPARABLE (never "execution LOSS")
{
  const rec = { prediction: 'WIN', signalLabel: 'WIN', reconciliation: 'WIN', execution: null }
  assert.equal(classifyRecord(rec), AGREEMENT.NOT_COMPARABLE, 'G: no broker trade → NOT_COMPARABLE')
  const cmp = comparePair('prediction|execution', 'WIN', null)
  assert.equal(cmp.agree, null)
  assert.equal(cmp.className, AGREEMENT.NOT_COMPARABLE)
  console.log('PASS G: prediction resolved but no broker trade → NOT_COMPARABLE')
}

// ── Test H — partial data (missing reconciliation) → PARTIAL_DATA
{
  const rec = { prediction: 'WIN', signalLabel: 'WIN', reconciliation: null, execution: 'WIN' }
  assert.equal(classifyRecord(rec), AGREEMENT.PARTIAL_DATA, 'H: missing reconciliation → PARTIAL_DATA')
  console.log('PASS H: missing reconciliation → PARTIAL_DATA')
}


// ── Test I — multiple legacy signal writers: source attribution prevents ambiguity
{
  assert.deepEqual(SIGNALS_OUTCOME_WRITERS.sort(), ['LABEL_CRON', 'MANUAL', 'WORKER_TRACKER'].sort(),
    'I: signals.outcome is multi-writer (documented)')
  const label = linkRecords({
    predictions: [{ id: 'p1', user_id: 'u1', pair: 'XAU/USD', direction: 'BUY', outcome: 'WIN', created_at: '2026-09-04T20:15:05.000Z', candle_close_time: '2026-09-04T23:15:00.000Z', entry: 4431.7 }],
    signals: [{ id: 's1', user_id: 'u1', pair: 'XAU/USD', direction: 'BUY', outcome: 'WIN', outcome_source: 'LABEL_CRON', signal_label_outcome: 'WIN', signal_label_source: 'LABEL_CRON', created_at: '2026-09-04T20:41:00.000Z', candle_close_time: '2026-09-04T23:15:00.000Z' }],
  })
  assert.equal(label.records[0].signalLabel, 'WIN')
  assert.equal(label.records[0].signalLabelSource, 'LABEL_CRON')
  console.log('PASS I: signals.outcome multi-writer documented + label verdicts carry source attribution')
}

// ── Test J — one-to-one lineage (one decision → one canonical prediction record)
{
  const out = linkRecords({
    predictions: [
      { id: 'p1', user_id: 'u1', pair: 'XAU/USD', direction: 'BUY', outcome: 'WIN', created_at: '2026-09-04T20:15:05.000Z', candle_close_time: '2026-09-04T23:15:00.000Z', entry: 4431.7 },
      { id: 'p2', user_id: 'u1', pair: 'XAU/USD', direction: 'BUY', outcome: 'WIN', created_at: '2026-09-04T20:15:06.000Z', candle_close_time: '2026-09-04T23:15:00.000Z', entry: 4431.7 },
    ],
    signals: [
      { id: 's1', user_id: 'u1', pair: 'XAU/USD', direction: 'BUY', outcome: 'WIN', outcome_source: 'LABEL_CRON', signal_label_outcome: 'WIN', created_at: '2026-09-04T20:41:00.000Z', candle_close_time: '2026-09-04T23:15:00.000Z' },
      { id: 's2', user_id: 'u1', pair: 'XAU/USD', direction: 'BUY', outcome: 'WIN', outcome_source: 'WORKER_TRACKER', created_at: '2026-09-04T20:15:10.000Z', candle_close_time: '2026-09-04T23:15:00.000Z' },
    ],
  })
  assert.equal(out.records.length, 1, 'J: one canonical record per candle')
  assert.equal(out.records[0].prediction_log_id, 'p1', 'J: first prediction wins (no duplicate canonical prediction)')
  console.log('PASS J: one signal/setup → one canonical prediction record')
}

// ── Test K — immutability (comparison/diagnosis/summary never mutate sources)
{
  const rec = Object.freeze({ prediction: 'WIN', signalLabel: 'INCONCLUSIVE', reconciliation: 'WIN', execution: 'LOSS' })
  assert.doesNotThrow(() => { classifyRecord(rec, flags); diagnose(rec, flags); summarize([rec]) })
  console.log('PASS K: comparison/diagnosis/summary never mutate source records (frozen inputs safe)')
}

// ── Test L — expectancy isolation: canonical prediction source only
{
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const src = readFileSync(path.join(root, 'lib', 'expectancy-engine.ts'), 'utf8')
  assert.ok(src.includes(".from('prediction_logs')"), 'L: Expectancy reads prediction_logs only')
  assert.ok(!src.includes(".from('signal_reconciliation')"), 'L: Expectancy never reads signal_reconciliation')
  assert.ok(!src.includes(".from('signals')"), 'L: Expectancy never reads legacy signals.outcome')
  console.log('PASS L: Expectancy Engine uses canonical prediction_logs outcomes only (no mixed labels)')
}

// ── summarize/confusion-matrix sanity on a mixed set
{
  const records = [
    { prediction: 'WIN', signalLabel: 'WIN', reconciliation: 'WIN', execution: 'WIN' },
    { prediction: 'LOSS', signalLabel: 'LOSS', reconciliation: 'WIN', execution: null },
    { prediction: 'INCONCLUSIVE', signalLabel: 'WIN', reconciliation: null, execution: 'WIN' },
    { prediction: 'WIN', signalLabel: 'LOSS', reconciliation: 'WIN', execution: 'LOSS' },
  ]
  const s = summarize(records)
  assert.equal(s.records, 4)
  assert.ok(s.fourEngine.FULL_AGREEMENT >= 1)
  assert.ok(s.causes[REASON.EXEC_MGMT] >= 1)
  const matrix = s.matrices['Prediction ↔ Execution']
  assert.ok(matrix.rows.WIN, 'matrix has prediction WIN row')
  console.log('PASS : summarize() produces four-engine counts, pairwise + confusion matrices and causes')
}

console.log('\nAll outcome-reconciliation (Phase 3) tests passed.')
