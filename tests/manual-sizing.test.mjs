// tests/manual-sizing.test.mjs
// MANUAL lot-size policy — the reported "10 lots executed as 0.50" bug and the
// separation of AUTO sizing input from MANUAL sizing policy.
import assert from 'node:assert/strict'
import {
  planManualSizing, resolveManualRiskPct, MANUAL_REJECT,
  MANUAL_MAX_RISK_PCT_DEFAULT, MANUAL_MAX_RISK_PCT_CEILING,
} from '../lib/manual-sizing.mjs'
import { MAX_LOTS } from '../lib/trade-levels'
import { DEFAULT_STRATEGY } from '../lib/supabase'

// The reported deterministic example.
const EX = { balance: 10000, manualRiskPct: 25, pipValuePerLot: 10, minStopPips: 10, maxSlPips: 35, rr: 2 }
const plan = (o) => planManualSizing({ ...EX, ...o })

let failed = 0
const t = (name, fn) => {
  try { fn(); console.log('  ok   ' + name) }
  catch (e) { failed++; console.error('  FAIL ' + name + '\n        ' + e.message) }
}

console.log('manual-sizing policy')

t('10 lots is RETAINED (was silently rewritten to 0.50)', () => {
  const r = plan({ manualLots: 10 })
  assert.equal(r.ok, true, JSON.stringify(r))
  assert.equal(r.lots, 10, 'requested lots must be authoritative')
  assert.notEqual(r.lots, 0.5, 'the old AUTO hard cap must not rewrite manual lots')
  // $10,000 x 25% = $2,500 budget / (10 lots x $10) = 25 pips
  assert.equal(r.permittedRiskUsd, 2500)
  assert.equal(r.slPips, 25)
  assert.equal(r.riskUsd, 2500)
  assert.equal(r.accountRiskPct, 25)
})

t('C/D: 1 and 1.25 lots retained', () => {
  assert.equal(plan({ manualLots: 1 }).lots, 1)
  assert.equal(plan({ manualLots: 1.25 }).lots, 1.25)
})

t('B: 0.50 retained', () => {
  const r = plan({ manualLots: 0.5 })
  assert.equal(r.lots, 0.5)
  // budget 2500 / (0.5 x 10) = 500 pips -> clamped DOWN to the 35-pip strategy cap
  assert.equal(r.slPips, 35)
  assert.equal(r.slClampedToCap, true, 'a smaller position wants a wider stop; the cap clamps it safely')
  assert.equal(r.riskUsd, 175, '0.5 x 10 x 35')
  assert.ok(r.accountRiskPct < 25, 'clamping must risk LESS than the budget, never more')
})

t('E: 5 lots retained', () => {
  const r = plan({ manualLots: 5 })
  assert.equal(r.lots, 5)
  assert.equal(r.slPips, 35)          // 2500/(5x10)=50 raw -> clamped to 35
  assert.equal(r.riskUsd, 1750)
})

t('G: above MAX_LOTS is REJECTED, not reduced', () => {
  const r = plan({ manualLots: 50 })
  assert.equal(r.ok, false)
  assert.equal(r.reason, MANUAL_REJECT.LOTS_ABOVE_MAX)
  assert.match(r.message, /10-lot maximum/)
  assert.equal(plan({ manualLots: 10.01 }).ok, false)
  assert.equal(plan({ manualLots: MAX_LOTS }).ok, true, 'exactly 10 must be allowed')
})

t('SL is DERIVED from the budget - bigger lots give a TIGHTER stop, not a smaller position', () => {
  const a = plan({ manualLots: 10, maxSlPips: 1000 })
  const b = plan({ manualLots: 5,  maxSlPips: 1000 })
  assert.equal(a.slPips, 25)
  assert.equal(b.slPips, 50)
  assert.ok(a.slPips < b.slPips, 'monotonic: more lots => tighter stop')
  assert.equal(a.riskUsd, b.riskUsd, 'both risk the same permitted budget')
  assert.equal(a.lots, 10, 'and neither is rewritten')
})

t('BUY/SELL symmetry: identical monetary risk for identical inputs', () => {
  const buy  = plan({ manualLots: 2 })
  const sell = plan({ manualLots: 2 })
  assert.equal(buy.riskUsd, sell.riskUsd)
  assert.equal(buy.slPips, sell.slPips)
})

t('K: invalid geometry fails closed', () => {
  for (const bad of [0, -1, NaN, undefined, null]) {
    const r = plan({ manualLots: 1, pipValuePerLot: bad })
    assert.equal(r.ok, false, `pipValuePerLot=${bad}`)
    assert.equal(r.reason, MANUAL_REJECT.GEOMETRY_INVALID)
  }
})

t('invalid balance / invalid lots fail closed', () => {
  assert.equal(plan({ manualLots: 1, balance: 0 }).reason, MANUAL_REJECT.BALANCE_INVALID)
  assert.equal(plan({ manualLots: 0 }).reason, MANUAL_REJECT.LOTS_INVALID)
  assert.equal(plan({ manualLots: -5 }).reason, MANUAL_REJECT.LOTS_INVALID)
  assert.equal(plan({ manualLots: NaN }).reason, MANUAL_REJECT.LOTS_INVALID)
})

t('L: SL too tight for the broker is REJECTED with a reason (never a smaller position)', () => {
  const r = plan({ manualLots: 10, manualRiskPct: 0.1, minStopPips: 10 })
  assert.equal(r.ok, false)
  assert.equal(r.reason, MANUAL_REJECT.SL_BELOW_BROKER_MIN)
  assert.match(r.message, /below the broker minimum/)
  assert.match(r.message, /Raise the manual risk budget or reduce lot size/)
})

t('TP is derived from the FINAL SL, preserving the strategy R:R', () => {
  assert.equal(plan({ manualLots: 10, rr: 2 }).tpPips, 50, '25-pip SL at R:R 2 => 50-pip TP')
  assert.equal(plan({ manualLots: 10, rr: 1.5 }).tpPips, 38)
  assert.equal(plan({ manualLots: 10, rr: null }).tpPips, null)
})

t('risk budget: one canonical default, owned by the STRATEGY layer', () => {
  // The policy no longer invents a default — a caller that omits it is rejected, so
  // the number the UI shows and the number execution uses cannot drift.
  assert.equal(resolveManualRiskPct(undefined), null)
  assert.equal(resolveManualRiskPct(0), null)
  assert.equal(resolveManualRiskPct(-5), null)
  assert.equal(resolveManualRiskPct(NaN), null)
  assert.equal(resolveManualRiskPct(12.5), 12.5)
  assert.equal(resolveManualRiskPct(1e9), MANUAL_MAX_RISK_PCT_CEILING, 'ceiling enforced')
  // And the policy surfaces that as an explicit, actionable rejection.
  const r = planManualSizing({ manualLots: 1, balance: 10000, pipValuePerLot: 10, minStopPips: 10, maxSlPips: 35 })
  assert.equal(r.ok, false)
  assert.equal(r.reason, MANUAL_REJECT.RISK_PCT_MISSING)
  assert.match(r.message, /Manual Risk %/)
})

t('the canonical default lives in DEFAULT_STRATEGY (single source of truth)', () => {
  assert.equal(DEFAULT_STRATEGY.manualRiskPct, MANUAL_MAX_RISK_PCT_DEFAULT,
    'DEFAULT_STRATEGY.manualRiskPct must be the one place that chooses the number')
  assert.ok(DEFAULT_STRATEGY.manualRiskPct > 0)
  assert.ok(DEFAULT_STRATEGY.manualRiskPct <= MANUAL_MAX_RISK_PCT_CEILING)
})

t('account-size independence: never risks MORE than the budget, whatever the balance', () => {
  const small = plan({ manualLots: 1, balance: 1000 })
  const big   = plan({ manualLots: 1, balance: 100000 })
  // NOTE: the strategy SL cap bounds ABSOLUTE risk, so the account-risk FRACTION
  // is not invariant across balances — a large account hits the 35-pip cap and
  // therefore risks a smaller fraction. That is the safe direction. The invariant
  // that must hold is that neither ever exceeds the permitted budget.
  assert.ok(small.accountRiskPct <= 25, `small=${small.accountRiskPct}`)
  assert.ok(big.accountRiskPct  <= 25, `big=${big.accountRiskPct}`)
  assert.ok(big.riskUsd >= small.riskUsd, 'absolute risk must not shrink as the account grows')
  assert.equal(big.accountRiskPct, 0.35, '100000: capped at 35 pips x 1 lot x $10 = $350')
  // Raising the budget lets a large account actually use its fraction.
  const bigUncapped = plan({ manualLots: 1, balance: 100000, maxSlPips: 100000 })
  assert.equal(bigUncapped.accountRiskPct, 25, 'with no cap the fraction is exactly the budget')
})

if (failed) { console.error(`\n${failed} failed`); process.exit(1) }
console.log('manual-sizing: all tests passed')
