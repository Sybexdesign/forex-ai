// tests/shadow-analysis.test.mjs
// Profit-protection SHADOW STUDY — pure analysis regression tests.
// Covers classification precedence, zone/capture aggregation, sample adequacy
// and the report's safety surfacing. No DB, no network, no trading logic.
// Run: npm run test:shadow-analysis
import assert from 'node:assert/strict'
import {
  classify, withClassification, materialityThreshold, zoneReport,
  captureEfficiency, sampleAdequacy, buildReport, CLASSIFICATIONS, ZONE_ORDER,
} from '../lib/shadow-analysis.mjs'

const base = (over = {}) => ({
  brokerTicket: 'T1', tradeId: 'id-1', direction: 'BUY',
  zone: 'B', riskUsd: 40, peakR: 0.8,
  actualRealisedPnlUsd: 10, actualMfeUsd: 40, actualCaptureEfficiency: 0.25,
  estShadowPnlUsd: 10, estShadowCaptureEfficiency: 0.25,
  actualRealisedSource: 'broker', highestStage: 'PROTECT', highestTargetFloorUsd: 0,
  hadEarlyRescueTrigger: false, preventedRoundTripEst: false, clippedEst: false,
  shadowCommandEmitted: false, deltaUsd: 0,
  ...over,
})

let failures = 0
const test = (name, fn) => {
  try { fn(); console.log(`  ok  ${name}`) }
  catch (e) { failures += 1; console.error(`  FAIL ${name}\n       ${e.message}`) }
}

console.log('shadow-analysis')

// ── 1. Classification precedence ─────────────────────────────────────────────
test('no realised result → INSUFFICIENT DATA', () => {
  assert.equal(classify(base({ actualRealisedPnlUsd: null })), 'INSUFFICIENT DATA')
})
test('no positive MFE → INSUFFICIENT DATA even with a result', () => {
  assert.equal(classify(base({ actualMfeUsd: 0 })), 'INSUFFICIENT DATA')
})
test('round-trip rescue outranks everything else', () => {
  assert.equal(
    classify(base({ preventedRoundTripEst: true, hadEarlyRescueTrigger: true, actualRealisedPnlUsd: -8, estShadowPnlUsd: -1.5 })),
    'ROUND-TRIP PREVENTED')
})
test('a risk signal outranks a favourable dollar delta', () => {
  // Shadow would clip a winner. Must NOT be reported as an improvement.
  assert.equal(
    classify(base({ clippedEst: true, actualRealisedPnlUsd: 60, estShadowPnlUsd: 30, deltaUsd: -30 })),
    'POSSIBLE WINNER CLIP')
})
test('early-BE that would kill a runner → EARLY-BE POSSIBLY PREMATURE', () => {
  assert.equal(
    classify(base({ hadEarlyRescueTrigger: true, actualRealisedPnlUsd: 50, estShadowPnlUsd: 20, deltaUsd: -30 })),
    'EARLY-BE POSSIBLY PREMATURE')
})
test('materially better shadow → SHADOW IMPROVED', () => {
  assert.equal(classify(base({ actualRealisedPnlUsd: 5, estShadowPnlUsd: 20, deltaUsd: 15 })), 'SHADOW IMPROVED')
})
test('within the materiality band → NO MATERIAL DIFFERENCE', () => {
  assert.equal(classify(base({ actualRealisedPnlUsd: 10, estShadowPnlUsd: 10.4, deltaUsd: 0.4 })), 'NO MATERIAL DIFFERENCE')
})
test('materiality scales with 1R, not a fixed dollar', () => {
  assert.equal(materialityThreshold(40), 2)      // 5% of 40
  assert.equal(materialityThreshold(20), 1)      // floor of $1
  assert.equal(materialityThreshold(0), 1)       // unusable risk → floor
  assert.equal(materialityThreshold(null), 1)
  // A $3 delta is noise at 1R=$200 but material at 1R=$20.
  assert.equal(classify(base({ riskUsd: 200, actualRealisedPnlUsd: 60, estShadowPnlUsd: 63, deltaUsd: 3 })), 'NO MATERIAL DIFFERENCE')
  assert.equal(classify(base({ riskUsd: 20, actualRealisedPnlUsd: 10, estShadowPnlUsd: 13, deltaUsd: 3 })), 'SHADOW IMPROVED')
})
test('classify never returns a value outside CLASSIFICATIONS', () => {
  const cases = [
    { actualRealisedPnlUsd: null }, { actualMfeUsd: 0 }, { preventedRoundTripEst: true },
    { hadEarlyRescueTrigger: true, deltaUsd: -99 }, { clippedEst: true, deltaUsd: -99 },
  ]
  for (const c of cases) assert.ok(CLASSIFICATIONS.includes(classify(base(c))), `unexpected: ${classify(base(c))}`)
})

// ── 2. Zone bucketing follows the brief's boundaries exactly ─────────────────
test('zoneReport buckets at <0.5, 0.5-1.2, 1.2-2.0, >=2.0', () => {
  const z = zoneReport([
    base({ zone: 'A', actualRealisedPnlUsd: -20 }), base({ zone: 'A', actualRealisedPnlUsd: -20 }),
    base({ zone: 'B', actualRealisedPnlUsd: 10 }),
    base({ zone: 'C', actualRealisedPnlUsd: 30 }),
    base({ zone: 'SR', actualRealisedPnlUsd: 100, estShadowPnlUsd: 40, actualMfeUsd: 200 }),
  ])
  assert.equal(z.A.count, 2)
  assert.equal(z.B.count, 1)
  assert.equal(z.C.count, 1)
  assert.equal(z.SR.count, 1)
  assert.equal(z.A.actualTotalPnlUsd, -40)
  assert.equal(z.SR.actualTotalPnlUsd, 100)
  assert.equal(z.SR.estShadowTotalPnlUsd, 40)
  for (const k of ZONE_ORDER) assert.ok(z[k], `missing zone ${k}`)
})

// ── 3. Capture efficiency ────────────────────────────────────────────────────
test('capture buckets and positive-MFE-ending-in-loss are counted', () => {
  const c = captureEfficiency([
    base({ actualCaptureEfficiency: 0.1, estShadowCaptureEfficiency: 0.1, actualRealisedPnlUsd: -5, actualMfeUsd: 30 }),
    base({ actualCaptureEfficiency: 0.4, estShadowCaptureEfficiency: 0.6 }),
    base({ actualCaptureEfficiency: 0.9, estShadowCaptureEfficiency: 0.9 }),
    base({ actualCaptureEfficiency: null, estShadowCaptureEfficiency: null }),
  ])
  assert.equal(c.actual.count, 3)
  assert.equal(c.actual.buckets.lt25, 1)
  assert.equal(c.actual.buckets.p25_50, 1)
  assert.equal(c.actual.buckets.gt75, 1)
  assert.equal(c.positiveMfeEndingInLoss.actual, 1)
})

// ── 4. Sample adequacy drives the recommendation ─────────────────────────────
test('a small one-sided sample is NOT adequate, with reasons', () => {
  const a = sampleAdequacy([base({ zone: 'A' }), base({ zone: 'A' })])
  assert.equal(a.adequate, false)
  assert.ok(a.reasons.length >= 2)
  assert.ok(a.reasons.some((r) => /target >= 20/.test(r)))
  assert.ok(a.reasons.some((r) => /one-sided/.test(r)))
})
test('a large diverse sample IS adequate', () => {
  const many = []
  for (let i = 0; i < 21; i += 1) {
    many.push(base({ zone: 'A', direction: i % 2 ? 'BUY' : 'SELL' }))
    many.push(base({ zone: 'B', direction: i % 2 ? 'BUY' : 'SELL' }))
    many.push(base({ zone: 'C', direction: i % 2 ? 'BUY' : 'SELL' }))
  }
  const a = sampleAdequacy(many)
  assert.equal(a.adequate, true, a.reasons.join('; '))
  assert.deepEqual(a.zonesCovered, ['A', 'B', 'C'])
})

// ── 5. Report surfaces shadow leakage instead of burying it ──────────────────
test('a shadow command leak is CRITICAL and names the ticket', () => {
  const r = buildReport([base({ shadowCommandEmitted: true, brokerTicket: 'T-LEAK' })])
  assert.equal(r.shadowSafety.shadowCommandEmittedCount, 1)
  assert.deepEqual(r.shadowSafety.tickets, ['T-LEAK'])
  assert.match(r.shadowSafety.verdict, /CRITICAL/)
})
test('a clean sample says so, and every estimated figure stays labelled', () => {
  const r = buildReport([base(), base({ actualRealisedPnlUsd: -20, estShadowPnlUsd: -1.5 })])
  assert.match(r.shadowSafety.verdict, /^OK/)
  assert.equal(r.estShadow.label, 'COUNTERFACTUAL / ESTIMATED')
  assert.equal(r.perTrade.length, 2)
  assert.ok(r.caveats.some((c) => /COUNTERFACTUAL/.test(c)))
})
test('an empty sample produces a zeroed report rather than throwing', () => {
  const r = buildReport([])
  assert.equal(r.sample.tradeCount, 0)
  assert.equal(r.actual.totalRealisedPnlUsd, 0)
  assert.equal(r.adequacy.adequate, false)
  assert.equal(r.shadowSafety.shadowCommandEmittedCount, 0)
})

// ── 6. withClassification preserves the source fields ────────────────────────
test('withClassification adds classification and delta without dropping fields', () => {
  const c = withClassification(base({ actualRealisedPnlUsd: 10, estShadowPnlUsd: 25 }))
  assert.equal(c.classification, 'SHADOW IMPROVED')
  assert.equal(c.deltaUsd, 15)
  assert.equal(c.brokerTicket, 'T1')
  assert.equal(c.riskUsd, 40)
})

if (failures) { console.error(`\n${failures} shadow-analysis test(s) failed`); process.exit(1) }
console.log('shadow-analysis: all tests passed')

