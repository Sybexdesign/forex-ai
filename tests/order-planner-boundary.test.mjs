// tests/order-planner-boundary.test.mjs
// ── THE PRODUCTION ORDER-PLANNING PATH, EXECUTED AGAINST A MOCKED BROKER ────
//
// The acceptance claim: a valid 10-lot Manual request reaches the broker boundary
// as 10 lots, with no silent 10 → 0.50 conversion anywhere in the execution path.
//
// This test could previously only be asserted by regex against route source. It now
// EXECUTES the real production chain:
//
//   real strategy normalisation  (lib/strategy-validation.mjs)
//   → real order planner          (lib/order-planner.mjs)
//   → real Manual sizing policy   (lib/manual-sizing.mjs)
//   → mocked broker boundary      (only placeOrder is stubbed)
//
// No network, no live broker, no real account, no order placed.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { planOrder, buildBrokerRequest } from '../lib/order-planner.mjs'
import { MANUAL_REJECT } from '../lib/manual-sizing.mjs'
import { normaliseSizingSettings } from '../lib/strategy-validation.mjs'
import { calcStandardPositionSize } from '../lib/brokers/interface'
import { SimulationBroker } from '../lib/brokers/simulation.adapter.ts'
import { MAX_LOTS, MIRROR_SL_CAP, minStopPips } from '../lib/trade-levels'
import { DEFAULT_STRATEGY } from '../lib/supabase'

const SYM      = 'XAU/USD'
const MIN_STOP = minStopPips(SYM)          // 20

let failed = 0
// Registered, then run sequentially at the end — these tests are async, so a
// sync try/catch would swallow failures as unhandled rejections.
const tests = []
const t = (name, fn) => tests.push([name, fn])

/**
 * The MOCKED BROKER. Only the broker boundary is mocked — `placeOrder` records
 * instead of executing, and `calcPositionSize` is the injected AUTO sizing fn.
 * Everything else in the chain is production code.
 */
function mockBroker() {
  const placed = []
  return {
    name: 'mock-broker',
    placed,
    calcPositionSize: (balance, riskPct, slPips, pair) => calcStandardPositionSize(balance, riskPct, slPips, pair),
    async placeOrder(req) {
      placed.push({ ...req })
      return { success: true, tradeId: 'MOCK_1', filledPrice: req.currentPrice, tpPrice: 0, slPrice: 0 }
    },
  }
}

/** Run the REAL chain end-to-end and return the broker request(s). */
async function runPath({ balance, strategySettings, direction = 'BUY', price = 4568.0 }) {
  // 1. REAL strategy normalisation (the same function /api/strategy uses).
  const norm = normaliseSizingSettings(strategySettings)
  assert.equal(norm.ok, true, 'settings must normalise')
  const strategy = { ...DEFAULT_STRATEGY, ...norm.normalised }

  const broker = mockBroker()
  // 2. REAL order planner with the broker's auto-sizing injected.
  const plan = planOrder({
    strategy, pair: SYM, balance,
    calcPositionSize: broker.calcPositionSize,
    defaultManualRiskPct: DEFAULT_STRATEGY.manualRiskPct,
  })
  if (!plan.ok) return { plan, broker, strategy }

  // 3. REAL broker-request assembly, then 4. the MOCKED boundary.
  await broker.placeOrder(buildBrokerRequest({ pair: SYM, direction, plan, currentPrice: price }))
  return { plan, broker, strategy }
}

const base = { riskPct: 1, slPips: 25, tpPips: 50 }

console.log('order planner → mocked broker boundary')

// ── 18/16/17. 10 lots / 25% must arrive as 10 lots ─────────────────────────
t('18. $10k / 10 lots / 25% → broker receives exactly 10 lots', async () => {
  const { plan, broker } = await runPath({
    balance: 10000, strategySettings: { ...base, manualLots: 10, manualRiskPct: 25 },
  })
  assert.equal(plan.ok, true, 'plan must succeed')
  const req = broker.placed[0]
  assert.equal(req.lots, 10, 'FINAL BROKER REQUEST lots === 10')
  assert.equal(plan.lots, 10)
  assert.equal(plan.requestedLots, 10)
  assert.equal(plan.lotSource, 'manual')
  assert.equal(req.stopLossPips, 25, 'SL derived from the manual budget')
  assert.equal(req.takeProfitPips, 50, 'TP from the FINAL SL at the strategy R:R')
  assert.equal(req.pair, SYM)
  // ── 18. the explicit anti-regression assertion ───────────────────────────
  assert.notEqual(req.lots, 0.50, 'lots must NOT be silently reduced to 0.50')
  assert.equal(broker.placed.length, 1, 'exactly one broker call')
  console.log(`     broker request: lots=${req.lots} sl=${req.stopLossPips}p tp=${req.takeProfitPips}p`)
})

t('18. the planner reports ACTUAL risk separately from the budget', async () => {
  const { plan } = await runPath({
    balance: 10000, strategySettings: { ...base, manualLots: 10, manualRiskPct: 25 },
  })
  assert.equal(plan.manualRisk.permittedRiskUsd, 2500)
  assert.equal(plan.manualRisk.riskUsd, 2500)
  assert.equal(plan.manualRisk.accountRiskPct, 25)
  assert.equal(plan.slClampedToCap, false)
})

// ── 19. Rejection must PRESERVE the requested lots ─────────────────────────
t('19. $10k / 10 lots / 10% → rejected on the SL constraint, lots stay 10', async () => {
  const { plan, broker } = await runPath({
    balance: 10000, strategySettings: { ...base, manualLots: 10, manualRiskPct: 10 },
  })
  assert.equal(plan.ok, false)
  assert.equal(plan.reason, MANUAL_REJECT.SL_BELOW_BROKER_MIN, 'failure reason is the SL constraint')
  assert.equal(plan.stage, 'manual-sizing')
  assert.equal(plan.requestedLots, 10, 'the requested lots are preserved in the rejection')
  assert.equal(broker.placed.length, 0, 'NOTHING reaches the broker')
  // No silent re-sizing to any of the historical values.
  for (const bad of [5, 1, 0.50, 0.5]) assert.notEqual(plan.requestedLots, bad)
  assert.match(plan.message, new RegExp(String(MIN_STOP)))
  console.log(`     rejected: ${plan.reason} · requestedLots=${plan.requestedLots} · broker calls=0`)
})

// ── 20. SL cap: lots authoritative while the stop is constrained ───────────
t('20. $10k / 10 lots / 50% → lots 10 authoritative, SL capped to 35p', async () => {
  const { plan, broker } = await runPath({
    balance: 10000, strategySettings: { ...base, manualLots: 10, manualRiskPct: 50 },
  })
  assert.equal(plan.ok, true)
  const req = broker.placed[0]
  assert.equal(plan.requestedLots, 10)
  assert.equal(req.lots, 10, 'broker lots remain 10')
  assert.notEqual(req.lots, 0.50)
  assert.equal(plan.rawSlPips, 50, 'raw SL from the 50% budget')
  assert.equal(req.stopLossPips, MIRROR_SL_CAP, 'final SL capped to the strategy cap')
  assert.equal(plan.slClampedToCap, true)
  assert.equal(plan.manualRisk.permittedRiskUsd, 5000, 'the BUDGET')
  assert.equal(plan.manualRisk.riskUsd, 3500, 'ACTUAL risk — below the budget')
  assert.notEqual(plan.manualRisk.riskUsd, plan.manualRisk.permittedRiskUsd)
  console.log(`     budget $${plan.manualRisk.permittedRiskUsd} rawSL ${plan.rawSlPips}p → final ${req.stopLossPips}p → actual $${plan.manualRisk.riskUsd} · lots ${req.lots}`)
})



// ── 21/23. AUTO regression: manualRiskPct must not affect AUTO orders ──────
t('21/23. AUTO: manualLots=null → broker auto-sizes; manualRiskPct is IRRELEVANT', async () => {
  const a = await runPath({ balance: 10000, strategySettings: { ...base, manualLots: null, manualRiskPct: 1 } })
  const b = await runPath({ balance: 10000, strategySettings: { ...base, manualLots: null, manualRiskPct: 50 } })
  const c = await runPath({ balance: 10000, strategySettings: { ...base, manualLots: null, manualRiskPct: 25 } })

  for (const r of [a, b, c]) {
    assert.equal(r.plan.ok, true)
    assert.equal(r.plan.lotSource, 'auto', 'AUTO sizing path is selected')
    assert.equal(r.plan.manualRisk, null, 'no manual risk plan in AUTO')
  }
  // The AUTO lots come from calcPositionSize, NOT from the manual policy.
  const expected = calcStandardPositionSize(10000, base.riskPct, base.slPips, SYM)
  assert.equal(a.plan.lots, expected, 'calcPositionSize is authoritative')
  assert.equal(a.broker.placed[0].lots, expected, 'broker receives the auto-sized lots')
  // IDENTICAL requests across three different manualRiskPct values.
  assert.deepEqual(b.broker.placed[0], a.broker.placed[0], 'manualRiskPct=1 vs 50 → identical order')
  assert.deepEqual(c.broker.placed[0], a.broker.placed[0], 'manualRiskPct=25 → identical order')
  console.log(`     AUTO lots=${a.broker.placed[0].lots} (calcPositionSize) — identical for manualRiskPct 1/25/50`)
})

t('21. AUTO: strategy.riskPct remains the authoritative risk input', async () => {
  const lo = await runPath({ balance: 10000, strategySettings: { ...base, riskPct: 1, manualLots: null } })
  const hi = await runPath({ balance: 10000, strategySettings: { ...base, riskPct: 2, manualLots: null } })
  assert.ok(hi.plan.lots > lo.plan.lots, 'higher riskPct → larger auto position')
  assert.equal(lo.plan.lots, calcStandardPositionSize(10000, 1, 25, SYM))
  assert.equal(hi.plan.lots, calcStandardPositionSize(10000, 2, 25, SYM))
})

t('21. AUTO: manual sizing policy is NOT used to choose lots', async () => {
  // manualLots absent entirely (legacy strategies) → still AUTO.
  const r = await runPath({ balance: 10000, strategySettings: { ...base } })
  assert.equal(r.plan.lotSource, 'auto')
  assert.equal(r.plan.manualRisk, null)
})

// ── 22. BUY/SELL symmetry through the real simulation adapter ───────────────
t('22. BUY and SELL both place 10 lots, with directionally correct SL/TP', async () => {
  const sim = new SimulationBroker()
  const price = 4568.0
  const out = {}
  for (const direction of ['BUY', 'SELL']) {
    const { plan } = await runPath({
      balance: 10000, strategySettings: { ...base, manualLots: 10, manualRiskPct: 25 }, direction, price,
    })
    assert.equal(plan.lots, 10)
    // The REAL adapter converts pip distances to prices — semantics unchanged.
    const res = await sim.placeOrder(buildBrokerRequest({ pair: SYM, direction, plan, currentPrice: price }))
    assert.equal(res.success, true)
    out[direction] = res
  }
  // 25 pips at 0.1 = 2.5 price units; TP 50 pips = 5.0 price units.
  assert.equal(out.BUY.slPrice,  price - 2.5, 'BUY stop sits BELOW entry')
  assert.equal(out.BUY.tpPrice,  price + 5.0, 'BUY target sits ABOVE entry')
  assert.equal(out.SELL.slPrice, price + 2.5, 'SELL stop sits ABOVE entry')
  assert.equal(out.SELL.tpPrice, price - 5.0, 'SELL target sits BELOW entry')
  console.log(`     BUY sl=${out.BUY.slPrice} tp=${out.BUY.tpPrice} · SELL sl=${out.SELL.slPrice} tp=${out.SELL.tpPrice}`)
})

// ── Universal guards preserved (architectural extraction only) ─────────────
t('23. the planner still enforces MAX_LOTS; the route still runs every guard', async () => {
  const rawOver = planOrder({
    strategy: { ...base, manualLots: MAX_LOTS + 5, manualRiskPct: 50 },
    pair: SYM, balance: 1000000,
    calcPositionSize: calcStandardPositionSize,
    defaultManualRiskPct: DEFAULT_STRATEGY.manualRiskPct,
  })
  assert.equal(rawOver.ok, false)
  assert.equal(rawOver.reason, MANUAL_REJECT.LOTS_ABOVE_MAX, 'ceiling enforced inside the policy')
  // The universal guards still run in the route, BEFORE planning.
  const route = readFileSync(new URL('../app/api/orders/route.ts', import.meta.url), 'utf8')
  for (const guard of ['runRiskGuards', 'isTradeAllowed', 'applyPropFirmGuards', 'evaluateExecutionGuards']) {
    assert.match(route, new RegExp(guard), `${guard} must still be called`)
  }
  assert.ok(route.indexOf('runRiskGuards') < route.indexOf('planOrder('), 'risk guards run BEFORE the planner')
  // …and the planner is the injectable production module, not inline logic.
  assert.match(route, /planOrder\(/, 'the route must call the shared planner')
  assert.match(route, /from '@\/lib\/order-planner\.mjs'/, 'imported from the shared module')
})

// ── Sequential async runner ─────────────────────────────────────────────────
for (const [name, fn] of tests) {
  try {
    await fn()
    console.log('  ok   ' + name)
  } catch (e) {
    failed++
    console.error('  FAIL ' + name + '\n        ' + (e.stack || e.message).split('\n').slice(0, 5).join('\n        '))
  }
}

if (failed) { console.error(`\n${failed} failed`); process.exit(1) }
console.log('order-planner boundary: all tests passed')