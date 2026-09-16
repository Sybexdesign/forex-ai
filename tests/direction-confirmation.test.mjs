// tests/direction-confirmation.test.mjs
// ── AUTOMATED DIRECTION CONFIRMATION — SAFETY MATRIX ────────────────────────
//
// The gate that authorises live execution. Every test here asserts a NO-TRADE
// outcome except the first, because the purpose of the gate is to refuse.
//
// Two properties are asserted structurally rather than by convention:
//
//   1. INDEPENDENCE — deriveDirection() has no parameter for the candidate
//      direction, so the validator cannot echo the signal it is checking. A test
//      asserts the arity, so adding one breaks the suite.
//   2. NO DEFAULT-ALLOW — evaluateConfirmationGate() denies unless every
//      condition affirmatively passes; there is no fall-through to permit.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  deriveDirection, evaluateDirectionPermit, evaluateConfirmationGate,
  expectedDirectionFromPermit, isPermitCandleAnchored,
  confirmationRequestKey, shouldRequestConfirmation, CONFIRMATION_REASONS,
} from '../lib/direction-validation.mjs'

let failed = 0
const tests = []
const t = (name, fn) => tests.push([name, fn])

const USER_A = '17035955-a3f4-462e-82cc-ec3ead5ad45d'
const USER_B = '2fbdacfc-3f6a-4be9-bded-c64336c97f8c'
const NOW = '2026-09-16T10:00:00.000Z'
const CLOSE_TIME = '2026-09-16T09:55:00.000Z'   // the closed M5 candle the order is based on

/** Build a monotonic bar series. `dir` +1 rising, -1 falling. */
function bars(n, start, step, dir) {
  const out = []
  for (let i = 0; i < n; i++) {
    const o = start + dir * step * i
    const c = o + dir * step * 0.8
    out.push({ open: o, high: Math.max(o, c) + step * 0.1, low: Math.min(o, c) - step * 0.1, close: c,
               time: new Date(Date.parse('2026-09-16T00:00:00.000Z') + i * 300_000).toISOString() })
  }
  return out
}
const BULL_M5  = bars(10, 4300, 1, +1)
const BEAR_M5  = bars(10, 4300, 1, -1)
const BULL_HTF = bars(80, 4200, 1, +1)
const BEAR_HTF = bars(80, 4400, 1, -1)

/** A permit row that would pass every check. */
const goodPermit = (o = {}) => ({
  id: 'p1', user_id: USER_A, pair: 'XAU/USD', direction: 'SELL', recommended: 'scalp',
  source: 'automated', analyzed_at: '2026-09-16T09:55:30.000Z',
  expires_at: '2026-09-16T10:00:30.000Z', ...o,
})
/** Market context that would pass every check. */
const goodMarket = (o = {}) => ({ simulated: false, dataSuspended: false, closedCandleAgeSec: 30, maxAgeSec: 150, candleCloseTime: CLOSE_TIME, ...o })
const gate = (o = {}) => evaluateConfirmationGate({
  permit: goodPermit(), signalDirection: 'SELL', userId: USER_A, pair: 'XAU/USD', now: NOW, market: goodMarket(), ...o,
})

console.log('automated direction confirmation — safety matrix')

// ── §11 baseline: the one case that MUST pass ──────────────────────────────
t('matching direction, ACTIVE, fresh, correct account+pair, fresh closed candle -> PASS', () => {
  const r = gate()
  assert.equal(r.pass, true, 'the affirmative case must pass')
  assert.equal(r.reason, null)
  assert.equal(r.expectedDirection, 'SELL')
})

// ── §11 every failure state resolves to NO TRADE ──────────────────────────
t('direction mismatch (signal BUY, confirmation SELL) -> NO TRADE', () => {
  const r = gate({ signalDirection: 'BUY' })
  assert.equal(r.pass, false)
  assert.equal(r.reason, CONFIRMATION_REASONS.directionMismatch)
})

t('confirmation HOLD -> NO TRADE (HOLD never matches a live direction)', () => {
  const r = gate({ permit: goodPermit({ direction: 'HOLD' }) })
  assert.equal(r.pass, false)
  assert.equal(r.reason, CONFIRMATION_REASONS.hold)
})

t('expired confirmation -> NO TRADE', () => {
  const r = gate({ permit: goodPermit({ expires_at: '2026-09-16T09:59:59.000Z' }) })
  assert.equal(r.pass, false)
  assert.equal(r.reason, CONFIRMATION_REASONS.stale)
})

t('wrong account (permit belongs to user B) -> NO TRADE', () => {
  const r = gate({ permit: goodPermit({ user_id: USER_B }) })
  assert.equal(r.pass, false)
  assert.equal(r.reason, CONFIRMATION_REASONS.accountMismatch)
})

t('wrong pair (XAG permit, XAU signal) -> NO TRADE', () => {
  const r = gate({ permit: goodPermit({ pair: 'XAG/USD' }) })
  assert.equal(r.pass, false)
  assert.equal(r.reason, CONFIRMATION_REASONS.pairMismatch)
})

t('stale underlying candle -> NO TRADE', () => {
  const r = gate({ market: goodMarket({ closedCandleAgeSec: 400 }) })
  assert.equal(r.pass, false)
  assert.equal(r.reason, CONFIRMATION_REASONS.marketData)
})

t('forming-only / unresolvable candle age -> NO TRADE', () => {
  for (const age of [undefined, null, NaN, 'soon']) {
    const r = gate({ market: goodMarket({ closedCandleAgeSec: age }) })
    assert.equal(r.pass, false, `age=${String(age)} must not be actionable`)
    assert.equal(r.reason, CONFIRMATION_REASONS.marketData)
  }
})

t('simulated or suspended market data in LIVE -> NO TRADE', () => {
  assert.equal(gate({ market: goodMarket({ simulated: true }) }).reason, CONFIRMATION_REASONS.marketData)
  assert.equal(gate({ market: goodMarket({ dataSuspended: true }) }).reason, CONFIRMATION_REASONS.marketData)
})

t('confirmation service failure / missing permit -> NO TRADE (confirmation-unavailable)', () => {
  for (const permit of [null, undefined, {}]) {
    const r = gate({ permit })
    assert.equal(r.pass, false, 'an absent permit must never permit')
    assert.equal(r.reason, CONFIRMATION_REASONS.unavailable)
  }
})

t('unresolved worker identity -> NO TRADE', () => {
  const r = gate({ userId: null })
  assert.equal(r.pass, false)
  assert.equal(r.reason, CONFIRMATION_REASONS.unavailable)
})

// ── §4 INDEPENDENCE: the validator must not echo the candidate ─────────────
t('INDEPENDENCE: deriveDirection has NO candidate parameter (structural, not policy)', () => {
  // Asserted against the SIGNATURE, not function.length: a defaulted parameter
  // would make .length 0 whether or not a candidate argument existed.
  const src = readFileSync(new URL('../lib/direction-validation.mjs', import.meta.url), 'utf8')
  assert.ok(/export function deriveDirection\(evidence = \{\}\) \{/.test(src),
    'deriveDirection must take only the evidence object — a candidate parameter would make self-confirmation possible')
  // And it must reach the same verdict no matter what the signal claimed.
  assert.equal(deriveDirection({ m5Closed: BEAR_M5, htfClosed: BEAR_HTF, adx: 30 }).direction, 'SELL',
    'falling closed candles derive SELL')
  assert.equal(deriveDirection({ m5Closed: BULL_M5, htfClosed: BULL_HTF, adx: 30 }).direction, 'BUY',
    'rising closed candles derive BUY')
})

t('INDEPENDENCE: a bullish market REFUSES a SELL signal (it does not copy it)', () => {
  const r = evaluateDirectionPermit({ m5Closed: BULL_M5, htfClosed: BULL_HTF, adx: 30 }, 'SELL')
  assert.equal(r.status, 'MISMATCH', 'the validator contradicted the signal rather than echoing it')
  assert.equal(r.direction, 'BUY')
  assert.equal(r.candidateDirection, 'SELL')
})

t('INDEPENDENCE: a bearish market CONFIRMS a SELL signal and REFUSES a BUY signal', () => {
  const ev = { m5Closed: BEAR_M5, htfClosed: BEAR_HTF, adx: 30 }
  assert.equal(evaluateDirectionPermit(ev, 'SELL').status, 'CONFIRMED')
  assert.equal(evaluateDirectionPermit(ev, 'BUY').status, 'MISMATCH')
})

t('FAIL CLOSED: mixed evidence, thin data and chop all abstain to HOLD', () => {
  assert.equal(deriveDirection({ m5Closed: BULL_M5, htfClosed: BEAR_HTF, adx: 30 }).direction, 'HOLD',
    'M5 up + HTF down -> no majority')
  assert.equal(deriveDirection({ m5Closed: BULL_M5.slice(0, 2), htfClosed: BULL_HTF, adx: 30 }).direction, 'HOLD',
    'too few closed bars to validate at all')
  assert.equal(deriveDirection({ m5Closed: BULL_M5, htfClosed: [], adx: 30 }).direction, 'HOLD',
    'HTF absent -> 3-of-4 unreachable')
  assert.equal(deriveDirection({ m5Closed: BULL_M5, htfClosed: BULL_HTF, adx: 12 }).direction, 'HOLD',
    'chop regime abstains even with clean directional structure')
  assert.equal(deriveDirection({}).direction, 'HOLD', 'no evidence')
})

// ── §7 CANDLE BINDING ─────────────────────────────────────────────────────
t('an automated permit validated BEFORE this candle closed cannot authorise it', () => {
  const stale = goodPermit({ analyzed_at: '2026-09-16T09:54:00.000Z' })   // previous market state
  assert.equal(isPermitCandleAnchored(stale, CLOSE_TIME), false)
  const r = gate({ permit: stale })
  assert.equal(r.pass, false)
  assert.equal(r.reason, CONFIRMATION_REASONS.candleMismatch)

  assert.equal(isPermitCandleAnchored(goodPermit(), CLOSE_TIME), true, 'validated after the close -> anchored')
  assert.equal(isPermitCandleAnchored(goodPermit({ analyzed_at: null }), CLOSE_TIME), false, 'unresolvable -> fail closed')
  assert.equal(isPermitCandleAnchored(goodPermit(), null), false, 'unknown candle -> fail closed')
})

t('MANUAL permits keep their existing 5-minute semantics (unchanged by this phase)', () => {
  const manual = goodPermit({ source: 'manual', analyzed_at: '2026-09-16T09:54:00.000Z' })
  assert.equal(isPermitCandleAnchored(manual, CLOSE_TIME), true,
    'the operator window is deliberately not candle-anchored')
  assert.equal(gate({ permit: manual }).pass, true, 'a manual permit still passes the gate')
})

t('mirror-recommended permits invert, preserving existing worker semantics', () => {
  const mirror = goodPermit({ direction: 'BUY', recommended: 'mirror' })   // invert BUY -> SELL
  assert.equal(expectedDirectionFromPermit(mirror), 'SELL')
  assert.equal(gate({ permit: mirror }).pass, true)
  assert.equal(gate({ permit: mirror, signalDirection: 'BUY' }).reason, CONFIRMATION_REASONS.directionMismatch)
})

// ── §8 CONCURRENCY ────────────────────────────────────────────────────────
t('one market state produces at most ONE automated confirmation request', () => {
  const attemptKey = confirmationRequestKey('XAU/USD', CLOSE_TIME)
  const attempted = new Set()
  assert.equal(shouldRequestConfirmation({ attemptKey, attemptedKeys: attempted, hasUsablePermit: false }), true,
    'the first loop requests')
  attempted.add(attemptKey)
  assert.equal(shouldRequestConfirmation({ attemptKey, attemptedKeys: attempted, hasUsablePermit: false }), false,
    'a concurrent second loop must NOT request again for the same candle')
  const nextKey = confirmationRequestKey('XAU/USD', '2026-09-16T10:00:00.000Z')
  assert.equal(shouldRequestConfirmation({ attemptKey: nextKey, attemptedKeys: attempted, hasUsablePermit: false }), true,
    'a NEW candle is a new market state and may be requested')
  assert.equal(shouldRequestConfirmation({ attemptKey: nextKey, attemptedKeys: new Set(), hasUsablePermit: true }), false,
    'an existing usable permit suppresses the request entirely')
  assert.equal(shouldRequestConfirmation({ attemptKey: nextKey, attemptedKeys: new Set(), hasUsablePermit: false, disabled: true }), false,
    'disabled never requests')
  assert.equal(shouldRequestConfirmation({ attemptKey: confirmationRequestKey('XAU/USD', null), attemptedKeys: new Set(), hasUsablePermit: false }), false,
    'unresolvable market state never requests')
})

t('TEETH: the gate is genuinely conditional, not a rubber stamp', () => {
  const breaks = {
    account:   { permit: goodPermit({ user_id: USER_B }) },
    pair:      { permit: goodPermit({ pair: 'XAG/USD' }) },
    hold:      { permit: goodPermit({ direction: 'HOLD' }) },
    expired:   { permit: goodPermit({ expires_at: '2026-01-01T00:00:00.000Z' }) },
    unanchored:{ permit: goodPermit({ analyzed_at: '2026-09-16T09:00:00.000Z' }) },
    candles:   { market: goodMarket({ closedCandleAgeSec: 999 }) },
    simulated: { market: goodMarket({ simulated: true }) },
    mismatch:  { signalDirection: 'BUY' },
    noUser:    { userId: null },
    noPermit:  { permit: null },
  }
  for (const [name, override] of Object.entries(breaks)) {
    assert.equal(gate(override).pass, false,
      `breaking '${name}' must deny — if this passes the gate is rubber-stamping`)
  }
})

// ── runner ────────────────────────────────────────────────────────────────
for (const [name, fn] of tests) {
  try { await fn(); console.log(`  ✓ ${name}`) }
  catch (e) { failed++; console.error(`  ✗ ${name}\n      ${e?.message}`) }
}
console.log(`\n${tests.length - failed}/${tests.length} passed`)
process.exit(failed ? 1 : 0)
