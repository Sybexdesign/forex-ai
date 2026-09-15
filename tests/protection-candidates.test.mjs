// tests/protection-candidates.test.mjs
// ATR graceful-degradation: an R/MFE protection path must exist independently of
// ATR. NOTHING here activates live protection.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  composeProtection, classifyAtr, ATR_REASON,
  atrTrailCandidate, breakEvenCandidate, partialLockCandidate,
} from '../lib/protection-candidates.mjs'

const PIP = 0.1, PVPL = 10, LOTS = 0.14, RISK = 20
const ENTRY = 2000
// 1R in PRICE terms for XAU at 0.14 lots: £20 / (10 pips × £10 × 0.14) = 1.4286
const RISK_PRICE = RISK / (10 * PVPL * LOTS)
const priceAtR = (r) => ENTRY + r * RISK_PRICE

let failed = 0
const t = (name, fn) => {
  try { fn(); console.log('  ok   ' + name) }
  catch (e) { failed++; console.error('  FAIL ' + name + '\n        ' + e.message) }
}
const base = (over = {}) => ({
  dir: 'BUY', entry: ENTRY, currentSl: ENTRY - RISK_PRICE, lots: LOTS,
  pip: PIP, pipValuePerLot: PVPL, plannedRiskUsd: RISK,
  currentProfit: 0, peakProfit: 0, stage: '', retentionFloorUsd: 0,
  riskPrice: RISK_PRICE, lockR: 0.5, midPx: priceAtR(2.0),
  atrCandles: 30, atrMult: 0.5, ...over,
})

console.log('protection-candidates')

// ── 1-6. ATR availability is explicit ────────────────────────────────────────
t('1. ATR valid → available + value', () => {
  const s = classifyAtr({ atr: 2.0, candles: 30, midPx: 2000 })
  assert.equal(s.available, true); assert.equal(s.eligible, true)
  assert.equal(s.reason, ATR_REASON.AVAILABLE); assert.equal(s.value, 2.0)
})
t('2. ATR missing → explicit no-data reason', () => {
  assert.equal(classifyAtr({ atr: undefined, candles: 30, midPx: 2000 }).reason, ATR_REASON.NO_DATA)
  assert.equal(classifyAtr({ atr: null, candles: 30, midPx: 2000 }).reason, ATR_REASON.NO_DATA)
})
t('3. ATR zero → explicit zero reason', () => {
  assert.equal(classifyAtr({ atr: 0, candles: 30, midPx: 2000 }).reason, ATR_REASON.ZERO)
  assert.equal(classifyAtr({ atr: 0, candles: 30, midPx: 2000 }).available, false)
})
t('4. ATR NaN → explicit invalid reason', () => {
  assert.equal(classifyAtr({ atr: NaN, candles: 30, midPx: 2000 }).reason, ATR_REASON.INVALID)
})
t('5. insufficient candles → explicit reason', () => {
  assert.equal(classifyAtr({ atr: 2.0, candles: 5, requiredCandles: 14, midPx: 2000 }).reason, ATR_REASON.INSUFFICIENT_CANDLES)
})
t('6. missing candle cache / invalid market price → explicit reason', () => {
  assert.equal(classifyAtr({ atr: null, candles: null, midPx: 2000 }).reason, ATR_REASON.NO_CANDLE_CACHE)
  assert.equal(classifyAtr({ atr: 2.0, candles: 30, midPx: 0 }).reason, ATR_REASON.INVALID_PRICE)
  assert.equal(classifyAtr({ atr: 2.0, candles: 30, midPx: -1 }).reason, ATR_REASON.INVALID_PRICE)
})

// ── 7 + 11. THE £53 REGRESSION ───────────────────────────────────────────────
// plannedRisk £20, peak £53 → peakR 2.65 → STRONG band (75%) → 1.9875R ≈ £39.75
const PEAK = 53
const CUR  = 43            // retraced into the ratchet commit window
const peakR = PEAK / RISK  // 2.65
const TARGET_R = peakR * 0.75

t('11. £53 peak: ATR AVAILABLE → candidates compete', () => {
  const res = composeProtection(base({
    currentProfit: CUR, peakProfit: PEAK,
    midPx: priceAtR(peakR), atr: 1.5,
  }))
  const d = res.diagnostics
  console.log(`\n  Case A (ATR available): peakR=${d.peakR?.toFixed(3)} atr=${d.atrValue} ` +
    `atrCand=${d.atrCandidateR?.toFixed(3)}R mfeCand=${d.mfeCandidateR?.toFixed(3)}R ` +
    `existing=${d.existingR?.toFixed(3)}R → selected=${d.selectedRule} @ ${d.finalSl?.toFixed(3)}`)
  assert.equal(d.atrAvailable, true)
  assert.ok(d.atrCandidateR !== null, 'ATR must produce a candidate')
  assert.ok(d.mfeCandidateR !== null, 'MFE must produce a candidate')
  // ATR (ATR 1.5 × 0.5 = 0.75 price below peak) is tighter than MFE here.
  assert.ok(Math.abs(d.mfeCandidateR - TARGET_R) < 1e-3, `MFE candidate ≈ ${TARGET_R}`)
  assert.equal(d.selectedRule, 'ATR')
})

t('11. £53 peak: ATR UNAVAILABLE → MFE still protects (NOT just +0.5R)', () => {
  const res = composeProtection(base({ currentProfit: CUR, peakProfit: PEAK, atr: null, atrCandles: null }))
  const d = res.diagnostics
  console.log(`  Case B (ATR unavailable): peakR=${d.peakR?.toFixed(3)} atrAvailable=${d.atrAvailable} ` +
    `atrReason=${d.atrReason} atrCand=${d.atrCandidateR} mfeCand=${d.mfeCandidateR?.toFixed(3)}R ` +
    `→ selected=${d.selectedRule}`)
  assert.equal(d.atrAvailable, false)
  assert.equal(d.atrReason, ATR_REASON.NO_CANDLE_CACHE)
  assert.equal(d.atrCandidateR, null, 'no ATR candidate may be fabricated')
  // THE POINT: losing ATR must NOT lose the MFE candidate.
  assert.ok(d.mfeCandidateR !== null, 'ATR absence must not remove MFE protection')
  assert.equal(d.selectedRule, 'MFE')
  const protectedR = d.mfeCandidateR
  assert.ok(Math.abs(protectedR - TARGET_R) < 1e-3, `protected ${protectedR} ≈ ${TARGET_R}`)
  console.log(`  → ATR unavailable: protected ${protectedR.toFixed(4)}R (${(protectedR / peakR * 100).toFixed(1)}%) ` +
    `vs old static +0.5R (20.0% retention)`)
  assert.ok(protectedR > 0.5 * 3, 'must be far better than the old static +0.5R floor')
})

t('7. ATR unavailable must NOT collapse to the static +0.5R partial lock', () => {
  const res = composeProtection(base({ currentProfit: CUR, peakProfit: PEAK, atr: null, atrCandles: null }))
  assert.equal(res.diagnostics.partialCandidateR, 0.5, 'the static partial lock is +0.5R')
  assert.notEqual(res.diagnostics.selectedRule, 'PARTIAL_LOCK', 'MFE must beat the static lock')
  assert.ok(res.diagnostics.mfeCandidateR > res.diagnostics.partialCandidateR)
})

// ── 8-10. Candidate selection ────────────────────────────────────────────────
const sellPriceAtR = (r) => ENTRY - r * RISK_PRICE
const sellBase = (over = {}) => base({ dir: 'SELL', currentSl: ENTRY + RISK_PRICE, midPx: sellPriceAtR(2.65), ...over })

t('8. ATR tighter than MFE → ATR wins (BUY)', () => {
  const d = composeProtection(base({ currentProfit: CUR, peakProfit: PEAK, atr: 1.5, midPx: priceAtR(2.65) })).diagnostics
  assert.ok(d.atrCandidateR > d.mfeCandidateR, `${d.atrCandidateR} > ${d.mfeCandidateR}`)
  assert.equal(d.selectedRule, 'ATR')
})

t('9. MFE tighter than ATR → MFE wins (BUY)', () => {
  const d = composeProtection(base({ currentProfit: CUR, peakProfit: PEAK, atr: 3.0, midPx: priceAtR(2.65) })).diagnostics
  assert.ok(d.atrCandidateR < d.mfeCandidateR, `${d.atrCandidateR} < ${d.mfeCandidateR}`)
  assert.equal(d.selectedRule, 'MFE')
})

t('10. existing live SL tighter than both → existing remains untouched', () => {
  const live = priceAtR(2.2)
  const d = composeProtection(base({ currentProfit: CUR, peakProfit: PEAK, atr: 1.5, midPx: priceAtR(2.65), currentSl: live })).diagnostics
  assert.ok(d.existingR > d.atrCandidateR && d.existingR > d.mfeCandidateR)
  assert.equal(d.selectedRule, 'EXISTING_SL')
  assert.equal(d.wouldModify, false, 'nothing may be proposed when the live SL already wins')
  assert.ok(Math.abs(d.finalSl - live) < 1e-12, 'the live SL must be returned unchanged')
})

t('11/12. BUY and SELL select the symmetric candidate', () => {
  const b = composeProtection(base({ currentProfit: CUR, peakProfit: PEAK, atr: 1.5, midPx: priceAtR(2.65) })).diagnostics
  const s = composeProtection(sellBase({ currentProfit: CUR, peakProfit: PEAK, atr: 1.5 })).diagnostics
  assert.equal(s.selectedRule, b.selectedRule, 'selected rule must match')
  assert.ok(Math.abs(s.mfeCandidateR - b.mfeCandidateR) < 1e-9, 'MFE candidate R must be symmetric')
  assert.ok(Math.abs(s.atrCandidateR - b.atrCandidateR) < 1e-3, 'ATR candidate R must be symmetric')
  assert.ok(s.finalSl < ENTRY, 'SELL protection sits BELOW entry')
  assert.ok(b.finalSl > ENTRY, 'BUY protection sits ABOVE entry')
})

// ── 13-14. Fail closed ───────────────────────────────────────────────────────
t('13. invalid planned risk → MFE fails closed with an explicit reason', () => {
  for (const bad of [undefined, null, 0, -20, NaN, Infinity]) {
    const res = composeProtection(base({ currentProfit: CUR, peakProfit: PEAK, atr: null, atrCandles: null, plannedRiskUsd: bad }))
    assert.equal(res.diagnostics.mfeCandidateR, null, `risk=${bad} must yield no MFE candidate`)
    assert.equal(res.diagnostics.mfeReason, 'profit-protection-risk-unavailable')
    assert.equal(res.diagnostics.reason, 'profit-protection-risk-unavailable')
    assert.equal(res.diagnostics.currentR, null, 'no R may be manufactured')
  }
})

t('14. invalid geometry → MFE fails closed with an explicit reason', () => {
  for (const bad of [{ pip: 0 }, { pipValuePerLot: 0 }, { lots: 0 }, { pip: NaN }]) {
    const res = composeProtection(base({ currentProfit: CUR, peakProfit: PEAK, atr: null, atrCandles: null, ...bad }))
    assert.equal(res.diagnostics.mfeCandidateR, null, `${JSON.stringify(bad)} must yield no MFE candidate`)
    assert.equal(res.diagnostics.mfeReason, 'profit-protection-geometry-unavailable')
    assert.equal(res.diagnostics.atrCandidateR, null, 'no ATR candidate without geometry either')
  }
})

// ── 15. ATR loss / recovery must be monotonic ────────────────────────────────
t('15. ATR loss and recovery cannot loosen protection', () => {
  const rOf = (sl) => ((sl - ENTRY) / PIP) * PVPL * LOTS / RISK

  // ── Case 1: ATR committed a TIGHTER stop than MFE ────────────────────────
  const c1 = composeProtection(base({ currentProfit: CUR, peakProfit: PEAK, atr: 1.5, midPx: priceAtR(peakR), currentSl: ENTRY - RISK_PRICE }))
  assert.equal(c1.diagnostics.selectedRule, 'ATR')
  // ATR disappears. The committed stop must simply hold — it is already tighter
  // than anything MFE can propose, so nothing should move.
  const c2 = composeProtection(base({ currentProfit: CUR, peakProfit: PEAK, atr: null, atrCandles: null, currentSl: c1.finalSl }))
  // The R/MFE path must still RUN — it evaluates and declines because the live
  // stop already protects more. "Available without ATR" means evaluable, not
  // necessarily winning; the reason proves it was reached.
  assert.equal(c2.diagnostics.mfeCandidateR, null)
  assert.equal(c2.diagnostics.mfeReason, 'current-sl-already-more-protective',
    'the R/MFE path must be evaluated and explain its decline without ATR')
  assert.equal(c2.diagnostics.reason, null, 'no fail-closed reason: planned risk and geometry are valid')
  assert.equal(c2.diagnostics.selectedRule, 'EXISTING_SL', 'an already-tighter committed stop holds')
  assert.equal(c2.diagnostics.wouldModify, false)
  const r1 = rOf(c1.finalSl), r2 = rOf(c2.finalSl)
  assert.ok(r2 >= r1 - 1e-9, `losing ATR must not loosen: ${r1} → ${r2}`)
  // ATR returns but proposes something WEAKER (wide ATR) — still must not loosen.
  const c3 = composeProtection(base({ currentProfit: CUR, peakProfit: PEAK, atr: 6.0, midPx: priceAtR(peakR), currentSl: c2.finalSl }))
  const r3 = rOf(c3.finalSl)
  console.log(`\n  ATR loss/recovery (ATR was tighter): c1(ATR)=${r1.toFixed(3)}R → c2(no ATR)=${r2.toFixed(3)}R → c3(weak ATR)=${r3.toFixed(3)}R`)
  assert.ok(c3.diagnostics.atrCandidateR < r2, `cycle 3 ATR (${c3.diagnostics.atrCandidateR?.toFixed(3)}R) must be weaker than the protection already committed (${r2.toFixed(3)}R)`)
  assert.ok(r3 >= r2 - 1e-9, 'a weaker ATR returning must not loosen protection')

  // ── Case 2: ATR was NOT the tightest (or never committed) → MFE takes over ─
  const wide = composeProtection(base({ currentProfit: CUR, peakProfit: PEAK, atr: 6.0, midPx: priceAtR(peakR), currentSl: ENTRY - RISK_PRICE }))
  assert.equal(wide.diagnostics.selectedRule, 'MFE', 'MFE is the tightest when ATR is wide')
  const gone = composeProtection(base({ currentProfit: CUR, peakProfit: PEAK, atr: null, atrCandles: null, currentSl: ENTRY - RISK_PRICE }))
  assert.equal(gone.diagnostics.selectedRule, 'MFE', 'MFE keeps protecting with no ATR at all')
  console.log(`  ATR absent from the start: MFE=${gone.diagnostics.mfeCandidateR.toFixed(3)}R selected (no ATR ever needed)`)
})

// ── 17-18. Shadow separation ─────────────────────────────────────────────────
t('17. this module cannot send a broker command (structural)', () => {
  const src = readFileSync(new URL('../lib/protection-candidates.mjs', import.meta.url), 'utf8')
  for (const banned of ['fetch(', '/api/orders', 'modify_sl', 'closePosition', 'broker.']) {
    assert.equal(src.includes(banned), false, `module must not contain ${banned}`)
  }
  const res = composeProtection(base({ currentProfit: CUR, peakProfit: PEAK, atr: null, atrCandles: null, mode: 'shadow' }))
  assert.equal(res.diagnostics.mode, 'shadow')
  assert.equal(typeof res.wouldModify, 'boolean', 'wouldModify is ADVISORY, not an action')
})

t('18. reporting is complete enough to explain any cycle (diagnostics contract)', () => {
  const d = composeProtection(base({ currentProfit: CUR, peakProfit: PEAK, atr: null, atrCandles: null })).diagnostics
  for (const k of ['atrAvailable', 'atrReason', 'atrValue', 'atrCandles', 'currentR', 'peakR',
    'atrCandidateR', 'mfeCandidateR', 'beCandidateR', 'partialCandidateR', 'existingR',
    'selectedRule', 'finalSl', 'wouldModify', 'mode']) {
    assert.ok(k in d, `diagnostics must expose ${k}`)
  }
})

if (failed) { console.error(`\n${failed} failed`); process.exit(1) }
console.log('protection-candidates: all tests passed')


