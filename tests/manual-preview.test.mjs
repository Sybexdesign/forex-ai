// tests/manual-preview.test.mjs
// The SHARED preview model + shared strategy validation — the production modules
// the Strategy page and /api/strategy use, so the UI cannot drift from execution.
import assert from 'node:assert/strict'
import { buildManualSizingPreview, MANUAL_REJECT } from '../lib/manual-sizing.mjs'
import { normaliseSizingSettings } from '../lib/strategy-validation.mjs'
import { MAX_LOTS, MIRROR_SL_CAP, minStopPips } from '../lib/trade-levels'

const MIN_STOP = minStopPips('XAU/USD')   // 20 pips
const XAU = { pipValuePerLot: 10, minStopPips: MIN_STOP, maxSlPips: MIRROR_SL_CAP, strategySlPips: 25, strategyTpPips: 50 }
const pv = (o = {}) => buildManualSizingPreview({ ...XAU, ...o })

let failed = 0
const t = (name, fn) => {
  try { fn(); console.log('  ok   ' + name) }
  catch (e) { failed++; console.error('  FAIL ' + name + '\n        ' + e.message) }
}

console.log('manual preview model (shared with the Strategy page)')

// ── 22.1–22.4. Mode ────────────────────────────────────────────────────────
t('22.1/22.4 empty manualLots → AUTO, no manual arithmetic at all', () => {
  for (const empty of [null, undefined, 0, '', NaN]) {
    const p = pv({ manualLots: empty, balance: 10000, manualRiskPct: 25 })
    assert.equal(p.mode, 'AUTO', `manualLots=${String(empty)} must be AUTO`)
    assert.equal(p.requestedLots, null)
    assert.equal(p.riskBudgetUsd, null, 'AUTO must not compute a manual budget')
    assert.equal(p.actualRiskUsd, null)
    assert.equal(p.finalSlPips, null)
    assert.equal(p.lotsAreAuthoritative, false)
  }
})

t('22.2/22.3 a valid number → MANUAL; clearing it returns to AUTO', () => {
  assert.equal(pv({ manualLots: 10, balance: 10000, manualRiskPct: 25 }).mode, 'MANUAL')
  // Deleting the field = empty draft = AUTO, never rendered as 0.
  assert.equal(pv({ manualLots: '', balance: 10000, manualRiskPct: 25 }).mode, 'AUTO')
  assert.equal(pv({ manualLots: 0,  balance: 10000, manualRiskPct: 25 }).mode, 'AUTO')
})

t('8. the preview exposes every field the page must show', () => {
  const p = pv({ manualLots: 10, balance: 10000, manualRiskPct: 25 })
  for (const k of ['mode', 'status', 'requestedLots', 'manualRiskPct', 'autoRiskPct', 'balance',
    'riskBudgetUsd', 'rawSlPips', 'finalSlPips', 'actualRiskUsd', 'actualRiskPct',
    'tpPips', 'rr', 'slCapped', 'maxLots', 'brokerMinStopPips', 'manualExceedsAutoRisk']) {
    assert.ok(k in p, `preview must expose ${k}`)
  }
})

// ── 13. The two mandated monotonic relationships ───────────────────────────
t('13. higher lots → TIGHTER raw SL (same budget)', () => {
  const a = pv({ manualLots: 1,  balance: 10000, manualRiskPct: 25, maxSlPips: 100000 })
  const b = pv({ manualLots: 2,  balance: 10000, manualRiskPct: 25, maxSlPips: 100000 })
  const c = pv({ manualLots: 10, balance: 10000, manualRiskPct: 25, maxSlPips: 100000 })
  assert.equal(a.rawSlPips, 250); assert.equal(b.rawSlPips, 125); assert.equal(c.rawSlPips, 25)
  assert.ok(a.rawSlPips > b.rawSlPips && b.rawSlPips > c.rawSlPips)
})

t('13. higher Manual Risk → WIDER raw SL (same lots)', () => {
  const a = pv({ manualLots: 10, balance: 10000, manualRiskPct: 10, maxSlPips: 100000 })
  const b = pv({ manualLots: 10, balance: 10000, manualRiskPct: 25, maxSlPips: 100000 })
  assert.equal(a.rawSlPips, 10); assert.equal(b.rawSlPips, 25)
  assert.ok(b.rawSlPips > a.rawSlPips)
})

// ── 18. $10k / 10 / 10% ────────────────────────────────────────────────────
t('18. $10k / 10 lots / 10% → CANNOT EXECUTE, lots stay 10', () => {
  const p = pv({ manualLots: 10, balance: 10000, manualRiskPct: 10 })
  console.log(`\n     10%: budget $${p.riskBudgetUsd} rawSL ${p.rawSlPips}p min ${p.brokerMinStopPips}p → ${p.status}`)
  assert.equal(p.status, 'CANNOT_EXECUTE')
  assert.equal(p.reason, MANUAL_REJECT.SL_BELOW_BROKER_MIN)
  assert.equal(p.slBelowBrokerMin, true)
  assert.match(p.message, /below the broker minimum/)
  assert.equal(p.requestedLots, 10, 'the requested lots are NEVER rewritten')
  assert.equal(p.riskBudgetUsd, 1000)
  assert.equal(p.rawSlPips, 10)
})

// ── 19. $10k / 10 / 25% ────────────────────────────────────────────────────
t('19. $10k / 10 lots / 25% → EXECUTABLE, budget == actual', () => {
  const p = pv({ manualLots: 10, balance: 10000, manualRiskPct: 25 })
  console.log(`     25%: budget $${p.riskBudgetUsd} rawSL ${p.rawSlPips}p finalSL ${p.finalSlPips}p actual $${p.actualRiskUsd} (${p.actualRiskPct}%) TP ${p.tpPips}p → ${p.status}`)
  assert.equal(p.status, 'EXECUTABLE')
  assert.equal(p.requestedLots, 10)
  assert.equal(p.riskBudgetUsd, 2500)
  assert.equal(p.rawSlPips, 25)
  assert.equal(p.finalSlPips, 25)
  assert.equal(p.slCapped, false)
  assert.equal(p.actualRiskUsd, 2500)
  assert.equal(p.actualRiskPct, 25)
  assert.equal(p.tpPips, 50, 'TP from the FINAL SL at the strategy R:R 50/25')
  assert.equal(p.rr, 2)
})

// ── 20/9/11. $10k / 10 / 50% — budget vs ACTUAL risk ───────────────────────
t('20/9/11. $10k / 10 lots / 50% → cap visible, ACTUAL risk BELOW budget', () => {
  const p = pv({ manualLots: 10, balance: 10000, manualRiskPct: 50 })
  console.log(`     50%: budget $${p.riskBudgetUsd} rawSL ${p.rawSlPips}p → capped finalSL ${p.finalSlPips}p → ACTUAL $${p.actualRiskUsd} (${p.actualRiskPct}%)  capped=${p.slCapped}`)
  assert.equal(p.status, 'EXECUTABLE')
  assert.equal(p.requestedLots, 10)
  assert.equal(p.riskBudgetUsd, 5000, 'the BUDGET')
  assert.equal(p.rawSlPips, 50)
  assert.equal(p.finalSlPips, MIRROR_SL_CAP, 'capped to the strategy SL cap')
  assert.equal(p.slCapped, true)
  assert.equal(p.slCappedFrom, 50, 'the constraint must name what it clamped from')
  assert.equal(p.actualRiskUsd, 3500, 'ACTUAL risk — NOT the $5,000 budget')
  assert.equal(p.actualRiskPct, 35)
  assert.notEqual(p.actualRiskUsd, p.riskBudgetUsd, 'budget must never be shown as expected loss')
  assert.equal(p.tpPips, 70, 'TP follows the CAPPED SL (35 x 2)')
})

// ── 21. Account-size comparison ────────────────────────────────────────────
t('21. $1k / $10k / $100k at 10 lots / 25%', () => {
  console.log('\n     balance   budget   rawSL  finalSL  actualRisk  actualRisk%  status')
  const out = {}
  for (const balance of [1000, 10000, 100000]) {
    const p = pv({ manualLots: 10, balance, manualRiskPct: 25 })
    out[balance] = p
    console.log(`     $${String(balance).padEnd(9)} ${String(p.riskBudgetUsd ?? '-').padEnd(8)} ${String(p.rawSlPips ?? '-').padEnd(6)} ${String(p.finalSlPips ?? '-').padEnd(8)} ${String(p.actualRiskUsd ?? '-').padEnd(11)} ${String(p.actualRiskPct ?? '-').padEnd(12)} ${p.status}`)
  }
  assert.equal(out[1000].status, 'CANNOT_EXECUTE', '$1k cannot afford a 20-pip stop at 10 lots')
  assert.equal(out[10000].status, 'EXECUTABLE')
  assert.equal(out[10000].actualRiskPct, 25)
  assert.equal(out[100000].status, 'EXECUTABLE')
  assert.equal(out[100000].slCapped, true)
  assert.ok(out[100000].actualRiskPct < 25, 'the cap makes a large account risk a SMALLER fraction')
  for (const cc of [1000, 10000, 100000]) {
    if (out[cc].requestedLots != null) assert.equal(out[cc].requestedLots, 10, 'lots never rewritten')
  }
})

t('14. manual risk above the AUTO risk is surfaced, never blocked', () => {
  const p = pv({ manualLots: 10, balance: 10000, manualRiskPct: 25, autoRiskPct: 1 })
  assert.equal(p.manualExceedsAutoRisk, true)
  assert.equal(p.status, 'EXECUTABLE')
  const same = pv({ manualLots: 10, balance: 10000, manualRiskPct: 1, autoRiskPct: 1, maxSlPips: 100000 })
  assert.equal(same.manualExceedsAutoRisk, false)
})

t('8. missing account/geometry → AWAITING_DATA, no invented numbers', () => {
  const a = pv({ manualLots: 10, balance: 0, manualRiskPct: 25 })
  assert.equal(a.status, 'AWAITING_DATA')
  assert.equal(a.reason, 'awaiting-account-data')
  assert.equal(a.message, 'Awaiting account data')
  assert.equal(a.actualRiskUsd, null, 'must not invent a risk figure')
  const b = pv({ manualLots: 10, balance: 10000, manualRiskPct: 25, pipValuePerLot: 0 })
  assert.equal(b.status, 'AWAITING_DATA')
  assert.equal(b.reason, 'awaiting-instrument-geometry')
})

t('15. maxLots is reported as an application ceiling only', () => {
  const p = pv({ manualLots: 10, balance: 10000, manualRiskPct: 25 })
  assert.equal(p.maxLots, MAX_LOTS)
  assert.ok(!('safeMaxLots' in p), 'no field may imply 10 is safe for this account')
})

// ── 19. SHARED strategy validation (the module /api/strategy calls) ────────
t('19. normaliseSizingSettings — the real route uses this exact function', () => {
  for (const lots of [0.01, 0.10, 0.50, 1, 1.25, 2, 5, 10]) {
    const r = normaliseSizingSettings({ manualLots: lots })
    assert.equal(r.ok, true, `${lots} must be accepted`)
    assert.equal(r.manualLots, lots)
  }
  for (const bad of [10.01, 50, -1, 'abc', NaN]) {
    assert.equal(normaliseSizingSettings({ manualLots: bad }).ok, false, `${bad} must be rejected`)
  }
  const ten = normaliseSizingSettings({ manualLots: 10, manualRiskPct: 25 })
  assert.equal(ten.ok, true)
  assert.equal(ten.manualLots, 10)
  assert.equal(ten.manualRiskPct, 25)
  assert.equal(ten.normalised.manualLots, 10, 'saved value must remain 10')
  for (const auto of [0, '', null, undefined]) {
    assert.equal(normaliseSizingSettings({ manualLots: auto }).manualLots, null, `${JSON.stringify(auto)} → AUTO`)
  }
})

t('19. manualRiskPct range is enforced by the shared validator', () => {
  assert.equal(normaliseSizingSettings({ manualRiskPct: 25 }).manualRiskPct, 25)
  assert.equal(normaliseSizingSettings({ manualRiskPct: 0.5 }).manualRiskPct, 0.5)
  for (const bad of [0, -1, 50.01, 100, NaN, 'abc']) {
    assert.equal(normaliseSizingSettings({ manualRiskPct: bad }).ok, false, `${bad} must be rejected`)
  }
  assert.equal(normaliseSizingSettings({ manualRiskPct: 50 }).manualRiskPct, 50, 'ceiling inclusive')
})

t('19. unrelated settings pass through untouched', () => {
  const r = normaliseSizingSettings({ riskPct: 1, slPips: 25, tpPips: 50, manualLots: 10 })
  assert.equal(r.ok, true)
  assert.equal(r.normalised.riskPct, 1)
  assert.equal(r.normalised.slPips, 25)
  assert.equal(r.normalised.tpPips, 50)
})

if (failed) { console.error(`\n${failed} failed`); process.exit(1) }
console.log('manual-preview: all tests passed')

