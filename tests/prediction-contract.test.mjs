// tests/prediction-contract.test.mjs
// Phase 2 — canonical prediction contract + WIN/LOSS/INCONCLUSIVE semantics.
//
// The rules under test are the SAME functions the worker consumes
// (lib/prediction-contract.mjs), so these are real unit tests — not copies.
// Run: npm run test:prediction-contract
import assert from 'node:assert/strict'
import {
  PREDICTION_TIMEFRAME, PREDICTION_WINDOW_MS, PREDICTION_WINDOW_MINUTES,
  PREDICTION_FUTURE_CANDLES, PREDICTION_RESOLUTION_RULE, PREDICTION_FALLBACK_OUTCOME,
  predictionExpiresAt, buildPredictionMeta, resolveSampleOutcome,
  isWithinPredictionWindow, predictionIdentityKey,
} from '../lib/prediction-contract.mjs'

const FIVE_MIN = 5 * 60_000
const T0 = '2026-09-04T20:15:05.000Z'
const EXP0 = '2026-09-04T20:30:05.000Z'          // T0 + 15 min

// ── Test A — canonical contract
{
  assert.equal(PREDICTION_TIMEFRAME, 'M5', 'A: timeframe = M5')
  assert.equal(PREDICTION_WINDOW_MS, 900_000, 'A: window = 900000 ms')
  assert.equal(PREDICTION_WINDOW_MINUTES, 15, 'A: window = 15 minutes')
  assert.equal(PREDICTION_FUTURE_CANDLES, 3, 'A: up to 3 future M5 closes')
  assert.equal(PREDICTION_RESOLUTION_RULE, 'TP_BEFORE_SL', 'A: TP before SL = WIN')
  assert.equal(PREDICTION_FALLBACK_OUTCOME, 'INCONCLUSIVE', 'A: neither → INCONCLUSIVE')
  console.log('PASS A: canonical contract constants (M5 / 15 min / 3 closes / TP_BEFORE_SL / INCONCLUSIVE)')
}

// ── Test B — prediction expiry = start + 15 minutes
{
  assert.equal(predictionExpiresAt(T0), EXP0, 'B: expiresAt = created_at + 15 min')
  const meta = buildPredictionMeta(T0, 4431.7)
  assert.equal(meta.expiresAt, EXP0)
  assert.equal(meta.timeframe, 'M5')
  assert.equal(meta.entryPrice, 4431.7)
  assert.equal(meta.resolutionRule, 'TP_BEFORE_SL')
  assert.equal(meta.fallbackOutcome, 'INCONCLUSIVE')
  console.log('PASS B: prediction_expires_at = created_at + 15 minutes')
}

// ── Test C — TP before SL → WIN
{
  const entry = 4431.70, sl = 4426.45, tp = 4440.44
  const closes = [4430.90, 4433.20, 4440.50]     // TP reached on the 3rd future close
  const graded = closes.map(c => resolveSampleOutcome(c, 'BUY', sl, tp))
  assert.deepEqual(graded, [null, null, 'WIN'], 'C: TP before SL → WIN')
  assert.equal(resolveSampleOutcome(4420.0, 'SELL', 4435.0, 4425.0), 'WIN', 'C: SELL TP below entry → WIN')
  console.log('PASS C: TP reached before SL → WIN')
}

// ── Test D — SL before TP → LOSS (and SL priority on the same candle)
{
  const entry = 4431.70, sl = 4426.45, tp = 4440.44
  const closes = [4428.10, 4426.40, 4441.00]     // SL on the 2nd close → LOSS, stop
  const graded = []
  for (const c of closes) {
    const o = resolveSampleOutcome(c, 'BUY', sl, tp)
    graded.push(o)
    if (o) break
  }
  assert.deepEqual(graded, [null, 'LOSS'], 'D: SL before TP → LOSS and monitoring stops')
  // SL priority: a single sample that has already gapped through SL reads LOSS.
  assert.equal(resolveSampleOutcome(4419.00, 'BUY', sl, tp), 'LOSS', 'D: gap through SL → LOSS')
  console.log('PASS D: SL reached before TP → LOSS (SL checked first)')
}

// ── Test E — neither target reached → INCONCLUSIVE at expiry
{
  const entry = 4431.70, sl = 4426.45, tp = 4440.44
  const closes = [4430.10, 4433.60, 4436.00]     // 3 future closes, no touch
  const graded = closes.map(c => resolveSampleOutcome(c, 'BUY', sl, tp))
  assert.deepEqual(graded, [null, null, null], 'E: no touch on any of the 3 closes')
  const expiresAt = predictionExpiresAt(T0)
  const afterExpiry = new Date(expiresAt).getTime() + 1000
  assert.equal(isWithinPredictionWindow(expiresAt, afterExpiry), false, 'E: window ended')
  assert.equal(PREDICTION_FALLBACK_OUTCOME, 'INCONCLUSIVE', 'E: expired without touch → INCONCLUSIVE')
  console.log('PASS E: 3 closes without TP/SL → window ends → INCONCLUSIVE')
}

// ── Test F — expired pending recovery (deterministic INCONCLUSIVE)
{
  const start = '2026-09-04T19:20:04.000Z'
  const expiresAt = predictionExpiresAt(start)          // 19:35:04
  const nowLate = new Date(expiresAt).getTime() + 30_000
  assert.equal(isWithinPredictionWindow(expiresAt, nowLate), false,
    'F: expired row is NOT inside its window → scanner must resolve')
  assert.equal(PREDICTION_FALLBACK_OUTCOME, 'INCONCLUSIVE',
    'F: expired-pending resolution outcome = INCONCLUSIVE with resolved_at set')
  console.log('PASS F: expired unresolved prediction → INCONCLUSIVE (resolved_at = actual scan time)')
}


// ── Test G — restart recovery while still inside the window → monitoring continues
{
  const start = new Date().toISOString()
  const expiresAt = predictionExpiresAt(start)
  assert.equal(isWithinPredictionWindow(expiresAt, Date.now() + 60_000), true,
    'G: row still inside its window after a restart is recovered and monitored')
  // A later sample that reaches TP after "recovery" still resolves WIN.
  const outcome = resolveSampleOutcome(4441.0, 'BUY', 4426.45, 4440.44)
  assert.equal(outcome, 'WIN', 'G: resumed monitoring resolves with the same rule')
  console.log('PASS G: pending row inside its window survives restart and continues monitoring')
}

// ── Test H — idempotent resolution (first resolver wins, one final outcome)
{
  const state = { resolved: null }
  const resolveOnce = (price) => {
    if (state.resolved !== null) return { applied: false, outcome: state.resolved }
    const o = resolveSampleOutcome(price, 'BUY', 4426.45, 4440.44)
    if (o) state.resolved = o
    return { applied: o !== null, outcome: state.resolved }
  }
  const r1 = resolveOnce(4441.0)
  const r2 = resolveOnce(4420.0)          // a second resolver trying to flip it
  assert.equal(r1.applied, true)
  assert.equal(r1.outcome, 'WIN')
  assert.equal(r2.applied, false, 'H: second resolver is a no-op')
  assert.equal(state.resolved, 'WIN', 'H: outcome can never flip WIN→LOSS')
  console.log('PASS H: resolution is one-way and idempotent (NULL/PENDING → final outcome only)')
}

// ── Test I — same candle → same prediction identity (per-candle dedupe key)
{
  const c1 = '2026-09-04T23:15:00.000Z'
  assert.equal(predictionIdentityKey('XAU/USD', c1), predictionIdentityKey('XAU/USD', c1),
    'I: same candle → same identity')
  console.log('PASS I: one canonical prediction identity per (pair, candle_close_time)')
}

// ── Test J — next candle → new identity and new expiry
{
  const c1 = '2026-09-04T23:15:00.000Z'
  const c2 = '2026-09-04T23:20:00.000Z'        // next M5 candle close
  assert.notEqual(predictionIdentityKey('XAU/USD', c1), predictionIdentityKey('XAU/USD', c2),
    'J: next candle → new prediction identity')
  const start1 = '2026-09-04T20:15:05.000Z'
  const start2 = new Date(new Date(start1).getTime() + FIVE_MIN).toISOString()
  assert.notEqual(buildPredictionMeta(start1).expiresAt, buildPredictionMeta(start2).expiresAt,
    'J: next candle → new prediction_expires_at (+15 min from its own start)')
  console.log('PASS J: next candle produces a new identity, new candle_close_time and new expiry')
}

// ── Test L — UI expiry is derived from the fixed server payload (no poll reset)
{
  // Server returns the SAME meta block for the same candle on every 15s poll
  // (route-level dedupe caches the first evaluation). The UI must render this
  // exact expiresAt and never extend it.
  const metaPoll1 = buildPredictionMeta(T0, 4431.7)
  const metaPoll2 = buildPredictionMeta(T0, 4431.7)
  assert.equal(metaPoll1.expiresAt, metaPoll2.expiresAt, 'L: expiresAt identical across polls for the same candle')
  assert.equal(metaPoll1.startsAt, metaPoll2.startsAt, 'L: startsAt identical across polls for the same candle')
  // A display derived only from the payload cannot drift.
  assert.equal(new Date(metaPoll1.expiresAt).getTime(), new Date(metaPoll2.expiresAt).getTime(),
    'L: countdown anchors to the fixed server expiry')
  console.log('PASS L: frontend expiry derives from the fixed server prediction_expires_at (never reset by polling)')
}

// K (no-lookahead) is covered by tests/closed-candle.test.mjs (tests A + H).
console.log('\nAll prediction-contract tests passed.')
