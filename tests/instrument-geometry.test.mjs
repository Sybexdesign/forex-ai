// tests/instrument-geometry.test.mjs
// Item 9 — validate /api/account.instrumentGeometry against the authoritative
// implementation, and pin the numbers every R figure in the study divides by.
//
// The values below are the contract in lib/brokers/interface.ts
// (getPipValue / getPipValuePerLot). They are duplicated here deliberately: a
// change to the authoritative tables must fail THIS test loudly rather than
// silently restate 1R for the whole sample. The last test asserts the literal
// source lines, so drift cannot hide.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { plannedRiskUsd } from '../lib/scalp-shadow-protection.mjs'

// Authoritative geometry, mirrored from interface.ts
const GEOMETRY = {
  'XAU/USD': { pip: 0.1,    pipValuePerLot: 10 },
  'XAG/USD': { pip: 0.01,   pipValuePerLot: 50 },
  'EUR/USD': { pip: 0.0001, pipValuePerLot: 10 },
  'USD/JPY': { pip: 0.01,   pipValuePerLot: 6.8 },
}

let failed = 0
const t = (name, fn) => {
  try { fn(); console.log('  ok   ' + name) }
  catch (e) { failed++; console.error('  FAIL ' + name + '\n        ' + e.message) }
}

console.log('instrument-geometry')

t('XAU/USD: 25 pips x $10/lot x 0.14 lots = $35', () => {
  const risk = plannedRiskUsd({ entry: 2000, initialSl: 1997.5, lots: 0.14, ...GEOMETRY['XAU/USD'] })
  assert.equal(risk, 35)
})

t('XAG/USD: 25 pips (0.25) x $50/lot x 0.10 lots = $125', () => {
  const risk = plannedRiskUsd({ entry: 25, initialSl: 24.75, lots: 0.10, ...GEOMETRY['XAG/USD'] })
  assert.equal(risk, 125)
})

t('EUR/USD: 20 pips (0.0020) x $10/lot x 0.10 lots = $20', () => {
  const risk = plannedRiskUsd({ entry: 1.1000, initialSl: 1.0980, lots: 0.10, ...GEOMETRY['EUR/USD'] })
  assert.equal(risk, 20)
})

t('USD/JPY: 20 pips (0.20) x $6.8/lot x 0.10 lots = $13.60', () => {
  const risk = plannedRiskUsd({ entry: 150.00, initialSl: 149.80, lots: 0.10, ...GEOMETRY['USD/JPY'] })
  assert.equal(risk, 13.6)
})

t('scaling is linear in lots', () => {
  const one = plannedRiskUsd({ entry: 2000, initialSl: 1997.5, lots: 0.14, ...GEOMETRY['XAU/USD'] })
  const two = plannedRiskUsd({ entry: 2000, initialSl: 1997.5, lots: 0.28, ...GEOMETRY['XAU/USD'] })
  assert.equal(two, one * 2)
})

t('geometry is LOAD-BEARING: a wrong pip value changes 1R', () => {
  const right = plannedRiskUsd({ entry: 2000, initialSl: 1997.5, lots: 0.14, pip: 0.1,  pipValuePerLot: 10 })
  const wrong = plannedRiskUsd({ entry: 2000, initialSl: 1997.5, lots: 0.14, pip: 0.01, pipValuePerLot: 10 })
  assert.equal(right, 35)
  assert.notEqual(wrong, right, '1R must actually depend on the pip size')
  assert.equal(wrong, 350, 'a 10x pip error must produce a visibly wrong 1R, not a silent one')
})

t('BUY and SELL are symmetric for the same distance', () => {
  const buy  = plannedRiskUsd({ entry: 2000, initialSl: 1997.5, lots: 0.14, ...GEOMETRY['XAU/USD'] })
  const sell = plannedRiskUsd({ entry: 2000, initialSl: 2002.5, lots: 0.14, ...GEOMETRY['XAU/USD'] })
  assert.equal(buy, sell)
})

t('unusable geometry is rejected rather than guessed', () => {
  const base = { entry: 2000, initialSl: 1997.5, lots: 0.14 }
  assert.equal(plannedRiskUsd({ ...base, pip: 0,              pipValuePerLot: 10 }), null)
  assert.equal(plannedRiskUsd({ ...base, pip: 0.1,            pipValuePerLot: 0  }), null)
  assert.equal(plannedRiskUsd({ ...base, pip: -0.1,           pipValuePerLot: 10 }), null)
  assert.equal(plannedRiskUsd({ ...base, pip: NaN,            pipValuePerLot: 10 }), null)
  assert.equal(plannedRiskUsd({ ...base, pip: undefined,      pipValuePerLot: 10 }), null)
  assert.equal(plannedRiskUsd({ ...base, pip: 0.1,            pipValuePerLot: undefined }), null)
})

t('the hardcoded table still matches interface.ts (drift guard)', () => {
  const src = readFileSync(new URL('../lib/brokers/interface.ts', import.meta.url), 'utf8')
  const pip = src.slice(src.indexOf('export function getPipValue('), src.indexOf('export function getPipValuePerLot('))
  const per = src.slice(src.indexOf('export function getPipValuePerLot('))
  assert.match(pip, /pair === 'XAU\/USD'\)\s*return 0\.1/,   'XAU pip changed in interface.ts')
  assert.match(pip, /pair\.includes\('XAG'\)\)\s*return 0\.01/, 'XAG pip changed in interface.ts')
  assert.match(per, /pair === 'XAU\/USD'\)\s*return 10/,     'XAU pipValuePerLot changed')
  assert.match(per, /pair === 'XAG\/USD'\)\s*return 50/,     'XAG pipValuePerLot changed')
  // The route must use the authoritative helpers, not a local copy.
  const route = readFileSync(new URL('../app/api/account/route.ts', import.meta.url), 'utf8')
  assert.match(route, /getPipValuePerLot/, 'route must obtain geometry from interface.ts')
  assert.match(route, /instrumentGeometry/, 'route must expose instrumentGeometry')
})

t('KNOWN HAZARD: unknown instruments fall back, so absence is the only real skip', () => {
  // getPipValuePerLot returns 10 and getPipValue returns 0.0001 for ANY
  // unrecognised pair. That means an instrument nobody has modelled yields a
  // plausible-looking geometry rather than a missing one — so the runtime's
  // "missing geometry ⇒ skip" guard protects against an ABSENT field, not
  // against a defaulted one. This assertion documents that boundary so the
  // limitation is visible rather than assumed away.
  const src = readFileSync(new URL('../lib/brokers/interface.ts', import.meta.url), 'utf8')
  const per = src.slice(src.indexOf('export function getPipValuePerLot('))
  const body = per.slice(0, per.indexOf('\n}'))
  assert.match(body, /return 10\s*$/m, 'a default fallback still exists for unknown pairs')
})

if (failed) { console.error(`\n${failed} failed`); process.exit(1) }
console.log('instrument-geometry: all tests passed')
