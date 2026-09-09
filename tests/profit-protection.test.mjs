// tests/profit-protection.test.mjs
// Peak-giveback protection (audit 2026-09-09) — pure-model regression tests.
// Run: npm run test:profit-protection
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { profitProtection, STAGE_RANK } from '../lib/profit-protection.mjs'
import { mergeTradeState } from '../lib/trade-state.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
// Unit basis: 1 pip = 0.1 price step (XAU), pipValuePerLot=1, 1 lot.
// riskUsd = 40 → 1R = $40. entry 2000.00.
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
  const r = buy({ currentProfit: 8, peakProfit: 12 }) // $12 peak, $8 now (33% giveback)
  assert.equal(r.action, null)
  assert.equal(r.closeRequested, false)
  assert.equal(r.newSl, null)
  assert.ok(STAGE_RANK[r.stage] === 0 || STAGE_RANK[r.stage] === undefined, 'no aggressive stage for small peak')
  console.log('PASS : small profit pullback → no premature close (normal noise tolerated)')
}

// 2. Strong profit → protection ratchets up to a floor (STRONG = 65% of peak)
{
  const r = buy({ currentProfit: 55, peakProfit: 80, retentionFloorUsd: 0 }) // peakR 2.0
  assert.equal(r.stage, 'STRONG')
  assert.equal(r.floorUsd, 52)                       // 65% of $80 peak locked
  assert.ok(r.action && r.action.startsWith('ratchet'), 'ratchet fires when giveback approaches floor')
  assert.notEqual(r.newSl, null)
  console.log('PASS : strong profit (2R peak) → STRONG ratchet protects $52 of the $80 peak')
}

// 3. Large giveback after a good peak → ratchet protects a meaningful portion
{
  const r = buy({ currentProfit: 34, peakProfit: 60, retentionFloorUsd: 0 }) // peakR 1.5 → LOCK
  assert.equal(r.stage, 'LOCK')
  assert.equal(r.floorUsd, 30)                       // 50% of $60 locked
  assert.ok(r.action && r.action.startsWith('ratchet'), 'gives back to ~$34 → SL moves to $30 floor')
  assert.notEqual(r.newSl, null)
  console.log('PASS : large giveback ($60 peak → $34) → SL ratchets to $30 (50% retained), not $5')
}

// 4. New high → peak advances, stage and dollar floor advance monotonically
{
  let s = buy({ currentProfit: 34, peakProfit: 60 })      // LOCK floor $30
  assert.equal(s.stage, 'LOCK')
  const r2 = buy({ currentProfit: 95, peakProfit: 100, stage: s.stage, retentionFloorUsd: s.floorUsd }) // new peak 2.5R
  assert.equal(r2.stage, 'STRONG')                        // stage only moves forward
  assert.equal(r2.floorUsd, 65)                           // 65% of the NEW $100 peak
  assert.ok(r2.floorUsd > s.floorUsd, 'dollar floor advances with the new high')
  console.log('PASS : new high ($60 → $100 peak) → stage LOCK→STRONG, floor $30→$65')
}

// 5. Restart → persisted peak/stage/floor survive and keep protecting
{
  const persisted = JSON.parse(JSON.stringify(mergeTradeState(null, {
    t1: { originalEntry: 2000, peakProfit: 60, beApplied: true, partialLocked: false, protectionStage: 'LOCK', retentionFloorUsd: 30 },
  })))
  const restored = JSON.parse(JSON.stringify(mergeTradeState(persisted, {
    t1: { originalEntry: 2000, peakProfit: 60, beApplied: true, partialLocked: false, protectionStage: 'PROTECT', retentionFloorUsd: 18 },
  })))
  assert.equal(restored.t1.protectionStage, 'LOCK', 'stage never regresses across restart')
  assert.equal(restored.t1.retentionFloorUsd, 30, 'floor never regresses across restart')
  assert.equal(restored.t1.peakProfit, 60)
  console.log('PASS : restart → protection stage + dollar floor persist (no reset to zero)')
}

// 6. SL monotonicity — ratchet only moves SL in the protective direction
{
  const run1 = buy({ currentProfit: 34, peakProfit: 60 })
  const run2 = buy({ currentProfit: 31, peakProfit: 60, stage: run1.stage, retentionFloorUsd: run1.floorUsd })
  assert.ok(run1.newSl !== null)
  assert.ok(run2.newSl === null || run2.newSl >= run1.newSl, 'BUY SL never moves backwards')
  assert.ok(run2.floorUsd >= run1.floorUsd, 'BUY dollar floor never moves backwards')
  const s1 = sell({ currentProfit: 34, peakProfit: 60 })
  const s2 = sell({ currentProfit: 31, peakProfit: 60, stage: s1.stage, retentionFloorUsd: s1.floorUsd })
  assert.ok(s1.newSl !== null)
  assert.ok(s2.newSl === null || s2.newSl <= s1.newSl, 'SELL SL never moves backwards')
  assert.ok(s2.floorUsd >= s1.floorUsd, 'SELL dollar floor never moves backwards')
  console.log('PASS : SL monotonic in protective direction for BUY and SELL')
}

// 7. BUY / SELL symmetry — identical protection, opposite price direction
{
  const b = buy({ currentProfit: 34, peakProfit: 60 })
  const s = sell({ currentProfit: 34, peakProfit: 60 })
  assert.equal(b.stage, s.stage)
  assert.equal(b.floorUsd, s.floorUsd)
  const bDist = Math.abs((b.newSl ?? 2000) - 2000)
  const sDist = Math.abs((s.newSl ?? 2000) - 2000)
  assert.ok(Math.abs(bDist - sDist) < 1e-9, 'BUY/SELL protect the same profit distance from entry')
  console.log('PASS : BUY and SELL protection principles are identical (mirrored)')
}

// 8. Fixed USD Target = 0 → dynamic profit protection unaffected (module has no
//    fixed-USD coupling at all; no fixedUsd/profitCloseAmount token exists)
{
  const src = readFileSync(path.join(root, 'lib', 'profit-protection.mjs'), 'utf8')
  assert.ok(!/fixedUsd|profitCloseAmount|fixedProfitUsd/.test(src), 'no fixed-USD coupling in protection module')
  const r = buy({ currentProfit: 34, peakProfit: 60 })
  assert.equal(r.stage, 'LOCK')
  console.log('PASS : FIXED USD TARGET = 0 keeps dynamic profit protection fully active')
}

console.log('\nAll profit-protection (peak giveback) tests passed.')
