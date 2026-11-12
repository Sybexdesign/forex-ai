// tests/reconciliation-repair.test.mjs
// Phase 4.1D — outcome reconciliation: legacy CLOSED matching, lineage-first
// disambiguation, ambiguity preservation, and source immutability.
// Run: npm run test:reconciliation-repair
import assert from 'node:assert/strict'
import { linkRecords } from '../lib/outcome-linkage.mjs'

const PRED = {
  id: 'p1', user_id: 'u1', pair: 'XAU/USD', direction: 'SELL',
  outcome: 'WIN', created_at: '2026-11-12T02:32:00.000Z',
  candle_close_time: '2026-11-12T02:30:00.000Z', entry: 3987.05,
}

// ── A — legacy result='CLOSED' is now LINKABLE (it used to be discarded) ────
{
  const out = linkRecords({
    predictions: [PRED],
    trades: [{
      id: 't1', user_id: 'u1', pair: 'XAU/USD', direction: 'SELL',
      result: 'CLOSED', trade_status: 'CLOSED', pl_usd: null,
      opened_at: '2026-11-12T02:32:20.000Z', closed_at: '2026-11-12T02:36:05.000Z',
    }],
  })
  const r = out.records[0]
  assert.equal(r.execution_id, 't1', 'A: the legacy CLOSED row is associated')
  assert.equal(r.execution, null, 'A: profitability is NOT comparable — null, not LOSS')
  assert.equal(r.executionOutcomeRaw, 'UNKNOWN', 'A: explicitly UNKNOWN')
  assert.equal(out.ambiguousSkipped.execution, 0, 'A: not counted as ambiguous')
  assert.equal(out.linkedCounts.execution, 1, 'A: counted as linked')
  console.log("PASS A: result='CLOSED' is associated but never becomes WIN/LOSS")
}

// ── B — a CLOSED row WITH broker P&L does get a profitability ───────────────
{
  const out = linkRecords({
    predictions: [PRED],
    trades: [{
      id: 't2', user_id: 'u1', pair: 'XAU/USD', direction: 'SELL',
      result: 'CLOSED', trade_status: 'CLOSED', pl_usd: 3368.5,
      opened_at: '2026-11-12T02:32:20.000Z', closed_at: '2026-11-12T02:36:05.000Z',
    }],
  })
  assert.equal(out.records[0].execution, 'WIN', 'B: derived from realised P&L')
  assert.equal(out.records[0].executionPnl, 3368.5, 'B')
  console.log('PASS B: CLOSED + broker P&L ⇒ correct profitability')
}

// ── C — canonical trade_result outranks the legacy result ──────────────────
{
  const out = linkRecords({
    predictions: [PRED],
    trades: [{
      id: 't3', user_id: 'u1', pair: 'XAU/USD', direction: 'SELL',
      result: 'LOSS', trade_status: 'CLOSED', trade_result: 'WIN', pl_usd: -1,
      opened_at: '2026-11-12T02:32:20.000Z', closed_at: '2026-11-12T02:36:05.000Z',
    }],
  })
  assert.equal(out.records[0].execution, 'WIN', 'C: trade_result is authoritative')
  console.log('PASS C: canonical trade_result wins over legacy result')
}

// ── D — two same-direction trades no longer kill every link ────────────────
{
  // A genuine ambiguity: BOTH trades open within ±5 min of the prediction.
  // (Note: the real 02:25 vs 02:32 pair is NOT ambiguous — see test H — because
  // they belong to two different predictions 7 minutes apart.)
  const PRED2 = { ...PRED, created_at: '2026-11-12T02:30:00.000Z', candle_close_time: '2026-11-12T02:30:00.000Z' }
  const out = linkRecords({
    predictions: [PRED2],
    trades: [
      { id: 'a', user_id: 'u1', pair: 'XAU/USD', direction: 'SELL', result: 'LOSS',
        opened_at: '2026-11-12T02:29:00.000Z', closed_at: '2026-11-12T02:31:00.000Z', pl_usd: -175.5 },
      { id: 'b', user_id: 'u1', pair: 'XAU/USD', direction: 'SELL', result: 'WIN',
        opened_at: '2026-11-12T02:31:00.000Z', closed_at: '2026-11-12T02:36:05.000Z', pl_usd: 3368.5 },
    ],
  })
  assert.equal(out.records[0].execution, null, 'D: no arbitrary pick between two candidates')
  assert.equal(out.records[0].execution_id, null, 'D: association is withheld')
  assert.equal(out.ambiguousSkipped.execution, 1, 'D: counted as ambiguous')
  assert.equal(out.ambiguities.length, 1, 'D: the ambiguity is reported')
  assert.equal(out.ambiguities[0].reason, 'MULTIPLE_CANDIDATE_EXECUTIONS', 'D')
  assert.deepEqual([...out.ambiguities[0].candidates].sort(), ['a', 'b'], 'D: candidates preserved')
  console.log('PASS D: same-direction ambiguity is preserved, never guessed')
}

// ── E — explicit lineage resolves what time proximity cannot ───────────────
{
  const PRED2 = { ...PRED, created_at: '2026-11-12T02:30:00.000Z', candle_close_time: '2026-11-12T02:30:00.000Z' }
  const out = linkRecords({
    predictions: [PRED2],
    trades: [
      { id: 'a', user_id: 'u1', pair: 'XAU/USD', direction: 'SELL', result: 'LOSS',
        prediction_log_id: null, opened_at: '2026-11-12T02:29:00.000Z', closed_at: '2026-11-12T02:31:00.000Z', pl_usd: -175.5 },
      { id: 'b', user_id: 'u1', pair: 'XAU/USD', direction: 'SELL', result: 'WIN',
        prediction_log_id: PRED2.id, opened_at: '2026-11-12T02:31:00.000Z', closed_at: '2026-11-12T02:36:05.000Z', pl_usd: 3368.5 },
    ],
  })
  assert.equal(out.records[0].execution_id, 'b', 'E: the lineage-bearing trade wins')
  assert.equal(out.records[0].executionMatch, 'prediction_log_id', 'E: method recorded')
  assert.equal(out.records[0].execution, 'WIN', 'E: and it is the profitable one')
  assert.equal(out.ambiguousSkipped.execution, 0, 'E: lineage removes the ambiguity')
  console.log('PASS E: explicit prediction_log_id resolves the ambiguity deterministically')
}

// ── F — multiple trades claiming ONE prediction stay ambiguous ─────────────
{
  const out = linkRecords({
    predictions: [PRED],
    trades: [
      { id: 'x', user_id: 'u1', pair: 'XAU/USD', direction: 'SELL', result: 'WIN',
        prediction_log_id: 'p1', opened_at: '2026-11-12T02:32:20.000Z', pl_usd: 100 },
      { id: 'y', user_id: 'u1', pair: 'XAU/USD', direction: 'SELL', result: 'LOSS',
        prediction_log_id: 'p1', opened_at: '2026-11-12T02:33:20.000Z', pl_usd: -50 },
    ],
  })
  assert.equal(out.records[0].execution_id, null, 'F: two trades really did share one prediction')
  assert.equal(out.ambiguities[0].reason, 'MULTIPLE_LINEAGE_MATCHES', 'F')
  console.log('PASS F: one prediction → many trades is reported, not collapsed')
}

// ── G — opposite direction is never a candidate ────────────────────────────
{
  const out = linkRecords({
    predictions: [PRED],
    trades: [{ id: 'buy', user_id: 'u1', pair: 'XAU/USD', direction: 'BUY', result: 'WIN',
      opened_at: '2026-11-12T02:32:20.000Z', pl_usd: 500 }],
  })
  assert.equal(out.records[0].execution_id, null, 'G: direction mismatch excluded')
  assert.equal(out.ambiguousSkipped.execution, 0, 'G')
  console.log('PASS G: opposite-direction trades are never matched')
}

// ── H — the real 12 Nov pair is NOT ambiguous (different predictions) ──────
{
  // Production: two predictions 7 minutes apart, each with its own trade.
  // Neither trade falls inside the other's ±5 min window, so both link.
  const out = linkRecords({
    predictions: [
      { id: 'pa', user_id: 'u1', pair: 'XAU/USD', direction: 'SELL', outcome: 'LOSS',
        created_at: '2026-11-12T02:25:23.236Z', candle_close_time: '2026-11-12T02:20:00.000Z', entry: 3988.69 },
      { id: 'pb', user_id: 'u1', pair: 'XAU/USD', direction: 'SELL', outcome: 'WIN',
        created_at: '2026-11-12T02:32:14.543Z', candle_close_time: '2026-11-12T02:30:00.000Z', entry: 3987.05 },
    ],
    trades: [
      { id: 't1953', user_id: 'u1', pair: 'XAU/USD', direction: 'SELL', result: 'LOSS',
        opened_at: '2026-11-12T02:25:34.925Z', closed_at: '2026-11-12T02:27:00.759Z', pl_usd: -175.5 },
      { id: 't8505', user_id: 'u1', pair: 'XAU/USD', direction: 'SELL', result: 'WIN',
        opened_at: '2026-11-12T02:32:20.557Z', closed_at: '2026-11-12T02:36:05.511Z', pl_usd: 3368.5 },
    ],
  })
  const byPred = Object.fromEntries(out.records.map((r) => [r.prediction_log_id, r]))
  assert.equal(byPred.pa.execution_id, 't1953', 'H: 02:25 prediction → ticket 3454451953')
  assert.equal(byPred.pa.execution, 'LOSS', 'H')
  assert.equal(byPred.pb.execution_id, 't8505', 'H: 02:32 prediction → ticket 3454458505')
  assert.equal(byPred.pb.execution, 'WIN', 'H')
  assert.equal(out.ambiguousSkipped.execution, 0, 'H: no ambiguity in the real pair')
  console.log('PASS H: the real 12 Nov pair links one-to-one, with no ambiguity')
}

// ── I — source tables are never mutated ────────────────────────────────────
{
  const predictions = [Object.freeze({ ...PRED })]
  const trades = Object.freeze([
    Object.freeze({ id: 't', user_id: 'u1', pair: 'XAU/USD', direction: 'SELL',
      result: 'CLOSED', pl_usd: 10, opened_at: '2026-11-12T02:32:20.000Z' }),
  ])
  assert.doesNotThrow(() => linkRecords({ predictions, trades }), 'I: frozen inputs are safe')
  assert.equal(trades[0].result, 'CLOSED', 'I: the source trade is untouched')
  assert.equal(trades[0].trade_result, undefined, 'I: no field is injected into the source')
  console.log('PASS I: linkage never mutates source records')
}

// ── J — the setup key is stable, so a refresh updates rather than duplicates ─
{
  const a = linkRecords({ predictions: [PRED], trades: [] })
  const b = linkRecords({ predictions: [PRED], trades: [
    { id: 't', user_id: 'u1', pair: 'XAU/USD', direction: 'SELL', result: 'WIN',
      opened_at: '2026-11-12T02:32:20.000Z', pl_usd: 100 },
  ] })
  assert.equal(a.records[0].setupKey, b.records[0].setupKey, 'J: same setup_key before and after execution arrives')
  assert.equal(b.records[0].execution, 'WIN', 'J: the record gained its execution')
  console.log('PASS J: execution arriving later updates the SAME row (no duplicate)')
}

console.log('\nreconciliation-repair: 10/10 groups passed')

