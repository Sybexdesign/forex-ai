// tests/order-sizing-runtime.test.mjs
// RUNTIME-EQUIVALENT proof of the ordering-path sizing decision.
//
// WHAT THIS PROVES AND WHAT IT DOES NOT
//
// It exercises the REAL `planManualSizing()` from lib/manual-sizing.mjs — the
// exact function /api/orders calls on the manual branch — with the fixtures from
// the phase brief. It then proves STRUCTURALLY (by reading route source) that
// /api/orders cannot rewrite the requested lots between that call and the broker
// payload, because the block that used to do so is gone.
//
// It is NOT an HTTP round-trip through /api/orders: that route transitively pulls
// next/server, supabase and env at import time, which needs a heavier harness
// than this phase had budget for. The structural assertion substitutes for it and
// is labelled as such rather than overclaimed.
import assert from 'node:assert/strict'
import { normaliseSizingSettings } from '../lib/strategy-validation.mjs'
import { readFileSync } from 'node:fs'
import { planManualSizing, MANUAL_REJECT } from '../lib/manual-sizing.mjs'
import { MAX_LOTS, MIRROR_SL_CAP, minStopPips } from '../lib/trade-levels'

const ROUTE = readFileSync(new URL('../app/api/orders/route.ts', import.meta.url), 'utf8')
// The sizing policy now lives in the shared planner, which the route calls.
const PLANNER = readFileSync(new URL('../lib/order-planner.mjs', import.meta.url), 'utf8')
/** Source with `//` comment lines removed, so prose cannot satisfy a code assertion. */
const ROUTE_CODE = ROUTE.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n')
// Planner with comments stripped too — same reason as above.
const PLANNER_CODE = PLANNER.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n')
const MIN_STOP = minStopPips('XAU/USD')

let failed = 0
const t = (name, fn) => {
  try { fn(); console.log('  ok   ' + name) }
  catch (e) { failed++; console.error('  FAIL ' + name + '\n        ' + e.message) }
}

const base = { balance: 10000, manualRiskPct: 25, pipValuePerLot: 10, minStopPips: MIN_STOP, maxSlPips: MIRROR_SL_CAP, rr: 35 / 25 }
const plan = (o) => planManualSizing({ ...base, ...o })

console.log('order-sizing runtime-equivalent')

// ── 13/14. STRUCTURAL: the route cannot rewrite the requested lots ───────────
t('13/14. /api/orders delegates sizing to the planner and never rewrites lots', () => {
  assert.equal(/lots\s*=\s*Math\.max\(0\.01[^)]*\)/.test(ROUTE), false,
    'the hard-cap reduction that rewrote manual lots must be gone from the source')
  // The policy moved into the shared planner; the ROUTE must call it. The runtime
  // behaviour it guards is executed (not regex-checked) in
  // tests/order-planner-boundary.test.mjs.
  assert.match(ROUTE, /planOrder\(/, 'the route must call the shared order planner')
  assert.match(PLANNER, /planManualSizing\(/, 'the planner must call the separated MANUAL policy')
  // Guard against a REASSIGNMENT in real code. Comments are stripped first: the
  // explanatory comment deliberately quotes the deleted expression. The planner is
  // included because the sizing policy now lives there.
  const CODE = ROUTE_CODE + '\n' + PLANNER_CODE
  assert.equal(/hardCapUsd\s*=/.test(CODE), false, 'no hardCapUsd-derived rewrite may remain')
  assert.equal(/\blots\s*=\s*[^;]*hardCap/i.test(CODE), false, 'lots must not be derived from a money cap')

  // The MANUAL branch lives in the planner now. It must never assign to `lots`.
  const start = PLANNER.indexOf("if (lotSource === 'manual') {")
  const end   = PLANNER.indexOf('Application ceiling', start)
  assert.ok(start > 0 && end > start, 'manual branch located in the planner')
  const branch = PLANNER.slice(start, end)
  assert.equal(/\blots\s*=(?!=)/.test(branch), false,
    'the MANUAL branch must never assign to `lots` — the requested size is authoritative')
  assert.match(branch, /planManualSizing\(/, 'and it derives the STOP from the MANUAL policy')
  console.log(`     manual branch checked (${branch.length} chars); no lot rewrite present`)
})

t('13/14. the authoritative lots are what get logged and placed', () => {
  // The route logs the planner's authoritative `lots` — not a recomputed figure.
  assert.match(ROUTE, /using manual lots: \$\{lots\}/)
  assert.match(ROUTE, /const lots\s*=\s*plan\.lots/, 'lots come straight from the plan')
  // …and the plan is what reaches the broker request.
  assert.match(PLANNER, /lots: plan\.lots/, 'buildBrokerRequest passes the plan lots through')
})

// ── 15. The 10-lot fixture reaches the sizing boundary as 10 ────────────────
t('15. MANUAL 10-lot fixture: lots=10, budget $2500, SL 25p — NEVER 0.50', () => {
  const r = plan({ manualLots: 10, manualRiskPct: 25 })
  assert.equal(r.ok, true)
  assert.equal(r.lots, 10, 'the value the route will place')
  assert.notEqual(r.lots, 0.5)
  assert.equal(r.permittedRiskUsd, 2500)
  assert.equal(r.rawSlPips, 25)
  assert.equal(r.slPips, 25, 'within the 35-pip cap, so not clamped')
  assert.equal(r.slClampedToCap, false)
  console.log(`     10 lots → budget $${r.permittedRiskUsd} → SL ${r.slPips}p → risk $${r.riskUsd} (${r.accountRiskPct}%)`)
})

t('15. an order payload built from the plan carries lots=10', () => {
  const r = plan({ manualLots: 10, manualRiskPct: 25 })
  const payload = { pair: 'XAU/USD', direction: 'BUY', lots: r.lots, slPips: r.slPips, tpPips: r.tpPips }
  assert.equal(payload.lots, 10)
  assert.notEqual(payload.lots, 0.5)
  assert.equal(payload.slPips, 25)
})

// ── 17. Manual Risk independence ────────────────────────────────────────────
t('17. manualRiskPct drives budget and SL — and lots stay 10', () => {
  // XAU/USD broker minimum stop is 20 pips (lib/trade-levels.ts MIN_STOP_PIPS).
  // That makes the placeable window for 10 lots a 20–35 pip stop, which is the
  // real constraint the user meets — not the SL cap alone.
  const at10 = plan({ manualLots: 10, manualRiskPct: 10 })
  const at25 = plan({ manualLots: 10, manualRiskPct: 25 })
  const at50 = plan({ manualLots: 10, manualRiskPct: 50 })

  // 10% affords only a 10-pip stop → BELOW the 20-pip broker minimum → REJECTED.
  // It must reject rather than quietly shrinking 10 lots to fit.
  assert.equal(at10.ok, false)
  assert.equal(at10.reason, MANUAL_REJECT.SL_BELOW_BROKER_MIN)

  assert.equal(at25.ok, true)
  assert.equal(at25.permittedRiskUsd, 2500); assert.equal(at25.rawSlPips, 25)

  assert.equal(at50.ok, true)
  assert.equal(at50.permittedRiskUsd, 5000); assert.equal(at50.rawSlPips, 50)
  assert.equal(at50.slPips, MIRROR_SL_CAP, '50-pip wish capped to the 35-pip strategy cap')
  assert.equal(at50.slClampedToCap, true)
  assert.equal(at50.riskUsd, 3500, '10 x $10 x 35 pips — ACTUAL risk')
  assert.equal(at50.accountRiskPct, 35)
  assert.ok(at50.riskUsd < at50.permittedRiskUsd,
    'budget $5000 but ACTUAL risk $3500 — the UI must never claim the full budget')
  console.log(`     10%→REJECT (10p < 20p min)  25%→${at25.rawSlPips}p/$${at25.riskUsd} (25%)  50%→raw ${at50.rawSlPips}p capped ${at50.slPips}p→ACTUAL $${at50.riskUsd} (${at50.accountRiskPct}%) vs budget $${at50.permittedRiskUsd}`)
})

t('17. changing lots does NOT change manualRiskPct', () => {
  for (const lots of [0.5, 1, 5, 10]) assert.equal(plan({ manualLots: lots, manualRiskPct: 25 }).riskPct, 25)
})

// ── 18. Account-size behaviour and the SL cap ───────────────────────────────
t('18. account-size comparison at 10 lots / 25% with the REAL XAU min (20p) and cap (35p)', () => {
  console.log('\n     balance      budget     rawSL  finalSL  actualRisk  actualRiskPct  bound')
  const rows = {}
  for (const balance of [1000, 10000, 100000]) {
    const r = plan({ manualLots: 10, manualRiskPct: 25, balance })
    rows[balance] = r
    const bound = !r.ok ? 'REJECTED(broker-min)' : r.slClampedToCap ? 'SL_CAP' : 'none'
    console.log(`     $${String(balance).padEnd(10)} ${r.ok ? '$' + String(r.permittedRiskUsd).padEnd(9) : '-'.padEnd(10)} ${r.ok ? String(r.rawSlPips).padEnd(6) : '-'.padEnd(6)} ${r.ok ? String(r.slPips).padEnd(8) : '-'.padEnd(8)} ${r.ok ? '$' + String(r.riskUsd).padEnd(10) : '-'.padEnd(11)} ${r.ok ? String(r.accountRiskPct).padEnd(13) : '-'.padEnd(13)} ${bound}`)
  }
  // $1,000: the budget affords only a 10-pip stop, below the 20-pip broker
  // minimum → REJECTED. 10 XAU lots is simply not placeable on a $1k account.
  assert.equal(rows[1000].ok, false)
  assert.equal(rows[1000].reason, MANUAL_REJECT.SL_BELOW_BROKER_MIN)
  // $10,000: 25 pips sits inside [20, 35] → executes at the full intended risk.
  assert.equal(rows[10000].ok, true)
  assert.equal(rows[10000].slPips, 25)
  assert.equal(rows[10000].riskUsd, 2500)
  assert.equal(rows[10000].accountRiskPct, 25)
  // $100,000: wants a 250-pip stop; the 35-pip cap binds, so the account risks
  // only 0.35% — far BELOW the configured budget. The cap protects, it does not
  // grant extra risk.
  assert.equal(rows[100000].ok, true)
  assert.equal(rows[100000].rawSlPips, 250)
  assert.equal(rows[100000].slPips, MIRROR_SL_CAP)
  assert.equal(rows[100000].accountRiskPct, 3.5, '3500 / 100000 = 3.5%')
  assert.ok(rows[100000].riskUsd < rows[100000].permittedRiskUsd)
  // In every ACCEPTED case the requested lots are untouched.
  for (const b of [10000, 100000]) assert.equal(rows[b].lots, 10, 'lots authoritative')
})

// ── 9. SL cap must be visible in the returned diagnostics ───────────────────
t('9. cap diagnostics expose raw vs final SL and the ACTUAL risk', () => {
  const r = plan({ manualLots: 10, manualRiskPct: 50 })
  assert.equal(r.rawSlPips, 50)
  assert.equal(r.slPips, MIRROR_SL_CAP)
  assert.equal(r.slClampedToCap, true)
  // The theoretical budget must NOT be presented as the risk taken.
  assert.notEqual(r.riskUsd, r.permittedRiskUsd)
  assert.equal(r.riskUsd, 10 * 10 * MIRROR_SL_CAP)
})

// ── 11. Broker minimum stop distance ────────────────────────────────────────
t('11. SL below the broker minimum is REJECTED — lots are not reduced', () => {
  const r = plan({ manualLots: 10, manualRiskPct: 0.05, balance: 10000, minStopPips: 10 })
  assert.equal(r.ok, false)
  assert.equal(r.reason, MANUAL_REJECT.SL_BELOW_BROKER_MIN)
  assert.equal('lots' in r, false, 'no reduced lot size is offered')
  console.log(`     rejected: budget-only SL 0.5p < broker min 10p — ${r.message}`)
})

// ── 12. TP follows the final SL and the strategy R:R ────────────────────────
t('12. TP is derived from the FINAL SL using the configured R:R', () => {
  const r = plan({ manualLots: 10, manualRiskPct: 25, rr: 35 / 25 })
  assert.equal(r.slPips, 25)
  assert.equal(r.tpPips, 35, '25p SL x (35/25) = 35p TP — the strategy R:R, not a hardcoded 1.67')
  const capped = plan({ manualLots: 10, manualRiskPct: 50, rr: 35 / 25 })
  assert.equal(capped.slPips, MIRROR_SL_CAP)
  assert.equal(capped.tpPips, 49, 'TP follows the CAPPED SL, not the 50-pip wish')
})

// ── 8. Canonical ceiling agreement ──────────────────────────────────────────
t('8. every layer agrees on MAX_LOTS (no stale 0.50 maximum)', () => {
  const strategy = readFileSync(new URL('../app/api/strategy/route.ts', import.meta.url), 'utf8')
  const shared = readFileSync(new URL('../lib/strategy-validation.mjs', import.meta.url), 'utf8')
  // The bound is no longer an inline literal in the route — it lives in ONE shared
  // module, and the ROUTE must delegate to it (that is the invariant worth testing;
  // two copies of the ceiling is exactly how 0.50 drifted out of sync before).
  assert.match(strategy, /normaliseSizingSettings\(/, '/api/strategy must delegate to the shared validator')
  assert.match(shared, /lots > MAX_LOTS/, 'the shared validator bounds by MAX_LOTS')
  assert.equal(/lots > 0\.50/.test(strategy + shared), false, 'the stale 0.50 bound must be gone')
  // The order ceiling lives in the shared planner the route calls; the behaviour
  // is executed for real in tests/order-planner-boundary.test.mjs.
  assert.match(PLANNER, /lots > MAX_LOTS/, '/api/orders ceiling uses MAX_LOTS (via the planner)')
  assert.equal(plan({ manualLots: MAX_LOTS }).ok, true)
  assert.equal(plan({ manualLots: MAX_LOTS + 0.01 }).reason, MANUAL_REJECT.LOTS_ABOVE_MAX)
  // …and the shared validator agrees with the planner at the same boundary.
  assert.equal(normaliseSizingSettings({ manualLots: MAX_LOTS }).ok, true)
  assert.equal(normaliseSizingSettings({ manualLots: MAX_LOTS + 0.01 }).ok, false)
})

if (failed) { console.error(`\n${failed} failed`); process.exit(1) }
console.log('order-sizing runtime-equivalent: all tests passed')

