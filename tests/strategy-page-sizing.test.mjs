// tests/strategy-page-sizing.test.mjs
// ── STRATEGY PAGE MANUAL-SIZING VIEW-MODEL ─────────────────────────────────
//
// These exercise the extracted UI layer (lib/strategy-sizing-view.mjs) that the
// real page renders, plus a source-level assertion that the page is actually
// wired to it. The page itself does no sizing arithmetic — that is the point.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  buildStrategySizingView, validateManualRiskPct, isPartialRiskInput,
  resolveManualMode, geometryForPair,
} from '../lib/strategy-sizing-view.mjs'
import { validateLotSize, lotSizeToText } from '../lib/lot-size.mjs'
import { normaliseSizingSettings } from '../lib/strategy-validation.mjs'
import { MANUAL_MAX_RISK_PCT_CEILING } from '../lib/manual-sizing.mjs'
import { MAX_LOTS, MIRROR_SL_CAP, minStopPips } from '../lib/trade-levels'
import { DEFAULT_STRATEGY } from '../lib/supabase'

const VIEW = { defaultManualRiskPct: DEFAULT_STRATEGY.manualRiskPct, autoRiskPct: 1,
               pair: 'XAU/USD', currency: 'USD', strategySlPips: 25, strategyTpPips: 50 }
const view = (o = {}) => buildStrategySizingView({ ...VIEW, balance: 10000, ...o })
const rowVal = (v, key) => {
  const r = v.rows.find(x => x.key === key)
  assert.ok(r, `row ${key} must exist`)
  return r.value
}

let failed = 0
const t = (name, fn) => {
  try { fn(); console.log('  ok   ' + name) }
  catch (e) { failed++; console.error('  FAIL ' + name + '\n        ' + (e.stack || e.message).split('\n').slice(0, 4).join('\n        ')) }
}

console.log('strategy page manual-sizing view model')

// ── 1/2/3. Mode is decided by the Manual Lots field alone ──────────────────
t('1. empty Manual Lots → AUTO', () => {
  for (const empty of [null, undefined, 0, '']) {
    assert.equal(resolveManualMode(empty), 'AUTO')
    assert.equal(view({ manualLots: empty }).mode, 'AUTO')
    assert.equal(rowVal(view({ manualLots: empty }), 'mode'), 'Automatic')
  }
})

t('2. 10 → MANUAL', () => {
  assert.equal(resolveManualMode(10), 'MANUAL')
  const v = view({ manualLots: 10, manualRiskPct: 25 })
  assert.equal(v.mode, 'MANUAL')
  assert.equal(rowVal(v, 'mode'), 'Manual')
})

t('3/25. clearing 10 → AUTO, and the AUTO state renders no manual rows', () => {
  const v = view({ manualLots: '', manualRiskPct: 25 })
  assert.equal(v.mode, 'AUTO')
  assert.equal(rowVal(v, 'mode'), 'Automatic')
  // 25. clearing Manual Lots must NOT erase the saved Manual Risk preference.
  assert.equal(v.preview.manualRiskPct, null, 'AUTO computes no manual budget')
})

// ── 4/5. The cleared field stays empty and never renders 0 ─────────────────
t('4/5. a cleared field commits to null/empty, never to 0', () => {
  for (const cleared of ['', '   ']) {
    const res = validateLotSize(cleared, { max: MAX_LOTS })
    assert.equal(res.ok, true)
    assert.equal(res.empty, true)
    assert.equal(res.value, null, 'must be null, NOT 0')
  }
  // And the draft renderer round-trips null to '' — never "0".
  assert.equal(lotSizeToText(null), '')
  assert.equal(lotSizeToText(undefined), '')
  assert.notEqual(lotSizeToText(null), '0')
})

// ── 6/7/8/9/10. The documented lot values are enterable; > MAX_LOTS is not ──
t('6/7/8/9. 0.5 / 1 / 1.25 / 10 are all enterable', () => {
  for (const [text, expect] of [['0.5', 0.5], ['1', 1], ['1.25', 1.25], ['10', 10], ['0.01', 0.01], ['5', 5]]) {
    const res = validateLotSize(text, { max: MAX_LOTS })
    assert.equal(res.ok, true, `${text} must be accepted`)
    assert.equal(res.value, expect)
    assert.equal(res.empty, false)
  }

// ── 11/12/13. Manual Risk input behaviour ──────────────────────────────────
t('11. Manual Risk is independently editable within the canonical range', () => {
  for (const [text, expect] of [['25', 25], ['0.5', 0.5], ['1', 1], ['50', 50], ['12.5', 12.5]]) {
    const res = validateManualRiskPct(text)
    assert.equal(res.ok, true, `${text} must be accepted`)
    assert.equal(res.value, expect)
  }
  // Range is the existing canonical ceiling — no new frontend range invented.
  assert.equal(validateManualRiskPct(String(MANUAL_MAX_RISK_PCT_CEILING)).ok, true)
  for (const bad of ['0', '-1', '50.01', '100', 'abc']) {
    assert.equal(validateManualRiskPct(bad).ok, false, `${bad} must be rejected`)
  }
})

t('12. the Manual Risk draft can be temporarily empty', () => {
  for (const empty of ['', '   ', null, undefined]) {
    const res = validateManualRiskPct(empty)
    assert.equal(res.ok, true, 'an empty draft is not an error')
    assert.equal(res.empty, true)
  }
  // Mid-typing states stay typeable (no stale error while the user types).
  for (const partial of ['0', '0.', '1.', '12']) assert.equal(isPartialRiskInput(partial), true)
})

t('13. an empty Manual Risk commits to null, never to 0', () => {
  const res = validateManualRiskPct('')
  assert.equal(res.empty, true)
  assert.equal(res.value, null, 'must be null, NOT 0')
  assert.notEqual(res.value, 0)
  // Persisting that null must not coerce to 0 either.
  const saved = normaliseSizingSettings({ manualRiskPct: null, manualLots: 10 })
  assert.equal(saved.ok, true)
  assert.equal(saved.manualRiskPct, null)
})

// ── 14/15. Independence of the two inputs ──────────────────────────────────
t('14. changing Manual Risk leaves Manual Lots unchanged', () => {
  const a = view({ manualLots: 10, manualRiskPct: 25 })
  const b = view({ manualLots: 10, manualRiskPct: 50 })
  assert.equal(rowVal(a, 'lots'), '10.00 lots')
  assert.equal(rowVal(b, 'lots'), '10.00 lots', 'lots are untouched by a risk change')
  assert.equal(b.preview.requestedLots, 10)
  assert.equal(rowVal(a, 'risk'), '25%')
  assert.equal(rowVal(b, 'risk'), '50%')
})

t('15. changing Manual Lots leaves Manual Risk unchanged', () => {
  const a = view({ manualLots: 1, manualRiskPct: 25 })
  const b = view({ manualLots: 10, manualRiskPct: 25 })
  assert.equal(rowVal(a, 'risk'), '25%')
  assert.equal(rowVal(b, 'risk'), '25%', 'the risk setting is untouched by a lots change')
  // A bigger position with the same budget gets a TIGHTER stop.
  assert.equal(a.preview.rawSlPips, 250)
  assert.equal(b.preview.rawSlPips, 25)
})

// ── 16. 10 lots / 10% → Cannot Execute ─────────────────────────────────────
t('16. 10 lots / 10% → Cannot Execute, lots remain 10', () => {
  const v = view({ manualLots: 10, manualRiskPct: 10 })
  assert.equal(v.statusLabel, 'Cannot Execute')
  assert.equal(v.preview.status, 'CANNOT_EXECUTE')
  assert.equal(rowVal(v, 'lots'), '10.00 lots', 'the request is NOT rewritten')
  assert.equal(v.preview.requestedLots, 10)
  assert.equal(rowVal(v, 'budget'), '$1,000.00')
  assert.equal(rowVal(v, 'rawsl'), '10 pips')
  assert.match(v.constraint, /below the minimum permitted/)
  assert.match(v.constraint, new RegExp(String(minStopPips('XAU/USD'))))
  console.log(`     10%: ${v.statusLabel} · ${v.constraint}`)
})

// ── 17. 10 lots / 25% → Executable ─────────────────────────────────────────
t('17. 10 lots / 25% → Executable with every required row populated', () => {
  const v = view({ manualLots: 10, manualRiskPct: 25 })
  assert.equal(v.statusLabel, 'Executable')
  assert.equal(rowVal(v, 'lots'), '10.00 lots')
  assert.equal(rowVal(v, 'risk'), '25%')
  assert.equal(rowVal(v, 'budget'), '$2,500.00')
  assert.equal(rowVal(v, 'rawsl'), '25 pips')
  assert.equal(rowVal(v, 'fsl'), '25 pips')
  assert.equal(rowVal(v, 'loss'), '−$2,500.00')
  assert.equal(rowVal(v, 'arpct'), '25%')
  assert.equal(v.constraint, null, 'no constraint when nothing binds')
})


// ── 18/19. 10 lots / 50% → cap visible, budget ≠ actual risk ───────────────
t('18/19. 10 lots / 50% → cap shown; budget and ACTUAL risk shown separately', () => {
  const v = view({ manualLots: 10, manualRiskPct: 50 })
  assert.equal(v.statusLabel, 'Executable')
  assert.equal(rowVal(v, 'risk'), '50%')
  assert.equal(rowVal(v, 'budget'), '$5,000.00', 'the BUDGET')
  assert.equal(rowVal(v, 'rawsl'), '50 pips')
  assert.equal(rowVal(v, 'fsl'), `${MIRROR_SL_CAP} pips`, 'final SL is capped')
  assert.equal(rowVal(v, 'loss'), '−$3,500.00', 'ACTUAL risk — NOT the $5,000 budget')
  assert.equal(rowVal(v, 'arpct'), '35%')
  assert.equal(v.constraint, 'Maximum SL cap applied')
  // The budget must never be presented as the expected loss.
  assert.notEqual(rowVal(v, 'loss'), rowVal(v, 'budget'))
  assert.ok(!rowVal(v, 'loss').includes('5,000'))
  console.log(`     50%: budget ${rowVal(v, 'budget')} rawSL ${rowVal(v, 'rawsl')} → ${rowVal(v, 'fsl')} · actual ${rowVal(v, 'loss')} (${rowVal(v, 'arpct')})`)
})

// ── 20. Actual account risk displayed ──────────────────────────────────────
t('20. actual account risk is surfaced, and never called "safe"', () => {
  const v = view({ manualLots: 10, manualRiskPct: 25 })
  assert.match(rowVal(v, 'arpct'), /%$/)
  assert.ok(v.notices.some(n => n.text.includes('25%')), 'exposure notice present')
  const all = JSON.stringify(v).toLowerCase()
  for (const bad of ['safe', 'recommended']) assert.ok(!all.includes(bad), `must not say "${bad}"`)
})

// ── 21. TP derives from the preview (final SL) ─────────────────────────────
t('21. TP comes from the preview result and follows the FINAL SL', () => {
  const v = view({ manualLots: 10, manualRiskPct: 25 })
  assert.equal(rowVal(v, 'tp'), `${v.preview.tpPips} pips`)
  assert.equal(v.preview.tpPips, 50, '25p final SL × strategy R:R 2')
  // When the SL is capped, the TP follows the CAPPED stop, not the raw one.
  const capped = view({ manualLots: 10, manualRiskPct: 50 })
  assert.equal(capped.preview.tpPips, MIRROR_SL_CAP * 2)
  assert.notEqual(capped.preview.tpPips, capped.preview.rawSlPips * 2)
  assert.equal(rowVal(capped, 'tp'), `${MIRROR_SL_CAP * 2} pips`)
})

// ── 22. AUTO comparison notice ─────────────────────────────────────────────
t('22. Manual Risk above the AUTO risk shows a NEUTRAL informational notice', () => {
  const v = view({ manualLots: 10, manualRiskPct: 25, autoRiskPct: 1 })
  const notice = v.notices.find(n => n.tone === 'info')
  assert.ok(notice, 'comparison notice present')
  assert.match(notice.text, /25% risk budget/)
  assert.match(notice.text, /Automatic sizing currently uses 1%/)
  assert.equal(v.statusLabel, 'Executable', 'a difference is informational, never a block')
  assert.equal(v.preview.requestedLots, 10, 'lots are not reduced because they differ')
  assert.equal(v.preview.manualRiskPct, 25, 'risk is not rewritten because they differ')
  const same = view({ manualLots: 10, manualRiskPct: 1, autoRiskPct: 1 })
  assert.equal(same.notices.some(n => n.tone === 'info'), false)
})

// ── 7 (missing data). Never fabricate account or geometry ──────────────────
t('7. missing data → explicit awaiting state, never fake zeroes', () => {
  const v = view({ manualLots: 10, manualRiskPct: 25, balance: 0 })
  assert.equal(v.preview.status, 'AWAITING_DATA')
  assert.equal(v.statusLabel, 'Awaiting account data')
  for (const key of ['bal', 'budget', 'rawsl', 'fsl', 'loss', 'arpct', 'tp']) {
    assert.equal(rowVal(v, key), null, `${key} must be null, not a fabricated 0`)
  }
  // Application Maximum and the mode are still real values.
  assert.equal(rowVal(v, 'max'), `${MAX_LOTS.toFixed(2)} lots`)
  assert.equal(rowVal(v, 'mode'), 'Manual')
  assert.ok(!JSON.stringify(v.rows).includes('$0'), 'must never render a fake $0')
})

// ── 12 (copy). MAX_LOTS is an application ceiling, not "safe" ─────────────
t('12. 10 lots is labelled as the APPLICATION maximum only', () => {
  const v = view({ manualLots: 10, manualRiskPct: 25 })
  const max = v.rows.find(r => r.key === 'max')
  assert.equal(max.label, 'Application Maximum')
  assert.equal(max.value, `${MAX_LOTS.toFixed(2)} lots`)
  const labels = v.rows.map(r => r.label).join(' ').toLowerCase()
  for (const bad of ['safe', 'recommended']) assert.ok(!labels.includes(bad), `no "${bad}" label`)
})

})

t('10. above MAX_LOTS is rejected', () => {
  for (const bad of ['10.01', '11', '50']) {
    const res = validateLotSize(bad, { max: MAX_LOTS })
    assert.equal(res.ok, false, `${bad} must be rejected`)
    assert.ok(res.error)
  }
  // …and the shared strategy validator agrees at the same boundary.
  assert.equal(normaliseSizingSettings({ manualLots: MAX_LOTS }).ok, true)
  assert.equal(normaliseSizingSettings({ manualLots: MAX_LOTS + 0.01 }).ok, false)
})


// ── 23/24/25. Save → reload stability ─────────────────────────────────────
t('23/24. save/reload restores Manual Lots AND Manual Risk', () => {
  // "Save" through the real validator the route uses, then "reload" it back.
  const saved = normaliseSizingSettings({ manualLots: 10, manualRiskPct: 25, riskPct: 1, slPips: 25, tpPips: 50 })
  assert.equal(saved.ok, true)
  const reloaded = { ...saved.normalised }
  assert.equal(reloaded.manualLots, 10, 'Manual Lots survives the round trip')
  assert.equal(reloaded.manualRiskPct, 25, 'Manual Risk survives the round trip')
  // The reloaded values reproduce an identical view.
  const v = view({ manualLots: reloaded.manualLots, manualRiskPct: reloaded.manualRiskPct })
  assert.equal(v.mode, 'MANUAL')
  assert.equal(rowVal(v, 'lots'), '10.00 lots')
  assert.equal(rowVal(v, 'risk'), '25%')
  assert.equal(v.statusLabel, 'Executable')
})

t('25. clearing Manual Lots returns to AUTO without erasing saved Manual Risk', () => {
  const saved = normaliseSizingSettings({ manualLots: 10, manualRiskPct: 30 })
  assert.equal(saved.manualLots, 10)
  // User clears the field and saves again.
  const after = normaliseSizingSettings({ manualLots: '', manualRiskPct: saved.normalised.manualRiskPct })
  assert.equal(after.ok, true)
  assert.equal(after.manualLots, null, 'lots go to null (AUTO)')
  assert.equal(after.manualRiskPct, 30, 'the Manual Risk preference is PRESERVED')
  assert.equal(after.normalised.manualRiskPct, 30)
  // And the re-loaded strategy renders AUTO, with the preference intact for later.
  const v = view({ manualLots: after.normalised.manualLots, manualRiskPct: after.normalised.manualRiskPct })
  assert.equal(v.mode, 'AUTO')
  assert.equal(v.preview.status, 'EXECUTABLE')
  assert.equal(v.preview.actualRiskUsd, null, 'AUTO performs no manual arithmetic')
})

t('AUTO: manualRiskPct has ZERO influence on the AUTO view', () => {
  const a = view({ manualLots: null, manualRiskPct: 1 })
  const b = view({ manualLots: null, manualRiskPct: 50 })
  assert.deepEqual(a.rows, b.rows, 'identical AUTO rows for any manualRiskPct')
  assert.equal(a.preview.manualRiskPct, null)
  assert.equal(b.preview.manualRiskPct, null)
})

t('legacy strategy without manualRiskPct falls back to the ONE canonical default', () => {
  // The policy carries no default, so the strategy layer must supply it.
  const v = view({ manualLots: 10, manualRiskPct: null, defaultManualRiskPct: DEFAULT_STRATEGY.manualRiskPct })
  assert.equal(v.preview.manualRiskPct, DEFAULT_STRATEGY.manualRiskPct)
  assert.equal(v.statusLabel, 'Executable')
  assert.ok(v.notices.some(n => /No Manual Risk % saved/.test(n.text)), 'the fallback is disclosed, not silent')
})

// ── The page is actually WIRED to the shared view model ───────────────────
t('the real page renders the shared view model (no sizing maths in JSX)', () => {
  const page = readFileSync(new URL('../components/pages/StrategyPage.tsx', import.meta.url), 'utf8')
  assert.match(page, /buildStrategySizingView\(/, 'the page must consume the shared view model')
  assert.match(page, /from '@\/lib\/strategy-sizing-view\.mjs'/, 'imported from the shared module')
  assert.match(page, /sizingView\.rows\.map/, 'the page must RENDER the view model rows')
  assert.match(page, /Manual risk %/, 'the Manual Risk input must exist')
  // The stale, drifted implementation must be gone: it hardcoded the SL cap at 25
  // (MIRROR_SL_CAP is 35) and promised the silent reduction we removed.
  assert.equal(/slCap\s*=\s*25/.test(page), false, 'the hardcoded 25-pip cap must be gone')
  assert.equal(/pipPerLotXau\s*=\s*10/.test(page), false, 'the local pip-value guess must be gone')
  assert.equal(/orders route will reduce to/.test(page), false, 'the silent-reduction promise must be gone')
  // Draft/commit inputs are still string-bound (never number-bound, never clamped).
  assert.match(page, /value=\{lotsText\}/)
  assert.match(page, /value=\{riskText\}/)
})

// ── Geometry is resolved from the authoritative source ────────────────────
t('geometry comes from the broker interface, not a local guess', () => {
  const g = geometryForPair('XAU/USD')
  assert.equal(g.pipValuePerLot, 10)
  assert.equal(g.brokerMinStopPips, minStopPips('XAU/USD'))
  assert.equal(g.slCapPips, MIRROR_SL_CAP)
  assert.equal(g.slCapPips, 35, 'the real MIRROR_SL_CAP — NOT the stale 25 the UI used to show')
})

if (failed) { console.error(`\n${failed} failed`); process.exit(1) }
console.log('strategy-page sizing: all tests passed')
