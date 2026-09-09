// tests/profit-telemetry.test.mjs
// Durable shadow profit-protection telemetry — pure-module tests.
// Run: npm run test:profit-telemetry
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  toRow, rowKind, dedupeRows, zoneOf, closeSummaryFromRows, aggregateTrades, bestEffort,
} from '../lib/profit-telemetry.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const item = (over = {}) => ({
  ticket: 12345, tradeId: null, pair: 'XAU/USD', direction: 'BUY', lots: 0.14,
  openPrice: 2000, initialSl: 1997.5, currentPrice: 2002.1,
  currentProfit: 41, peakProfit: 60, plannedRiskUsd: 35, currentR: 1.17, peakR: 1.71,
  retainedPct: 0.6833, givebackPct: 0.3167, protectionStage: 'LOCK',
  targetFloorUsd: 39, proposedProtectionSl: 2002.79, currentLiveSl: 1998.0,
  existingManagerAction: 'ATR_TRAIL', shadowDecision: 'WOULD_MOVE_SL',
  action: 'ratchet-lock', actionAt: new Date().toISOString(), shadow: true,
  ...over,
})

// 1. Row construction — BUY/SELL fields + exact runtime R (no $50 assumption)
{
  const r = toRow(item(), { protectionMode: 'shadow', stateSeq: 42 })
  assert.equal(r.direction, 'BUY')
  assert.equal(r.planned_risk_usd, 35)
  // R values originate from trade-manager's exact runtime calc (60/35, 41/35)
  // and are persisted verbatim here:
  assert.equal(r.peak_r, 1.71)
  assert.equal(r.current_r, 1.17)
  assert.equal(r.protection_mode, 'shadow')
  assert.equal(r.row_kind, 'decision')
  assert.equal(r.shadow_command_emitted, false, 'shadow never emits commands')
  const s = toRow(item({ direction: 'SELL', proposedProtectionSl: 1997.21 }), { protectionMode: 'shadow' })
  assert.equal(s.direction, 'SELL')
  assert.equal(s.proposed_protection_sl, 1997.21)
  console.log('PASS : row construction (BUY/SELL) carries exact runtime risk/R; shadow_command_emitted=false')
}

// 2. row_kind classification — snapshot / decision / close
{
  assert.equal(rowKind(item({ action: null, shadowDecision: 'NONE' })), 'snapshot')
  assert.equal(rowKind(item({ shadowDecision: 'WOULD_MOVE_SL_TO_BE' })), 'decision')
  assert.equal(rowKind(item({ shadowDecision: 'EXISTING_DECAY_CLOSE', action: 'decay-close' })), 'close')
  console.log('PASS : lifecycle kind classification snapshot/decision/close')
}

// 3. Periodic snapshot dedupe — identical snapshots collapse; decisions always kept
{
  const base = new Date('2026-09-10T10:00:00Z').getTime()
  const snap = (stage, created, floor = 39) => ({ row_kind: 'snapshot', broker_ticket: '9', protection_stage: stage, shadow_decision: 'NONE', existing_manager_action: 'BE', target_floor_usd: floor, current_profit_usd: 44, created_at: new Date(created).toISOString() })
  const rows = [
    snap('LOCK', base),
    snap('LOCK', base + 10_000),                 // duplicate <30s → dropped
    snap('LOCK', base + 45_000),                 // >30s → kept
    { row_kind: 'decision', broker_ticket: '9', protection_stage: 'LOCK', shadow_decision: 'WOULD_MOVE_SL', existing_manager_action: 'ATR_TRAIL', target_floor_usd: 45, current_profit_usd: 50, created_at: new Date(base + 50_000).toISOString() },
    snap('STRONG', base + 90_000, 60),           // stage change → kept
  ]
  const out = dedupeRows(rows)
  assert.equal(out.filter((r) => r.row_kind === 'decision').length, 1, 'decision always kept')
  assert.equal(out.filter((r) => r.row_kind === 'snapshot').length, 3, 'duplicate snapshot collapsed')
  assert.ok(out.some((r) => r.protection_stage === 'STRONG'), 'stage-change snapshot kept')
  console.log('PASS : snapshot dedupe (30s window) keeps lifecycle, never drops decisions/closes')
}

// 4. Zone classification
{
  assert.equal(zoneOf(0.2), 'A')
  assert.equal(zoneOf(0.7), 'B')
  assert.equal(zoneOf(1.7), 'C')
  assert.equal(zoneOf(2.4), 'SR')
  console.log('PASS : zone classification A/B/C/SR')
}

// 5. Close summary — ACTUAL vs COUNTERFACTUAL distinguished; round-trip prevented
//    only when early rescue actually WOULD have triggered
{
  const rows = [
    { created_at: '2026-09-10T10:00:00Z', row_kind: 'decision', broker_ticket: '5', pair: 'XAU/USD', direction: 'SELL', shadow_decision: 'WOULD_MOVE_SL_TO_BE', protection_stage: 'EARLY_GIVEBACK_BE', target_floor_usd: 0, planned_risk_usd: 35, peak_profit_usd: 9 },
    { created_at: '2026-09-10T10:05:00Z', row_kind: 'close', broker_ticket: '5', pair: 'XAU/USD', direction: 'SELL', shadow_decision: 'EXISTING_PEAK_BE_CLOSE', protection_stage: 'EARLY_GIVEBACK_BE', target_floor_usd: 0, planned_risk_usd: 35, current_profit_usd: -2, peak_profit_usd: 9 },
  ]
  const s = closeSummaryFromRows(rows) // no broker overrides → decision-time source
  assert.equal(s.actualRealisedSource, 'decision-time')
  assert.equal(s.actualRealisedPnlUsd, -2)
  assert.equal(s.preventedRoundTripEst, true)
  assert.equal(s.estShadowPnlUsd, -1.5)
  assert.equal(s.estShadowSource, 'COUNTERFACTUAL / ESTIMATED')
  assert.equal(s.shadowCommandEmitted, false)
  console.log('PASS : ACTUAL vs EST clearly separated; early rescue = prevented round-trip (est only)')
}

// 6. Strong runner NOT clipped when it closed above the floor; below-floor est
{
  const rows = [
    { created_at: '2026-09-10T10:00:00Z', row_kind: 'decision', broker_ticket: '6', pair: 'XAU/USD', direction: 'SELL', shadow_decision: 'WOULD_MOVE_SL', protection_stage: 'EXCEPTIONAL', target_floor_usd: 110, planned_risk_usd: 35, peak_profit_usd: 146 },
    { created_at: '2026-09-10T10:10:00Z', row_kind: 'close', broker_ticket: '6', pair: 'XAU/USD', direction: 'SELL', shadow_decision: 'EXISTING_DECAY_CLOSE', protection_stage: 'EXCEPTIONAL', target_floor_usd: 110, planned_risk_usd: 35, current_profit_usd: 127, peak_profit_usd: 146 },
  ]
  const s = closeSummaryFromRows(rows, { actualRealisedPnlUsd: 127.74, actualMfeUsd: 146.43 })
  assert.equal(s.actualRealisedSource, 'broker')
  assert.equal(s.estShadowPnlUsd, 127.74, 'strong runner not clipped (actual > floor)')
  assert.equal(s.clippedEst, false)
  const low = closeSummaryFromRows([
    { ...rows[0], target_floor_usd: 39, protection_stage: 'LOCK' },
    { ...rows[1], current_profit_usd: 9, target_floor_usd: 39, protection_stage: 'LOCK' },
  ])
  assert.equal(low.estShadowPnlUsd, Math.round(39 * 0.95 * 100) / 100, 'below-floor winner gets floor x0.95 estimate')
  console.log('PASS : strong runners not clipped when actual > floor; below-floor winners get floor x0.95 est')
}

// 7. Aggregate — zones, round-trips, splits, financial delta
{
  const mk = (ticket, pl, mfe, dir, zonePeakR) => ({
    brokerTicket: String(ticket), pair: 'XAU/USD', direction: dir, zone: zoneOf(zonePeakR),
    actualRealisedPnlUsd: pl, actualMfeUsd: mfe, actualCaptureEfficiency: pl / mfe,
    estShadowPnlUsd: pl, estShadowCaptureEfficiency: pl / mfe, riskUsd: 35,
    clippedEst: false, preventedRoundTripEst: false,
  })
  const agg = aggregateTrades([
    mk(1, -32, 7.05, 'SELL', 0.2),
    mk(2, 8.91, 21.27, 'SELL', 0.6),
    mk(3, 127.74, 146.43, 'SELL', 4.2),
    mk(4, 17.72, 32.83, 'BUY', 0.94),
  ])
  assert.equal(agg.tradeCount, 4)
  assert.equal(agg.buySellSplit.sell, 3)
  assert.equal(agg.zones.SR, 1)
  assert.equal(agg.zones.B, 2)
  assert.equal(agg.actual.roundTrips, 1)
  assert.equal(agg.shadow.estimatedDeltaUsd, 0, 'identical est (no shadow rows) → delta 0')
  console.log('PASS : sample aggregate (zones, round-trips, splits, delta)')
}

// 8. Best-effort write failure never throws into the trading path
{
  let logged = null
  assert.equal(await bestEffort(() => Promise.resolve('written'), (e) => { logged = e.message }), true)
  const ok2 = await bestEffort(() => Promise.reject(new Error('table missing')), (e) => { logged = e.message })
  assert.equal(ok2, false)
  assert.equal(logged, 'table missing')
  console.log('PASS : telemetry write failure is swallowed + logged — trading path untouched')
}

// 9. Fixed USD Target = 0 unrelated (no fixed-USD coupling in this module)
{
  const src = readFileSync(path.join(root, 'lib', 'profit-telemetry.mjs'), 'utf8')
  assert.ok(!/fixedUsd|profitCloseAmount|fixedProfitUsd/.test(src))
  console.log('PASS : FIXED USD TARGET = 0 unrelated to telemetry module')
}

console.log('\nAll profit-telemetry tests passed.')

