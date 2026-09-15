// tests/scalp-shadow-protection.test.mjs  (SMOKE — partial, see report)
import assert from 'node:assert/strict'
import { decisionFor, plannedRiskUsd, normaliseScalpPosition, evaluateScalpShadow } from '../lib/scalp-shadow-protection.mjs'

const XAU = { pip: 0.1, pipValuePerLot: 10 }
const trade = (o = {}) => ({ id: 'T-1', pair: 'XAU/USD', direction: 'BUY', lots: 0.14, entryPrice: 2000, currentPrice: 2000, unrealizedPL: 0, stopLossPrice: 1997.5, openTime: '2026-09-15T00:00:00.000Z', ...o })
const ev = (t, prior = null) => evaluateScalpShadow({ position: normaliseScalpPosition(t, { priorState: prior, ...XAU }), priorState: prior })

let bad = 0
const t = (n, f) => { try { f(); console.log('  ok  ' + n) } catch (e) { bad++; console.error('  FAIL ' + n + '\n       ' + e.message) } }

console.log('scalp-shadow-protection (smoke)')

t('1R = 25 pips x $10 x 0.14 = $35', () => assert.equal(plannedRiskUsd({ entry: 2000, initialSl: 1997.5, lots: 0.14, ...XAU }), 35))
t('1R symmetric BUY/SELL', () => {
  assert.equal(plannedRiskUsd({ entry: 2000, initialSl: 1997.5, lots: 0.14, ...XAU }),
               plannedRiskUsd({ entry: 2000, initialSl: 2002.5, lots: 0.14, ...XAU }))
})
t('1R scales with lots and SL distance', () => {
  assert.equal(plannedRiskUsd({ entry: 2000, initialSl: 1997.5, lots: 0.28, ...XAU }), 70)
  assert.equal(plannedRiskUsd({ entry: 2000, initialSl: 1995, lots: 0.14, ...XAU }), 70)
})
t('1R null when geometry unusable', () => {
  assert.equal(plannedRiskUsd({ entry: 2000, initialSl: null, lots: 0.14, ...XAU }), null)
  assert.equal(plannedRiskUsd({ entry: 2000, initialSl: 1997.5, lots: 0, ...XAU }), null)
})
t('no risk -> no row invented', () => {
  const r = ev(trade({ stopLossPrice: null }))
  assert.equal(r.row, null); assert.equal(r.reason, 'no-risk')
})
t('peak is monotonic', () => {
  const a = ev(trade({ currentPrice: 2001, unrealizedPL: 40 }))
  assert.equal(a.state.peakProfit, 40)
  const b = ev(trade({ currentPrice: 2000.5, unrealizedPL: 12 }), a.state)
  assert.equal(b.state.peakProfit, 40)
})
t('initial SL captured once (moved stop cannot restate 1R)', () => {
  const a = ev(trade())
  const b = normaliseScalpPosition(trade({ stopLossPrice: 1999.5 }), { priorState: a.state, ...XAU })
  assert.equal(b.initialSl, 1997.5); assert.equal(b.riskUsd, 35)
})
t('SHADOW SAFETY: row is always shadow + never emitted a command', () => {
  for (const p of [120, 60, 20, 8, 3, -35]) {
    const r = ev(trade({ currentPrice: 2002, unrealizedPL: p }))
    if (!r.row) continue
    assert.equal(r.row.protection_mode, 'shadow')
    assert.equal(r.row.shadow_command_emitted, false)
  }
})
t('a would-CLOSE scenario stays a non-close row', () => {
  const peak = ev(trade({ currentPrice: 2004, unrealizedPL: 120 }))
  const r = ev(trade({ currentPrice: 2000.1, unrealizedPL: 3 }), peak.state)
  assert.equal(r.row.shadow_command_emitted, false)
  assert.notEqual(r.row.row_kind, 'close')
})
t('decisionFor bridges to the MT5 telemetry vocabulary', () => {
  assert.equal(decisionFor('early-giveback-be', false), 'WOULD_MOVE_SL_TO_BE')
  assert.equal(decisionFor('ratchet-lock', false), 'WOULD_MOVE_SL')
  assert.equal(decisionFor('giveback-collapse-close', true), 'WOULD_CLOSE')
  assert.equal(decisionFor(null, false), 'NONE')
})
t('row uses the existing telemetry schema', () => {
  const r = ev(trade({ currentPrice: 2001.5, unrealizedPL: 21 }))
  for (const k of ['broker_ticket','pair','direction','lots','open_price','initial_sl','current_sl','current_price','current_profit_usd','peak_profit_usd','planned_risk_usd','current_r','peak_r','protection_stage','target_floor_usd','shadow_decision','protection_mode','row_kind','shadow_command_emitted']) {
    assert.ok(k in r.row, 'missing ' + k)
  }
  assert.equal(r.row.planned_risk_usd, 35)
})

if (bad) { console.error('\n' + bad + ' failed'); process.exit(1) }
console.log('scalp-shadow-protection: smoke tests passed')
