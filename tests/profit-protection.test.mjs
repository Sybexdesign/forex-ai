// tests/profit-protection.test.mjs
// Peak-giveback protection (calibrated to actual-R evidence, 1R≈$35 at 0.14 lots)
// Pure-model regression tests + SL-conversion + shadow-mode + selection proof.
// Run: npm run test:profit-protection
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  profitProtection, STAGE_RANK, profitFloorToSl, shadowDecision, pickMostProtectiveSl,
} from '../lib/profit-protection.mjs'
import { mergeTradeState } from '../lib/trade-state.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
// Test basis: XAU-style pip (0.1 price), pvpl=10, 0.14 lots, riskUsd=35 (≈ actual
// account: 25-pip SL × 10 × 0.14). For convenience most cases use riskUsd=40 with
// pvpl=1/lots=1 as pure-model maths; both verify the same rules.
const buy = (over = {}) => profitProtection({
  dir: 'BUY', entry: 2000, currentSl: 1999.5, currentProfit: 0, peakProfit: 0,
  riskUsd: 40, lots: 1, pipValuePerLot: 1, pip: 0.1, stage: '', retentionFloorUsd: 0,
  ...over,
})
const sell = (over = {}) => profitProtection({
  dir: 'SELL', entry: 2000, currentSl: 2000.5, currentProfit: 0, peakProfit: 0,
  riskUsd: 40, lots: 1, pipValuePerLot: 1, pip: 0.1, stage: '', retentionFloorUsd: 0,
  ...over,
})

// 1. Small profit + small pullback → no premature protection/close (room to run)
{
  const r = buy({ currentProfit: 8, peakProfit: 12 }) // peakR 0.3 — sub-0.5R
  assert.equal(r.action, null)
  assert.equal(r.closeRequested, false)
  assert.equal(r.newSl, null)
  console.log('PASS : small profit pullback → no premature close (normal noise tolerated)')
}

// 2. Strong profit → STRONG stage floor = 75% of the $80 peak
{
  const r = buy({ currentProfit: 63, peakProfit: 80 }) // peakR 2.0 ≥ 1.7
  assert.equal(r.stage, 'STRONG')
  assert.equal(r.floorUsd, 60) // 75% of $80 (target floor, not guaranteed fill)
  assert.ok(r.action && r.action.startsWith('ratchet-strong'))
  assert.notEqual(r.newSl, null)
  console.log('PASS : strong profit (2R peak) → STRONG ratchet target floor $60 of $80')
}

// 3. $60 peak giveback → LOCK target floor $39 banked before the old decay line
{
  const r = buy({ currentProfit: 41, peakProfit: 60, retentionFloorUsd: 0 }) // peakR 1.5 ≥ 1.0
  assert.equal(r.stage, 'LOCK')
  assert.equal(r.floorUsd, 39) // 65% of $60
  assert.ok(r.action && r.action.startsWith('ratchet-lock'))
  console.log('PASS : $60 peak → giveback to $41 → SL ratchets to $39 (was: realised ~$5-10)')
}

// 4. Collapse backstop (same trade later snapshot below floor) → close while in profit
{
  const r = buy({ currentProfit: 30, peakProfit: 60, stage: 'LOCK', retentionFloorUsd: 39 })
  assert.equal(r.closeRequested, true)
  assert.equal(r.action, 'giveback-collapse-close')
  assert.ok(r.floorUsd >= 39)
  console.log('PASS : retention collapsed through the floor between cycles → market-close backstop at $30, never at a loss')
}

// 5. New high → peak advances, stage and target floor advance monotonically
{
  let s = buy({ currentProfit: 41, peakProfit: 60 }) // LOCK floor $39
  assert.equal(s.stage, 'LOCK')
  const r2 = buy({ currentProfit: 95, peakProfit: 100, stage: s.stage, retentionFloorUsd: s.floorUsd }) // peakR 2.5
  assert.equal(r2.stage, 'STRONG') // stage only moves forward
  assert.equal(r2.floorUsd, 75)    // 75% of the NEW $100 peak
  assert.ok(r2.floorUsd > s.floorUsd)
  console.log('PASS : new high ($60 → $100) → LOCK→STRONG, target floor $39→$75')
}

// 6. Restart → persisted peak/stage/target floor survive
{
  const persisted = JSON.parse(JSON.stringify(mergeTradeState(null, {
    t1: { originalEntry: 2000, peakProfit: 60, beApplied: true, protectionStage: 'LOCK', retentionFloorUsd: 39 },
  })))
  const restored = JSON.parse(JSON.stringify(mergeTradeState(persisted, {
    t1: { originalEntry: 2000, peakProfit: 60, beApplied: true, protectionStage: 'PROTECT', retentionFloorUsd: 21 },
  })))
  assert.equal(restored.t1.protectionStage, 'LOCK', 'stage never regresses across restart')
  assert.equal(restored.t1.retentionFloorUsd, 39, 'floor never regresses across restart')
  assert.equal(restored.t1.peakProfit, 60)
  console.log('PASS : restart → stage + target floor persist (no reset to zero)')
}

// 7. SL monotonicity — ratchet only moves SL in the protective direction (BUY & SELL)
{
  const run1 = buy({ currentProfit: 41, peakProfit: 60 })
  const run2 = buy({ currentProfit: 30, peakProfit: 60, stage: run1.stage, retentionFloorUsd: run1.floorUsd })
  assert.ok(run1.newSl !== null)
  assert.ok(run2.newSl === null || run2.newSl >= run1.newSl, 'BUY SL never moves backwards')
  assert.ok(run2.floorUsd >= run1.floorUsd, 'BUY target floor never moves backwards')
  const s1 = sell({ currentProfit: 41, peakProfit: 60 })
  const s2 = sell({ currentProfit: 30, peakProfit: 60, stage: s1.stage, retentionFloorUsd: s1.floorUsd })
  assert.ok(s1.newSl !== null)
  assert.ok(s2.newSl === null || s2.newSl <= s1.newSl, 'SELL SL never moves backwards')
  assert.ok(s2.floorUsd >= s1.floorUsd, 'SELL target floor never moves backwards')
  console.log('PASS : SL + target floor monotonic in the protective direction for BUY and SELL')
}

// 8. Actual-R calibrated $21-$35 cluster (the audit's giveback cases) under real
//    risk (0.14 lots; 1R ≈ $35 → peakR computed from the real risk).
{
  // 2026-09-09 00:00 — peak $21.27 (0.61R) → PROTECT floor 55% ≈ $11.70
  const a = buy({ currentProfit: 13, peakProfit: 21.27, riskUsd: 35, pipValuePerLot: 10, lots: 0.14 })
  assert.equal(a.stage, 'PROTECT')
  assert.ok(Math.abs(a.floorUsd - 21.27 * 0.55) < 0.01)
  // 2026-09-08 20:46 — peak $22.28 (0.64R) → PROTECT floor ≈ $12.25
  const b = buy({ currentProfit: 14, peakProfit: 22.28, riskUsd: 35, pipValuePerLot: 10, lots: 0.14 })
  assert.equal(b.stage, 'PROTECT')
  assert.ok(Math.abs(b.floorUsd - 22.28 * 0.55) < 0.01)
  // 2026-09-08 22:09 — peak $34.96 (0.999R) → PROTECT floor 55% ≈ $19.23
  const c = buy({ currentProfit: 21, peakProfit: 34.96, riskUsd: 35, pipValuePerLot: 10, lots: 0.14 })
  assert.equal(c.stage, 'PROTECT')
  assert.ok(Math.abs(c.floorUsd - 34.96 * 0.55) < 0.01)
  console.log('PASS : $21.27/$22.28/$34.96 cluster reaches PROTECT (55%) under real 1R≈$35 (no longer dependent on old 50% decay)')
}

// 9. BUY / SELL symmetry — identical protection, opposite price direction
{
  const b = buy({ currentProfit: 41, peakProfit: 60 })
  const s = sell({ currentProfit: 41, peakProfit: 60 })
  assert.equal(b.stage, s.stage)
  assert.equal(b.floorUsd, s.floorUsd)
  const bDist = Math.abs((b.newSl ?? 2000) - 2000)
  const sDist = Math.abs((s.newSl ?? 2000) - 2000)
  assert.ok(Math.abs(bDist - sDist) < 1e-9, 'BUY/SELL protect the same profit distance from entry')
  console.log('PASS : BUY and SELL protection principles are identical (mirrored)')
}

// 10. SL price conversion — profitFloorToSl is exact for BUY/SELL and lot sizes.
//     XAU: pip=0.1, pvpl=$10/lot. Locking $35 at 0.14 lots ⇒ 25 pips ⇒ $2.50 price.
{
  const fx = { pip: 0.1, pipValuePerLot: 10 }
  const f35 = { ...fx, lots: 0.14, floorUsd: 35 }
  const bSl = profitFloorToSl({ dir: 'BUY', entry: 2000, ...f35 })
  const sSl = profitFloorToSl({ dir: 'SELL', entry: 2000, ...f35 })
  const dist = 35 / (10 * 0.14) * 0.1 // 25 pips × 0.1 price = $2.50
  assert.ok(Math.abs((bSl - 2000) - dist) < 1e-9, 'BUY SL locks +$35: entry + floorUsd/(pvpl*lots)*pip')
  assert.ok(Math.abs((2000 - sSl) - dist) < 1e-9, 'SELL SL mirrors BUY distance')
  // Same fractional risk at double size/lots → identical price distance.
  const f70 = { ...fx, lots: 0.28, floorUsd: 70 }
  const bSl2 = profitFloorToSl({ dir: 'BUY', entry: 2000, ...f70 })
  assert.ok(Math.abs(bSl2 - bSl) < 1e-9, 'risk-scaled conversion is lot-size invariant in price distance')
  // Module's own ratchet SL must agree with the independent converter.
  const mod = buy({ currentProfit: 41, peakProfit: 60, pipValuePerLot: 10, lots: 0.14, riskUsd: 35 })
  if (mod.newSl !== null) {
    const conv = profitFloorToSl({ dir: 'BUY', entry: 2000, lots: 0.14, pipValuePerLot: 10, pip: 0.1, floorUsd: mod.floorUsd })
    assert.ok(Math.abs(conv - mod.newSl) < 1e-9, 'module SL equals independent floor→SL converter')
  }
  console.log('PASS : $35 target floor at 0.14 lots → SL 25 pips ($2.50) from entry, BUY/SELL exact, lot-size invariant')
}

// 11. Shadow mode gate — calculates/logs but must never modify or close
{
  assert.deepEqual(shadowDecision({ shadowMode: true, newSl: 2001.5, closeRequested: false }), { modify: false, close: false })
  assert.deepEqual(shadowDecision({ shadowMode: true, newSl: null, closeRequested: true }), { modify: false, close: false })
  assert.deepEqual(shadowDecision({ shadowMode: false, newSl: 2001.5, closeRequested: false }), { modify: true, close: false })
  assert.deepEqual(shadowDecision({ shadowMode: false, newSl: null, closeRequested: true }), { modify: false, close: true })
  console.log('PASS : PROFIT_PROTECTION_SHADOW_MODE blocks modify+close from the new rule; live mode acts normally')
}

// 12. Most-protective SL wins — ATR-trail candidate vs retention-ratchet candidate
{
  const buyBest = pickMostProtectiveSl('BUY', 1999.5, [2001.0, 2002.5]) // ATR SL vs floor SL
  assert.equal(buyBest, 2002.5, 'BUY picks the higher (more protective) SL')
  const sellBest = pickMostProtectiveSl('SELL', 2000.5, [1999.0, 1997.5])
  assert.equal(sellBest, 1997.5, 'SELL picks the lower (more protective) SL')
  assert.equal(pickMostProtectiveSl('BUY', 2001, [1998, 1997]), 2001, 'never loosens below current live SL')
  assert.equal(pickMostProtectiveSl('SELL', 1999, [2001, 2002]), 1999, 'never loosens below current live SL')
  console.log('PASS : one authoritative SL — most protective valid forward stop wins; no rule loosens another')
}

// 13. Fixed USD Target = 0 → dynamic profit protection unaffected (no coupling)
{
  const src = readFileSync(path.join(root, 'lib', 'profit-protection.mjs'), 'utf8')
  assert.ok(!/fixedUsd|profitCloseAmount|fixedProfitUsd/.test(src))
  const r = buy({ currentProfit: 41, peakProfit: 60 })
  assert.equal(r.stage, 'LOCK')
  console.log('PASS : FIXED USD TARGET = 0 keeps dynamic profit protection fully active')
}

console.log('\nAll profit-protection (peak giveback) tests passed.')

