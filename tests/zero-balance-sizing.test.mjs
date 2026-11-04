// tests/zero-balance-sizing.test.mjs
// AUTO sizing with an unusable balance.
//
// Reported symptom: the MT5 EA is online but the account reports a 0.00 balance.
// The AUTO path used to end in `Math.max(0.01, …)`, so a zero risk budget
// (balance × risk%) silently became the MINIMUM LOT — an order sized from money
// the account does not have. The MANUAL path already refused an unusable balance
// (MANUAL_REJECT.BALANCE_INVALID); these assertions make AUTO agree with it.
//
// The funded-account floor is deliberately preserved: a tiny-but-real balance
// still rounds UP to 0.01 lots, because that is a broker minimum, not a guess.
import assert from 'node:assert/strict'
import { calcStandardPositionSize } from '../lib/brokers/interface'
import { MAX_LOTS } from '../lib/trade-levels'
import { planOrder, PLAN_REJECT } from '../lib/order-planner.mjs'

let failed = 0
const t = (name, fn) => {
  try { fn(); console.log('  ok   ' + name) }
  catch (e) { failed++; console.error('  FAIL ' + name + '\n        ' + e.message) }
}

console.log('zero-balance sizing')

t('balance 0 → 0 lots, never the 0.01 minimum', () => {
  assert.equal(calcStandardPositionSize(0, 1, 20, 'XAU/USD'), 0)
  assert.equal(calcStandardPositionSize(0, 25, 10, 'EUR/USD'), 0)
})

t('negative / NaN / undefined balance → 0 lots', () => {
  assert.equal(calcStandardPositionSize(-500, 1, 20, 'XAU/USD'), 0)
  assert.equal(calcStandardPositionSize(NaN, 1, 20, 'XAU/USD'), 0)
  assert.equal(calcStandardPositionSize(undefined, 1, 20, 'XAU/USD'), 0)
})

t('a FUNDED account still floors to the 0.01 broker minimum', () => {
  // 10 GBP at 0.01% of 20 pips is far below one micro lot — the floor is correct here.
  assert.equal(calcStandardPositionSize(10, 0.01, 20, 'EUR/USD'), 0.01)
})

t('sizing from a real balance is unchanged', () => {
  // 10,000 × 1% = 100 risk / (20 pips × $10 per lot) = 0.50 lots
  assert.equal(calcStandardPositionSize(10_000, 1, 20, 'EUR/USD'), 0.5)
})

t('the MAX_LOTS ceiling is untouched', () => {
  assert.equal(calcStandardPositionSize(50_000_000, 100, 1, 'EUR/USD'), MAX_LOTS)
})

t('a zero balance is REJECTED at the planner, not traded at 0.01', () => {
  const strategy = { riskPct: 1, slPips: 20, tpPips: 40, manualLots: 0, manualRiskPct: 25 }
  const plan = planOrder({
    strategy, pair: 'EUR/USD', balance: 0,
    calcPositionSize: (b, r, s, p) => calcStandardPositionSize(b, r, s, p),
    defaultManualRiskPct: 25,
  })
  assert.equal(plan.ok, false, 'a zero balance must not produce a placeable plan')
  assert.equal(plan.reason, PLAN_REJECT.LOTS_NOT_POSITIVE)
})

if (failed) {
  console.error(`\n${failed} failed`)
  process.exit(1)
}
console.log('\nall zero-balance-sizing assertions passed')
