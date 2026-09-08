// tests/trade-state.test.mjs
// Trade-manager restart recovery — persisted state must survive a process
// restart and must never regress protection markers, peak profit, or open time.
// Run: npm run test:trade-state
import assert from 'node:assert/strict'
import { mergeTradeState, assertNoStateRegression } from '../lib/trade-state.mjs'

const OPENED = '2026-01-01T10:00:00Z'
const tk = '12345'

// Phase A: open trade → reaches profit → break-even applied → peak recorded
let persisted = mergeTradeState(null, {
  [tk]: { originalEntry: 1.0850, openedAt: OPENED, beApplied: false, peakProfit: 0 },
})
persisted = mergeTradeState(persisted, {
  [tk]: { originalEntry: 1.0850, openedAt: OPENED, beApplied: false, peakProfit: 12.4 },
})
persisted = mergeTradeState(persisted, {
  [tk]: { originalEntry: 1.0850, openedAt: OPENED, beApplied: true, partialLocked: false, peakProfit: 30.1 },
})

// Persist → restart (round-trip through JSON, as in broker_configs.config)
let restored = JSON.parse(JSON.stringify(persisted))

// Phase B: manager restarts with a brand-new (empty) in-memory state discovering
// the still-open position — as if the process had never seen this trade.
restored = mergeTradeState(restored, {
  [tk]: { originalEntry: 1.0851, openedAt: new Date().toISOString(), beApplied: false, peakProfit: 1.2 },
})

assert.equal(restored[tk].beApplied, true, 'break-even activation survives restart')
assert.equal(restored[tk].partialLocked, false, 'partial state untouched when not yet applied')
assert.equal(restored[tk].peakProfit, 30.1, 'recorded peak profit survives restart (never lowered by fresh compute)')
assert.equal(restored[tk].openedAt, OPENED, 'original open time survives restart (time-exit not reset)')
console.log('PASS : restart after break-even activation — BE marker, peak, and open time preserved')

// Phase C: profit lock + partial close recorded, then another restart
let p2 = JSON.parse(JSON.stringify(restored))
p2 = mergeTradeState(p2, {
  [tk]: { ...restored[tk], beApplied: true, partialLocked: true, peakProfit: 45.9 },
})
// restart → fresh compute sees peak lower only (price pulled back)
p2 = mergeTradeState(p2, { [tk]: { originalEntry: 1.0851, openedAt: OPENED, partialLocked: false, peakProfit: 22 } })
assert.equal(p2[tk].partialLocked, true, 'profit-lock survives restart')
assert.equal(p2[tk].peakProfit, 45.9, 'peak profit monotonic after restart')
assert.equal(p2[tk].beApplied, true)
console.log('PASS : restart after profit-lock + partial close — sticky state, monotonic peak')

// Phase D: regression guard — an older writer can never clear markers / lower peak
const regression = assertNoStateRegression(p2, {
  [tk]: { originalEntry: 1.0851, openedAt: OPENED, beApplied: false, partialLocked: false, peakProfit: 3 },
})
assert.equal(regression.ok, false, 'state regression attempt is detected')
assert.ok(regression.issues.includes(`${tk}.beApplied`))
assert.ok(regression.issues.includes(`${tk}.partialLocked`))
assert.ok(regression.issues.includes(`${tk}.peakProfit`))
console.log('PASS : regression guard detects attempts to un-apply BE / clear partial-lock / lower peak')

// Phase E: trailing activation recorded across restart + merge never moves risk backwards
let p3 = JSON.parse(JSON.stringify(p2))
p3 = mergeTradeState(p3, { [tk]: { ...p2[tk], trailingActive: true, trailStep: 20 } })
p3 = mergeTradeState(p3, { [tk]: { originalEntry: 1.0851, openedAt: OPENED } }) // restart wipes runtime fields
assert.equal(p3[tk].trailingActive, true, 'trailing state survives restart (sticky markers only; trailStep recomputed by manager)')
console.log('PASS : trailing activation survives restart; SL advances only at manager runtime (never regressed by state layer)')

console.log('\nAll trade-state (restart recovery) tests passed.')
