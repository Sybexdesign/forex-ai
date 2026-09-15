// tests/scalp-shadow-close-semantics.test.mjs
// Item 1/2/4 — a counterfactual WOULD_CLOSE must never terminate a real
// lifecycle, and a runner that follows it must remain observable.
import assert from 'node:assert/strict'
import { scalpRowKind, SHADOW_DECISIONS, evaluateScalpShadow, normaliseScalpPosition } from '../lib/scalp-shadow-protection.mjs'
import { lifecycleOutcome, lifecycleOutcomesByTicket, clippingReport, buildReport, CLIP_MATERIAL_R } from '../lib/shadow-analysis.mjs'

let failed = 0
const t = (name, fn) => {
  try { fn(); console.log('  ok   ' + name) }
  catch (e) { failed++; console.error('  FAIL ' + name + '\n        ' + e.message) }
}

const mk = (over = {}) => ({
  broker_ticket: 'T-1', trade_id: 'db-1', pair: 'XAU/USD', direction: 'BUY', lots: 0.14,
  open_price: 2000, initial_sl: 1997.5, planned_risk_usd: 35,
  current_r: 0, peak_r: 0, current_profit_usd: 0, peak_profit_usd: 0,
  protection_stage: 'DEVELOP', target_floor_usd: 0,
  shadow_decision: 'NONE', protection_mode: 'shadow', row_kind: 'snapshot',
  shadow_command_emitted: false, created_at: '2026-09-15T00:00:00.000Z', ...over,
})
const at = (n) => `2026-09-15T00:${String(n).padStart(2, '0')}:00.000Z`

console.log('scalp-shadow-close-semantics')

// ── 1. WOULD_CLOSE is a decision, not a close ────────────────────────────────
t('item1: scalpRowKind maps WOULD_CLOSE to decision (open position)', () => {
  assert.equal(scalpRowKind(SHADOW_DECISIONS.close), 'decision')
  assert.equal(scalpRowKind(SHADOW_DECISIONS.moveSl), 'decision')
  assert.equal(scalpRowKind(SHADOW_DECISIONS.moveSlToBe), 'decision')
  assert.equal(scalpRowKind(SHADOW_DECISIONS.none), 'snapshot')
})

t('item1: WOULD_CLOSE requires ARMED protection; the evaluator never emits row_kind=close', () => {
  const XAU = { pip: 0.1, pipValuePerLot: 10 }
  const trade = { id: 'T-1', pair: 'XAU/USD', direction: 'BUY', lots: 0.14, entryPrice: 2000, currentPrice: 2000, unrealizedPL: 0, stopLossPrice: 1997.5, openTime: at(0) }
  const peaks = [40, 60, 80, 100, 150, 200, 250, 300]
  const curs  = [300, 200, 150, 120, 100, 80, 60, 50, 40, 30, 25, 20, 15, 12, 10, 8, 6, 5, 4, 3, 2, 1, 0, -5, -10, -20, -35]

  let unarmedCloses = 0
  let armedCloses = 0
  for (const peak of peaks) {
    for (const cur of curs) {
      if (cur > peak) continue
      // (a) UNARMED: no persisted stage/floor and the live SL is below entry, so
      // NO protection has ever been committed. A deep retracement here is a
      // polling gap, not a failure to protect — it must not close the trade.
      const unarmed = { peakProfit: peak }
      const pUn = normaliseScalpPosition({ ...trade, unrealizedPL: cur }, { priorState: unarmed, ...XAU })
      const rUn = evaluateScalpShadow({ position: pUn, priorState: unarmed, shadowMode: true })
      if (rUn.row) {
        assert.notEqual(rUn.row.row_kind, 'close', 'evaluateScalpShadow must NEVER emit close')
        if (rUn.row.shadow_decision === 'WOULD_CLOSE') unarmedCloses++
      }
      // (b) ARMED: a floor was persisted by an earlier cycle, so a breach IS a
      // genuine failure to protect and may request a close.
      const armed = { peakProfit: peak, retentionFloorUsd: 1, protectionStage: 'LOCK' }
      const pAr = normaliseScalpPosition({ ...trade, unrealizedPL: cur }, { priorState: armed, ...XAU })
      const rAr = evaluateScalpShadow({ position: pAr, priorState: armed, shadowMode: true })
      if (rAr.row) {
        assert.notEqual(rAr.row.row_kind, 'close', 'evaluateScalpShadow must NEVER emit close')
        if (rAr.row.shadow_decision === 'WOULD_CLOSE') {
          armedCloses++
          assert.equal(rAr.row.row_kind, 'decision', 'an open position must emit decision')
        }
      }
    }
  }
  assert.equal(unarmedCloses, 0, 'an unarmed trade must never be closed by the collapse rule (polling-gap fix)')
  assert.ok(armedCloses > 0, 'an armed trade MUST still be closable when its committed floor is breached')
})


// ── 4. Lifecycle behaviour ───────────────────────────────────────────────────
t('item4: WOULD_CLOSE while open → decision, lifecycle stays open', () => {
  const out = lifecycleOutcome([
    mk({ created_at: at(1), current_r: 0.8,  shadow_decision: 'WOULD_MOVE_SL', row_kind: 'decision' }),
    mk({ created_at: at(2), current_r: 0.45, shadow_decision: 'WOULD_CLOSE',   row_kind: 'decision' }),
  ])
  assert.equal(out.lifecycleOpen, true, 'lifecycle must remain open')
  assert.equal(out.realLifecycleTerminatedByWouldClose, false)
  assert.equal(out.firstWouldClose.rAtWouldClose, 0.45)
})

t('item4: snapshots after WOULD_CLOSE stay in the SAME lifecycle', () => {
  const out = lifecycleOutcome([
    mk({ created_at: at(1), current_r: 0.45, shadow_decision: 'WOULD_CLOSE', row_kind: 'decision' }),
    mk({ created_at: at(2), current_r: 0.9 }),
    mk({ created_at: at(3), current_r: 1.5 }),
  ])
  assert.equal(out.rowCount, 3)
  assert.equal(out.lifecycleOpen, true)
  assert.equal(out.postWouldCloseMaxR, 1.5, 'later snapshots must be part of this trajectory')
})

t('item4: multiple WOULD_CLOSE evaluations do not create multiple closes', () => {
  const out = lifecycleOutcome([
    mk({ created_at: at(1), current_r: 0.4, shadow_decision: 'WOULD_CLOSE', row_kind: 'decision' }),
    mk({ created_at: at(2), current_r: 0.5, shadow_decision: 'WOULD_CLOSE', row_kind: 'decision' }),
    mk({ created_at: at(3), current_r: 0.6, shadow_decision: 'WOULD_CLOSE', row_kind: 'decision' }),
  ])
  assert.equal(out.wouldCloseCount, 3, 'each evaluation is recorded')
  assert.equal(out.firstWouldClose.rAtWouldClose, 0.4, 'only the FIRST is retained as the event')
  assert.equal(out.lifecycleOpen, true, 'still exactly ONE open lifecycle')
  assert.equal(out.actualClose, null, 'no close row exists')
})

t('item4: runner recovery 0.8R → WOULD_CLOSE → 1.5R → 2.5R → actual close', () => {
  const out = lifecycleOutcome([
    mk({ created_at: at(1), current_r: 0.8,  peak_r: 0.8, shadow_decision: 'WOULD_MOVE_SL', row_kind: 'decision' }),
    mk({ created_at: at(2), current_r: 0.45, peak_r: 0.8, shadow_decision: 'WOULD_CLOSE',   row_kind: 'decision', target_floor_usd: 18 }),
    mk({ created_at: at(3), current_r: 1.5,  peak_r: 1.5 }),
    mk({ created_at: at(4), current_r: 2.5,  peak_r: 2.5 }),
    mk({ created_at: at(5), current_r: 2.0,  peak_r: 2.5, current_profit_usd: 70, shadow_decision: 'WOULD_CLOSE', row_kind: 'close', target_floor_usd: 60 }),
  ])
  assert.equal(out.lifecycleOpen, false, 'the confirmed close ends the lifecycle')
  assert.equal(out.firstWouldClose.rAtWouldClose, 0.45)
  assert.equal(out.firstWouldClose.profitAtWouldClose, 0)
  assert.equal(out.firstWouldClose.targetFloorUsd, 18)
  assert.equal(out.firstWouldClose.peakRAtWouldClose, 0.8, 'peak at the moment of the would-close')
  // Only the counterfactual event counts. The close row also carries
  // shadow_decision='WOULD_CLOSE', but it is a REAL closure and is deliberately
  // excluded from the would-close EVENTS — counting it would double-count the
  // same lifecycle end.
  assert.equal(out.wouldCloseCount, 1, 'only the counterfactual decision is a would-close event')
  assert.equal(out.postWouldCloseMaxR, 2.5, 'subsequent MFE must be visible')
  assert.equal(out.ranFurtherR, 2.05)
  assert.equal(out.actualClose.r, 2.0)
  assert.equal(out.actualClose.profitUsd, 70)
  assert.equal(out.clippedRunner, true, 'this is the clipping the study must detect')
})

t('item4: only a confirmed broker closure produces row_kind=close', () => {
  const out = lifecycleOutcome([
    mk({ created_at: at(1), current_r: 0.5, shadow_decision: 'WOULD_CLOSE', row_kind: 'decision' }),
    mk({ created_at: at(2), current_r: 1.0 }),
  ])
  assert.equal(out.actualClose, null)
  assert.equal(out.lifecycleOpen, true)
  assert.equal(out.clippedRunner, false, 'cannot be judged while still open')
})

t('item4: a would-close the trade never beat is NOT a clip', () => {
  const out = lifecycleOutcome([
    mk({ created_at: at(1), current_r: 1.0, shadow_decision: 'WOULD_CLOSE', row_kind: 'decision' }),
    mk({ created_at: at(2), current_r: 1.1, current_profit_usd: 38, shadow_decision: 'WOULD_CLOSE', row_kind: 'close' }),
  ])
  assert.ok(Math.abs(out.ranFurtherR - 0.1) < 1e-9, `expected 0.1, got ${out.ranFurtherR}`)
  assert.equal(out.clippedRunner, false, 'a 0.1R follow-through is below the materiality bar')
  assert.ok(CLIP_MATERIAL_R > 0.1)
})

t('item4: close idempotency — one actual close survives duplicate rows', () => {
  const rows = [
    mk({ created_at: at(1), current_r: 1.0, shadow_decision: 'NONE' }),
    mk({ created_at: at(2), current_r: 2.0, current_profit_usd: 70, shadow_decision: 'WOULD_CLOSE', row_kind: 'close' }),
  ]
  const out = lifecycleOutcome(rows)
  assert.equal(out.actualClose.r, 2.0)
  assert.equal(out.lifecycleOpen, false)
  // The DB partial unique index plus duplicate-key-as-success makes a second
  // close row impossible; if one ever appeared, the earliest would still win.
  const out2 = lifecycleOutcome([...rows, mk({ created_at: at(9), current_r: 2.0, shadow_decision: 'WOULD_CLOSE', row_kind: 'close' })])
  assert.equal(out2.actualClose.r, 2.0)
})

t('item4: clipping aggregates across tickets', () => {
  const rows = [
    mk({ created_at: at(1), current_r: 0.5, shadow_decision: 'WOULD_CLOSE', row_kind: 'decision' }),
    mk({ created_at: at(2), current_r: 2.5, current_profit_usd: 88, shadow_decision: 'WOULD_CLOSE', row_kind: 'close' }),
    mk({ broker_ticket: 'T-2', created_at: at(1), current_r: 0.5, shadow_decision: 'WOULD_CLOSE', row_kind: 'decision' }),
    mk({ broker_ticket: 'T-2', created_at: at(2), current_r: 0.4, current_profit_usd: -14, shadow_decision: 'WOULD_CLOSE', row_kind: 'close' }),
  ]
  const rep = clippingReport(lifecycleOutcomesByTicket(rows))
  assert.equal(rep.tradesObserved, 2)
  assert.equal(rep.tradesWithWouldClose, 2)
  assert.equal(rep.tradesClipped, 1, 'only the runner was clipped')
  assert.deepEqual(rep.clippedTickets, ['T-1'])
  assert.equal(rep.clipRate, 0.5)
  assert.equal(rep.lifecyclesClosed, 2)
  assert.equal(rep.lifecyclesOpen, 0)
})

// ── 3. CLI plumbing: buildReport must read the raw rows ──────────────────────
t('item3: buildReport(...) carries the clipping analysis from raw rows', () => {
  const rows = [
    mk({ created_at: at(1), current_r: 0.8, peak_r: 0.8, planned_risk_usd: 35, shadow_decision: 'WOULD_MOVE_SL', row_kind: 'decision' }),
    mk({ created_at: at(2), current_r: 0.45, peak_r: 0.8, planned_risk_usd: 35, shadow_decision: 'WOULD_CLOSE', row_kind: 'decision', target_floor_usd: 18 }),
    mk({ created_at: at(3), current_r: 1.5, peak_r: 1.5 }),
    mk({ created_at: at(4), current_r: 2.5, peak_r: 2.5 }),
    mk({ created_at: at(5), current_r: 2.0, peak_r: 2.5, current_profit_usd: 70, shadow_decision: 'WOULD_CLOSE', row_kind: 'close', target_floor_usd: 60 }),
  ]
  const r = buildReport([], { rows })
  assert.ok(r.clipping, 'clipping must be present when rows are supplied')
  const o = r.clipping.perTrade[0]
  assert.equal(o.pair, 'XAU/USD')
  assert.equal(o.direction, 'BUY')
  assert.equal(o.plannedRiskUsd, 35)
  assert.equal(o.firstWouldClose.rAtWouldClose, 0.45)
  assert.equal(o.firstWouldClose.profitAtWouldClose, 0)
  assert.equal(o.firstWouldClose.peakRAtWouldClose, 0.8)
  assert.equal(o.firstWouldClose.targetFloorUsd, 18)
  assert.equal(o.postWouldCloseMaxR, 2.5, 'post-WOULD_CLOSE maximum uses the WHOLE trajectory')
  assert.equal(o.ranFurtherR, 2.05)
  assert.equal(o.actualClose.profitUsd, 70)
  assert.equal(o.actualFinalR, 2.0, 'actual closure comes only from the genuine close row')
  assert.equal(o.lifecycleOpen, false)
  assert.equal(o.clippedRunner, true)
  assert.equal(r.clipping.tradesClipped, 1)
})

t('item3: without rows the clipping section is explicitly unavailable', () => {
  const r = buildReport([], {})
  assert.equal(r.clipping, null, 'must not fabricate a lifecycle from summaries')
})

// ── 4. Shadow safety must be prominent and non-maskable ──────────────────────
t('item4: a shadow command leak is reported CRITICAL and named', () => {
  const rows = [
    mk({ created_at: at(1), current_r: 1.0, shadow_command_emitted: false }),
    mk({ created_at: at(2), current_r: 2.0, current_profit_usd: 70, shadow_command_emitted: true }),
  ]
  const r = buildReport([{ brokerTicket: 'T-1', direction: 'BUY', actualRealisedPnlUsd: 70, estShadowPnlUsd: 70, actualMfeUsd: 70, riskUsd: 35, shadowCommandEmitted: true }], { rows })
  assert.equal(r.shadowSafety.shadowCommandEmittedCount, 1)
  assert.match(r.shadowSafety.verdict, /CRITICAL/)
  assert.deepEqual(r.shadowSafety.tickets, ['T-1'])
})

t('item4: a clean report still cannot claim safety from zero rows', () => {
  const r = buildReport([], { rows: [] })
  assert.equal(r.shadowSafety.shadowCommandEmittedCount, 0)
  assert.match(r.shadowSafety.verdict, /OK/)
  // The CLI's empty-report path states the vacuous-pass caveat; this asserts the
  // report itself never upgrades "no rows" into evidence.
  assert.equal(r.sample.tradeCount, 0)
  assert.equal(r.adequacy.adequate, false)
})

if (failed) { console.error(`\n${failed} failed`); process.exit(1) }
console.log('scalp-shadow-close-semantics: all tests passed')

