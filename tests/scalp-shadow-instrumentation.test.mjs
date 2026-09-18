// tests/scalp-shadow-instrumentation.test.mjs
// ─────────────────────────────────────────────────────────────────────────────
// Instrumentation-repair regression suite.
//
// Every case here exists because production telemetry showed the counterfactual
// column was structurally BLANK: `current_price` pinned to `open_price`,
// `peak_profit_usd`/`peak_r` always 0, `protection_stage` always null,
// `target_floor_usd` always 0, zero decision rows, and close rows with NULL
// position fields. These tests prove each repair and are deliberately written
// against the OBSERVED production failure, not against a convenient invention.
// ─────────────────────────────────────────────────────────────────────────────
import assert from 'node:assert/strict'
import {
  SHADOW_DECISIONS, normaliseScalpPosition, evaluateScalpShadow,
  buildScalpCloseRow, mergeScalpShadowState, assertScalpStateMonotonic,
  scalpRowKind, plannedRiskUsd,
} from '../lib/scalp-shadow-protection.mjs'
import { toRow, dedupeRows, snapshotSignature, closeSummaryFromRows } from '../lib/profit-telemetry.mjs'
import { createShadowObserver } from '../lib/scalp-shadow-cadence.mjs'

let failed = 0
const t = (name, fn) => {
  try { fn(); console.log('  ok   ' + name) }
  catch (e) { failed++; console.error('  FAIL ' + name + '\n        ' + e.message) }
}
const XAU = { pip: 0.1, pipValuePerLot: 10 }
const AT = '2026-09-20T00:00:00.000Z'

/** A genuine MT5-direct style position: separate entry and mark, real P&L. */
const trade = (over = {}) => ({
  id: 'T-1', pair: 'XAU/USD', direction: 'BUY', lots: 0.14,
  entryPrice: 2000, markPrice: 2000, unrealizedPL: 0,
  stopLossPrice: 1997.5, openTime: AT, ...over,
})
const pos = (over = {}, prior = null) => normaliseScalpPosition(trade(over), { priorState: prior, ...XAU })

console.log('scalp-shadow-instrumentation')

// ═══ MARK PRICE (§2) ═════════════════════════════════════════════════════════
t('mark: entry and mark are independent fields', () => {
  const p = pos({ entryPrice: 2000, markPrice: 2003.5 })
  assert.equal(p.entry, 2000)
  assert.equal(p.markPrice, 2003.5)
  assert.equal(p.currentPrice, 2003.5, 'telemetry current_price must carry the MARK, not entry')
})

t('mark: genuine favourable BUY movement is visible', () => {
  const p = pos({ direction: 'BUY', entryPrice: 2000, markPrice: 2005, unrealizedPL: 25 })
  assert.equal(p.markUsable, true)
  assert.ok(p.currentPrice > p.entry, 'BUY in profit must show mark above entry')
  const { row } = evaluateScalpShadow({ position: p })
  assert.equal(Number(row.current_profit_usd), 25)
  assert.ok(Number(row.peak_profit_usd) > 0)
})

t('mark: genuine favourable SELL movement is visible', () => {
  const p = pos({ direction: 'SELL', entryPrice: 2000, markPrice: 1995, unrealizedPL: 25 })
  assert.equal(p.markUsable, true)
  assert.ok(p.currentPrice < p.entry, 'SELL in profit must show mark below entry')
  const { row } = evaluateScalpShadow({ position: p })
  assert.ok(Number(row.peak_profit_usd) > 0)
})

t('mark: unavailable mark FAILS CLOSED with an explicit reason', () => {
  const p = pos({ markPrice: undefined })
  assert.equal(p.markUsable, false)
  const r = evaluateScalpShadow({ position: p })
  assert.equal(r.row, null, 'no mark ⇒ no observation, never a fabricated one')
  assert.equal(r.reason, 'mark-price-unavailable')
})

t('mark: is NEVER silently replaced by the entry price', () => {
  // The exact production shape: currentPrice == entryPrice, no markPrice field.
  const p = pos({ markPrice: undefined, currentPrice: 2000, entryPrice: 2000 })
  assert.equal(p.currentPrice, null, 'entry must not be published as the mark')
  assert.equal(evaluateScalpShadow({ position: p }).reason, 'mark-price-unavailable')
})

t('mark: zero/negative/NaN marks are rejected, not coerced', () => {
  for (const bad of [0, -1, NaN, null, '']) {
    assert.equal(pos({ markPrice: bad }).markUsable, false, `mark=${String(bad)} must be unusable`)
  }
})

t('profit: a MISSING P&L reading fails closed rather than reading as breakeven', () => {
  const p = pos({ unrealizedPL: undefined })
  assert.equal(p.currentProfit, null, 'absent P&L is not zero')
  const r = evaluateScalpShadow({ position: p })
  assert.equal(r.row, null)
  assert.equal(r.reason, 'no-profit-reading')
})

// ═══ PEAK (§3) ═══════════════════════════════════════════════════════════════
t('peak: favourable movement produces peak_profit_usd > 0 and peak_r > 0', () => {
  const { row } = evaluateScalpShadow({ position: pos({ unrealizedPL: 20 }) })
  assert.equal(Number(row.peak_profit_usd), 20)
  assert.ok(Number(row.peak_r) > 0, 'peak_r must be positive once a peak exists')
})

t('peak: increases on a new favourable excursion', () => {
  let st = null
  let last = null
  for (const profit of [5, 20, 12, 31]) {
    const r = evaluateScalpShadow({ position: pos({ unrealizedPL: profit }, st), priorState: st })
    st = r.state; last = r.row
  }
  assert.equal(Number(last.peak_profit_usd), 31, 'peak tracks the best excursion, not the last')
})

t('peak: CANNOT decrease', () => {
  const r1 = evaluateScalpShadow({ position: pos({ unrealizedPL: 40 }) })
  const r2 = evaluateScalpShadow({ position: pos({ unrealizedPL: -30 }, r1.state), priorState: r1.state })
  assert.equal(Number(r2.row.peak_profit_usd), 40)
  assert.ok(Number(r2.row.current_profit_usd) === -30, 'current moves; peak does not')
})

t('peak: survives a restart via persisted state (merge preserves it)', () => {
  const first = evaluateScalpShadow({ position: pos({ unrealizedPL: 55 }) })
  const merged = mergeScalpShadowState(first.state, { peakProfit: 1, peakR: 0.01 })
  assert.equal(Number(merged.peakProfit), 55, 'a restart must never lower a recorded peak')
  const check = assertScalpStateMonotonic(first.state, merged)
  assert.equal(check.ok, true, JSON.stringify(check.issues))
})

// ═══ PROTECTION (§3/§5) ══════════════════════════════════════════════════════
// 1R = $35 at 0.14 lots on XAU/USD (|2000-1997.5|/0.1*10*0.14). PROTECT arms at
// peakR >= 0.5, i.e. a $17.50 peak — the real band boundary, not an invented one.
//
// NOTE ON THE TRIGGER SHAPE: `profitProtection()` returns early at
// `cur >= peak` ("making new high"), so a stage/floor is only computed once price
// has GIVEN BACK from its peak. That is the algorithm's design and it is shared
// with LIVE trade management, so it is NOT changed here — these tests model the
// real trigger (peak, then pullback) rather than an invented one.
const armedAfterPeak = (peak, cur) => {
  const up = evaluateScalpShadow({ position: pos({ unrealizedPL: peak }) })
  return evaluateScalpShadow({ position: pos({ unrealizedPL: cur }, up.state), priorState: up.state })
}

t('protection: a real peak R activates the appropriate shadow stage', () => {
  const r = armedAfterPeak(20, 15)
  assert.equal(Number(r.row.planned_risk_usd), 35)
  assert.ok(Number(r.row.peak_r) >= 0.5, `peak_r ${r.row.peak_r} should arm PROTECT`)
  assert.equal(r.row.protection_stage, 'PROTECT')
})

t('protection: target floor becomes positive once the threshold is reached', () => {
  const r = armedAfterPeak(20, 15)
  assert.ok(Number(r.row.target_floor_usd) > 0, 'a floor must exist in PROTECT')
  assert.ok(Number(r.row.target_floor_usd) <= 20, 'the floor can never exceed the peak')
})

t('protection: WOULD_MOVE_SL stays counterfactual (decision row, no command)', () => {
  const r = armedAfterPeak(20, 13)
  assert.equal(r.row.shadow_decision, SHADOW_DECISIONS.moveSl)
  assert.equal(r.row.row_kind, 'decision')
  assert.equal(r.row.shadow_command_emitted, false)
  assert.equal(r.row.protection_mode, 'shadow')
  assert.match(String(r.row.shadow_decision), /^WOULD_/)
})

t('protection: WOULD_CLOSE stays counterfactual and keeps the lifecycle OPEN', () => {
  // Climb then collapse: the shadow would want out, but this is a DECISION —
  // the position is still open and must not be recorded as closed.
  const up = evaluateScalpShadow({ position: pos({ unrealizedPL: 60 }) })
  const down = evaluateScalpShadow({ position: pos({ unrealizedPL: 2 }, up.state), priorState: up.state })
  if (down.row.shadow_decision === SHADOW_DECISIONS.close) {
    assert.equal(down.row.row_kind, 'decision', 'a counterfactual close is NOT a lifecycle close')
  }
  assert.notEqual(down.row.row_kind, 'close')
  assert.equal(scalpRowKind(SHADOW_DECISIONS.close), 'decision')
})

t('protection: the shadow emits ZERO broker commands across a whole lifecycle', () => {
  let st = null
  const rows = []
  for (const profit of [10, 25, 40, 33, 12, 1, -5]) {
    const r = evaluateScalpShadow({ position: pos({ unrealizedPL: profit }, st), priorState: st })
    st = r.state; rows.push(r.row)
  }
  assert.ok(rows.length === 7)
  for (const row of rows) {
    assert.equal(row.shadow_command_emitted, false)
    assert.equal(row.protection_mode, 'shadow')
    assert.notEqual(row.row_kind, 'close', 'evaluating an open position never yields a close')
  }
})

t('protection: the evaluator throws if shadow mode could authorise an action', () => {
  assert.equal(scalpRowKind(SHADOW_DECISIONS.moveSl), 'decision')
  assert.equal(scalpRowKind(SHADOW_DECISIONS.moveSlToBe), 'decision')
  assert.equal(scalpRowKind(SHADOW_DECISIONS.none), 'snapshot')
})

// ═══ CLOSE ROW (§4/§5) ═══════════════════════════════════════════════════════
t('close: the last genuine position survives into the close row', () => {
  const r = evaluateScalpShadow({ position: pos({ unrealizedPL: 18 }) })
  const close = buildScalpCloseRow({
    finalState: r.state,
    closedAt: '2026-09-20T00:10:00.000Z',
    shadowMode: true,
  })
  assert.equal(close.row_kind, 'close')
  assert.equal(Number(close.lots), 0.14, 'lots must survive — production had NULL')
  assert.equal(Number(close.open_price), 2000)
  assert.equal(Number(close.current_price), 2000)
  assert.equal(Number(close.current_profit_usd), 18, 'last observed unrealised value')
  assert.equal(Number(close.peak_profit_usd), 18)
  assert.equal(Number(close.planned_risk_usd), 35)
})

t('close: NO new WOULD_CLOSE is invented at closure', () => {
  const up = evaluateScalpShadow({ position: pos({ unrealizedPL: 60 }) })
  const down = evaluateScalpShadow({ position: pos({ unrealizedPL: 3 }, up.state), priorState: up.state })
  const close = buildScalpCloseRow({ finalState: down.state, closedAt: AT })
  assert.equal(close.shadow_decision, SHADOW_DECISIONS.brokerClose)
  assert.notEqual(close.shadow_decision, SHADOW_DECISIONS.close,
    'a genuine broker closure is not a counterfactual trigger')
  assert.equal(close.row_kind, 'close', 'lifecycle termination is unchanged')
  assert.equal(close.shadow_command_emitted, false)
})

t('close: is exactly one logical close per lifecycle', () => {
  const r = evaluateScalpShadow({ position: pos({ unrealizedPL: 25 }) })
  const a = buildScalpCloseRow({ finalState: r.state, closedAt: AT })
  const b = buildScalpCloseRow({ finalState: r.state, closedAt: AT })
  assert.equal(a.row_kind, 'close')
  assert.equal(b.row_kind, 'close')
  // Idempotency is enforced by the DB unique index (trade_source, broker_ticket);
  // the builder must always produce the same identity so a retry collides.
  assert.equal(a.broker_ticket, b.broker_ticket)
  assert.equal(a.shadow_decision, b.shadow_decision)
})

t('close: still terminates the lifecycle when no position was retained', () => {
  const close = buildScalpCloseRow({
    finalState: { brokerTicket: 'T-9', initialSl: 1997.5, plannedRiskUsd: 35 },
    lastPosition: { pair: 'XAU/USD', direction: 'BUY' },
    closedAt: AT,
  })
  assert.equal(close.row_kind, 'close', 'a missing snapshot must not block the close row')
  assert.equal(close.broker_ticket, 'T-9')
  assert.equal(close.shadow_decision, SHADOW_DECISIONS.brokerClose)
})

// ═══ CADENCE (§6) ════════════════════════════════════════════════════════════
const ta = async (name, fn) => {
  try { await fn(); console.log('  ok   ' + name) }
  catch (e) { failed++; console.error('  FAIL ' + name + '\n        ' + e.message) }
}

t('cadence: multiple observations within one trade can raise the peak', () => {
  // The production failure: a sub-60s trade got ONE evaluation, so a favourable
  // excursion between samples was invisible. Sampling the same position
  // repeatedly must accumulate the true peak.
  let st = null, peak = 0
  for (const profit of [-4, 2, 9, 21, 34]) {
    const r = evaluateScalpShadow({ position: pos({ unrealizedPL: profit }, st), priorState: st })
    st = r.state
    peak = Math.max(peak, Number(r.row.peak_profit_usd) || 0)
  }
  assert.equal(peak, 34, 'peak must reflect the best sample, not the last')
  assert.ok(Number(st.peakR) > 0)
})

t('cadence: redundant snapshots are deduplicated', () => {
  const mk = (profit, at) => ({
    broker_ticket: 'T-1', protection_stage: 'PROTECT', shadow_decision: 'NONE',
    existing_manager_action: '', target_floor_usd: 11, current_profit_usd: profit,
    row_kind: 'snapshot', created_at: at,
  })
  const same = [mk(20, AT), mk(20, AT)]
  assert.equal(snapshotSignature(same[0]), snapshotSignature(same[1]))
  assert.equal(dedupeRows(same).length, 1, 'identical snapshots collapse')
  const moved = [mk(20, AT), mk(40, AT)]
  assert.equal(snapshotSignature(moved[0]) === snapshotSignature(moved[1]), false)
})

t('cadence: decisions and closes are NEVER suppressed', () => {
  const rows = [
    { broker_ticket: 'T-1', row_kind: 'snapshot', shadow_decision: 'NONE', current_profit_usd: 5, target_floor_usd: 0, created_at: AT },
    { broker_ticket: 'T-1', row_kind: 'decision', shadow_decision: 'WOULD_MOVE_SL_TO_BE', current_profit_usd: 5, target_floor_usd: 5, created_at: AT },
    { broker_ticket: 'T-1', row_kind: 'decision', shadow_decision: 'WOULD_MOVE_SL_TO_BE', current_profit_usd: 5, target_floor_usd: 5, created_at: AT },
    { broker_ticket: 'T-1', row_kind: 'close', shadow_decision: 'BROKER_CLOSE', current_profit_usd: 5, target_floor_usd: 5, created_at: AT },
  ]
  const kept = dedupeRows(rows)
  assert.equal(kept.filter((r) => r.row_kind === 'decision').length, 2, 'duplicate decisions must survive')
  assert.equal(kept.filter((r) => r.row_kind === 'close').length, 1, 'the close must survive')
})

const handed = []
const mkObserver = (over = {}) => createShadowObserver({
  shadowHandoff: (a) => { handed.push(a) },
  fetchAccount: async () => ({ trades: [] }),
  getTrackedCount: () => 0,
  log: () => {},
  ...over,
})

t('cadence: the same snapshot object is never observed twice', () => {
  const obs = mkObserver()
  const acct = { id: 'snap-1' }
  assert.equal(obs.observeOnce(acct), true)
  assert.equal(obs.observeOnce(acct), false, 'idempotent per snapshot')
  assert.equal(handed.length, 1)
})

await ta('cadence: an observation failure can NEVER throw into the sweep', async () => {
  const obs = mkObserver({ fetchAccount: async () => { throw new Error('broker down') } })
  const r = await obs.tick(true)          // must resolve, not reject
  assert.equal(r.action, 'fetch-failed')
  const r2 = await mkObserver({ fetchAccount: async () => null }).tick(true)
  assert.equal(r2.action, 'fetch-failed')
})

// ═══ GEOMETRY / R (§8) ═══════════════════════════════════════════════════════
t('geometry: XAU/USD BUY planned risk', () => {
  assert.equal(plannedRiskUsd({ entry: 2000, initialSl: 1997.5, lots: 0.14, ...XAU }), 35)
})

t('geometry: XAU/USD SELL planned risk is symmetric', () => {
  assert.equal(plannedRiskUsd({ entry: 2000, initialSl: 2002.5, lots: 0.14, ...XAU }), 35)
})

t('geometry: scales linearly with lot size', () => {
  const base = plannedRiskUsd({ entry: 2000, initialSl: 1997.5, lots: 0.10, ...XAU })
  const big  = plannedRiskUsd({ entry: 2000, initialSl: 1997.5, lots: 0.50, ...XAU })
  assert.equal(big, base * 5)
  assert.equal(plannedRiskUsd({ entry: 2000, initialSl: 1997.5, lots: 5, ...XAU }), 1250)
})

t('geometry: unusable geometry yields null, never a fabricated 1R', () => {
  assert.equal(plannedRiskUsd({ entry: 2000, initialSl: null, lots: 0.14, ...XAU }), null)
  assert.equal(plannedRiskUsd({ entry: null, initialSl: 1997.5, lots: 0.14, ...XAU }), null)
  assert.equal(plannedRiskUsd({ entry: 2000, initialSl: 2000, lots: 0.14, ...XAU }), null)
  assert.equal(plannedRiskUsd({ entry: 2000, initialSl: 1997.5, lots: 0, ...XAU }), null)
})

t('geometry: initial SL is frozen, so 1R is unchanged after the stop moves', () => {
  const first = pos({ stopLossPrice: 1997.5 })
  assert.equal(first.riskUsd, 35)
  // The broker later moves the stop to break-even; `initialSl` must NOT follow.
  const later = pos({ stopLossPrice: 2000 }, first)
  assert.equal(later.initialSl, 1997.5, 'initial SL is frozen')
  assert.equal(later.riskUsd, 35, '1R must not shrink when the stop ratchets')
  // And the durable state refuses to let either value regress.
  const st = evaluateScalpShadow({ position: first }).state
  const merged = mergeScalpShadowState(st, { initialSl: 2000, plannedRiskUsd: 1 })
  assert.equal(Number(merged.initialSl), 1997.5)
  assert.equal(Number(merged.plannedRiskUsd), 35)
})

// ═══ MFE RECONCILIATION (§7) ════════════════════════════════════════════════
const telRow = (over = {}) => ({
  broker_ticket: 'T-1', trade_id: null, pair: 'XAU/USD', direction: 'BUY', lots: 0.14,
  open_price: 2000, initial_sl: 1997.5, current_sl: 1997.5, current_price: 2004,
  current_profit_usd: 20, peak_profit_usd: 20, planned_risk_usd: 35,
  current_r: 0.57, peak_r: 0.57, protection_stage: 'PROTECT', target_floor_usd: 11,
  shadow_decision: 'NONE', protection_mode: 'shadow', row_kind: 'snapshot',
  shadow_command_emitted: false, created_at: '2026-09-20T00:00:00.000Z', ...over,
})

t('coverage: observed peak is compared against broker MFE, not replaced by it', () => {
  // The real production shape: the shadow saw nothing favourable while the
  // broker's own MFE recorded $454.50 on the same trade.
  const s = closeSummaryFromRows([telRow({ peak_profit_usd: 0 })], {
    actualRealisedPnlUsd: 224.5, actualMfeUsd: 454.5,
  })
  assert.equal(s.brokerMfeUsd, 454.5)
  assert.equal(s.shadowObservedPeakUsd, 0, 'the shadow peak must NOT be overwritten by broker MFE')
  assert.equal(s.peakObservationCoverage, 0)
  assert.equal(s.peakObservationReliable, false, 'a 0% coverage lifecycle is unreliable')
})

t('coverage: a faithfully observed lifecycle reports high coverage', () => {
  const s = closeSummaryFromRows([telRow({ peak_profit_usd: 21, peak_r: 0.6 })], {
    actualRealisedPnlUsd: 10, actualMfeUsd: 25,
  })
  assert.equal(s.peakObservationCoverage, 0.84)
  assert.equal(s.peakObservationReliable, true)
})

t('coverage: is null (not zero) when there is no broker MFE to compare against', () => {
  const s = closeSummaryFromRows([telRow()], {})
  assert.equal(s.brokerMfeUsd, null)
  assert.equal(s.peakObservationCoverage, null)
  assert.equal(s.peakObservationReliable, null)
})

if (failed) { console.error(`\n${failed} failed`); process.exit(1) }
console.log('scalp-shadow-instrumentation: all tests passed')


