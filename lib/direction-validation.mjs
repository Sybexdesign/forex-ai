// lib/direction-validation.mjs
// ── AUTOMATED DIRECTION VALIDATION (pure, no I/O) ───────────────────────────
//
// WHY A SEPARATE ENGINE FROM /api/scalper/direction-check
//
// The manual CHECK MARKET DIRECTION route is an ECHO of the signal engine, not a
// validation of it: marketBiasFromTick() there is a line-for-line copy of
// scalpConsensus() in /api/scalper/signal (identical five thresholds —
// rsi14>50, ema9>ema21, macdHistogram>0, buyPressure>0.5, price>bbMid), and the
// route fans out five more calls to /api/scalper/signal on the SAME tick. An
// automated confirmation built on that algorithm would therefore be
// self-confirming:
//
//     signal says BUY -> confirmation copies BUY -> PASS
//
// which this phase explicitly forbids.
//
// This engine derives its direction from CLOSED-CANDLE PRICE STRUCTURE and a
// higher-timeframe trend read — inputs the signal engine does NOT use to choose
// a direction:
//
//   vote 1  last CLOSED M5 bar body      (close vs open)
//   vote 2  three-closed-bar net         (last close vs close 3 closed bars back)
//   vote 3  higher-timeframe trend       (EMA20 vs EMA50 on CLOSED bars)
//   vote 4  momentum on the same bars    (MACD sign AND RSI14 vs 50)
//
// Parameters are the SAME ones the codebase already uses (EMA20/50, MACD 12/26,
// RSI14, the existing ADX regime bands). No new thresholds are invented.
//
// HONEST LIMITS — do not over-claim independence
//
//   * It shares the MARKET-DATA FEED with the signal engine (necessarily: an
//     execution permit must be validated against the account's own data). A
//     corrupt feed therefore affects both, and this engine cannot detect that.
//   * It does NOT share the direction ALGORITHM, so a directional error in the
//     signal engine's indicator/AI stack can be caught here. That is the point
//     of the gate.
//
// FAIL CLOSED: anything unresolved — no closed candle, too few bars, chop regime,
// no majority — resolves to HOLD, and HOLD can never grant a permit.

export const HOLD = 'HOLD'

/** EMA over a numeric series. Returns [] when the series is too short. */
export function ema(values, period) {
  if (!Array.isArray(values) || values.length < period || period <= 0) return []
  const k = 2 / (period + 1)
  const out = []
  let prev = values.slice(0, period).reduce((a, b) => a + b, 0) / period
  out.push(prev)
  for (let i = period; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k)
    out.push(prev)
  }
  return out
}

/** Wilder RSI over a numeric series. Returns [] when the series is too short. */
export function rsi(values, period = 14) {
  if (!Array.isArray(values) || values.length <= period) return []
  const out = []
  let gain = 0, loss = 0
  for (let i = 1; i <= period; i++) {
    const d = values[i] - values[i - 1]
    if (d >= 0) gain += d; else loss -= d
  }
  gain /= period; loss /= period
  out.push(loss === 0 ? 100 : 100 - 100 / (1 + gain / loss))
  for (let i = period + 1; i < values.length; i++) {
    const d = values[i] - values[i - 1]
    gain = (gain * (period - 1) + (d > 0 ? d : 0)) / period
    loss = (loss * (period - 1) + (d < 0 ? -d : 0)) / period
    out.push(loss === 0 ? 100 : 100 - 100 / (1 + gain / loss))
  }
  return out
}

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null)
const closes = (bars) => bars.map((b) => num(b?.close)).filter((v) => v !== null)
const sign = (v) => (v > 0 ? 1 : v < 0 ? -1 : 0)

/**
 * Derive a direction from closed-candle evidence ONLY.
 *
 * This function deliberately has NO parameter for the candidate/signal
 * direction. Self-confirmation is made structurally impossible rather than
 * merely discouraged — a test asserts this arity, so adding a candidate
 * argument breaks the suite.
 *
 * @param {{ m5Closed?: any[], htfClosed?: any[], adx?: number }} evidence
 * @returns {{ direction:'BUY'|'SELL'|'HOLD', bull:number, bear:number, votes:object[], confidence:number, reasons:string[] }}
 */
export function deriveDirection(evidence = {}) {
  const m5  = Array.isArray(evidence.m5Closed)  ? evidence.m5Closed  : []
  const htf = Array.isArray(evidence.htfClosed) ? evidence.htfClosed : []
  const adx = num(evidence.adx) ?? 0
  const reasons = []
  const votes = []

  const m5c = closes(m5)
  // Need at least 4 closed M5 bars (3-bar net + the body read) and enough HTF
  // bars for EMA50 — otherwise there is nothing to validate against.
  if (m5c.length < 4) {
    return { direction: HOLD, bull: 0, bear: 0, votes, confidence: 0,
             reasons: ['insufficient closed M5 bars — cannot validate'] }
  }

  // vote 1 — body of the most recent CLOSED bar
  const last = m5[m5.length - 1]
  votes.push({ name: 'm5-last-body', vote: sign((num(last?.close) ?? 0) - (num(last?.open) ?? 0)) })

  // vote 2 — net movement across the last three CLOSED bars
  votes.push({ name: 'm5-three-bar-net', vote: sign(m5c[m5c.length - 1] - m5c[m5c.length - 4]) })

  // votes 3 + 4 — higher-timeframe trend and momentum on CLOSED HTF bars
  const htfC = closes(htf)
  // FAIL CLOSED on missing HTF evidence. Without it only two structural votes
  // remain, and 2-of-2 would clear a 3-of-4 bar — i.e. thin evidence would make
  // the gate EASIER to pass than full evidence. Absent HTF means "cannot
  // validate", not "fewer checks needed".
  if (htfC.length < 50) {
    reasons.push(`only ${htfC.length} closed HTF bars — need 50 to validate; abstaining`)
    return { direction: HOLD, bull: 0, bear: 0, votes, confidence: 0, reasons }
  }
  {
    const e20 = ema(htfC, 20); const e50 = ema(htfC, 50)
    const trend = sign((e20.pop() ?? 0) - (e50.pop() ?? 0))
    const macd  = sign((ema(htfC, 12).pop() ?? 0) - (ema(htfC, 26).pop() ?? 0))
    const r     = rsi(htfC, 14)
    const rLast = r.length ? r[r.length - 1] : 50
    // Agreement required, mirroring the existing HTF rule (ema20>ema50 AND
    // macd>0 AND rsi>50). Neutral when they disagree.
    const v4 = (trend === 1 && macd === 1 && rLast > 50) ? 1
             : (trend === -1 && macd === -1 && rLast < 50) ? -1
             : 0
    votes.push({ name: 'htf-trend', vote: trend })
    votes.push({ name: 'htf-momentum', vote: v4 })
  }

  const bull = votes.filter((v) => v.vote > 0).length
  const bear = votes.filter((v) => v.vote < 0).length
  const total = votes.length
  const need = Math.ceil(total * 0.75)   // 3 of 4

  // The existing ADX regime band: below 20 is chop, i.e. no directional conviction.
  if (adx > 0 && adx < 20) {
    reasons.push(`ADX ${adx.toFixed(1)} reads as chop — no directional conviction`)
    return { direction: HOLD, bull, bear, votes, confidence: 0, reasons }
  }

  if (bull >= need) return { direction: 'BUY',  bull, bear, votes, confidence: Math.round((bull / total) * 100), reasons }
  if (bear >= need) return { direction: 'SELL', bull, bear, votes, confidence: Math.round((bear / total) * 100), reasons }

  reasons.push(`no majority (${bull} bull / ${bear} bear of ${total}, need ${need})`)
  return { direction: HOLD, bull, bear, votes, confidence: 0, reasons }
}

/**
 * Compare an INDEPENDENTLY derived direction against the candidate signal.
 *
 * The candidate is passed only here — after the derivation has already
 * happened — so it cannot influence the direction.
 *
 * @returns {{ status:'CONFIRMED'|'MISMATCH'|'HOLD', direction:string, candidateDirection:string, confidence:number, bull:number, bear:number, votes:object[], reasons:string[] }}
 */
export function evaluateDirectionPermit(evidence = {}, candidateDirection = HOLD) {
  const derived = deriveDirection(evidence)
  const status = derived.direction === HOLD ? 'HOLD'
               : derived.direction === candidateDirection ? 'CONFIRMED'
               : 'MISMATCH'
  if (status === 'MISMATCH') {
    derived.reasons.push(`independent direction ${derived.direction} contradicts candidate ${candidateDirection}`)
  }
  return { ...derived, status, candidateDirection }
}

// ── THE EXECUTION-PERMIT GATE ───────────────────────────────────────────────
//
// One pure decision function so the manual and automated paths cannot drift apart
// in how a permit is judged. Every unresolved condition returns pass=false with a
// structured reason — a permit is only ever granted by an explicit, affirmative
// match of all conditions. There is no default-allow path.

export const CONFIRMATION_REASONS = {
  unavailable:      'confirmation-unavailable',
  accountMismatch:  'confirmation-account-mismatch',
  pairMismatch:     'confirmation-pair-mismatch',
  hold:             'confirmation-hold',
  stale:            'confirmation-stale',
  candleMismatch:   'confirmation-candle-mismatch',
  marketData:       'confirmation-market-data-invalid',
  directionMismatch:'confirmation-direction-mismatch',
}

/** Mirrors the worker's existing semantics: a 'mirror' recommendation inverts. */
export function expectedDirectionFromPermit(permit) {
  const invert = (d) => (d === 'BUY' ? 'SELL' : d === 'SELL' ? 'BUY' : HOLD)
  return permit?.recommended === 'mirror' ? invert(permit?.direction) : (permit?.direction ?? HOLD)
}

/** Clock tolerance when binding a permit to the M5 candle it was validated on. */
export const CANDLE_ANCHOR_TOLERANCE_MS = 5_000

/**
 * AUTOMATED permits must have been validated at or after the close of the candle
 * the order will be based on. An automated permit issued before this candle
 * closed validated a PREVIOUS market state, so it must not authorise execution
 * against this one.
 *
 * Manual permits are exempt: the operator's 5-minute window is existing,
 * deliberate behaviour that this phase must not change.
 */
export function isPermitCandleAnchored(permit, candleCloseTime, toleranceMs = CANDLE_ANCHOR_TOLERANCE_MS) {
  if (permit?.source !== 'automated') return true
  const analyzed = permit?.analyzed_at ? new Date(permit.analyzed_at).getTime() : NaN
  const closeMs  = candleCloseTime ? new Date(candleCloseTime).getTime() : NaN
  if (!Number.isFinite(analyzed) || !Number.isFinite(closeMs)) return false   // unresolvable -> fail closed
  return analyzed >= closeMs - toleranceMs
}

/**
 * @param {object} o
 * @param {object|null} o.permit      the persisted direction_confirmations row
 * @param {string}  o.signalDirection the worker's current signal direction
 * @param {string|null} o.userId      WORKER_USER_ID
 * @param {string}  o.pair
 * @param {string}  o.now             ISO timestamp
 * @param {object}  o.market          { simulated, dataSuspended, closedCandleAgeSec, maxAgeSec, candleCloseTime }
 * @returns {{ pass:boolean, reason:string|null, expectedDirection:string, detail:object }}
 */
export function evaluateConfirmationGate({ permit, signalDirection, userId, pair, now, market = {} } = {}) {
  const iso = now ?? new Date().toISOString()
  const detail = {
    permitId: permit?.id ?? null,
    permitDirection: permit?.direction ?? null,
    permitRecommended: permit?.recommended ?? null,
    permitSource: permit?.source ?? null,
    permitExpiresAt: permit?.expires_at ?? null,
    permitAnalyzedAt: permit?.analyzed_at ?? null,
    signalDirection: signalDirection ?? null,
    pair: pair ?? null,
  }
  const deny = (reason) => ({ pass: false, reason, expectedDirection: HOLD, detail })

  if (!permit)                     return deny(CONFIRMATION_REASONS.unavailable)
  if (!userId)                     return deny(CONFIRMATION_REASONS.unavailable)
  // A permit with no owner is unusable, not "belonging to someone else".
  if (!permit.user_id)             return deny(CONFIRMATION_REASONS.unavailable)
  if (permit.user_id !== userId)   return deny(CONFIRMATION_REASONS.accountMismatch)
  if (permit.pair !== pair)        return deny(CONFIRMATION_REASONS.pairMismatch)
  if (permit.direction === HOLD || permit.direction == null) return deny(CONFIRMATION_REASONS.hold)

  const expires = permit.expires_at ? new Date(permit.expires_at).getTime() : NaN
  if (!Number.isFinite(expires) || expires <= new Date(iso).getTime()) return deny(CONFIRMATION_REASONS.stale)

  // Market data must be live, unsuspended and based on a fresh CLOSED candle.
  if (market.simulated === true)      return deny(CONFIRMATION_REASONS.marketData)
  if (market.dataSuspended === true)  return deny(CONFIRMATION_REASONS.marketData)
  const age = market.closedCandleAgeSec
  if (typeof age !== 'number' || !Number.isFinite(age)) return deny(CONFIRMATION_REASONS.marketData)
  if (typeof market.maxAgeSec === 'number' && age > market.maxAgeSec) return deny(CONFIRMATION_REASONS.marketData)

  // Candle binding — automated permits only.
  if (!isPermitCandleAnchored(permit, market.candleCloseTime)) return deny(CONFIRMATION_REASONS.candleMismatch)

  const expected = expectedDirectionFromPermit(permit)
  if (expected !== signalDirection) return { pass: false, reason: CONFIRMATION_REASONS.directionMismatch, expectedDirection: expected, detail }

  return { pass: true, reason: null, expectedDirection: expected, detail }
}

// ── DUPLICATE / CONCURRENCY PROTECTION ──────────────────────────────────────
//
// Automated confirmation adds a new failure mode: several worker loops reacting
// to one signal, each requesting a validation. The request is therefore keyed to
// the market state it would validate — one attempt per (pair, closed candle) —
// and is skipped entirely when a usable permit already exists.

export function confirmationRequestKey(pair, candleCloseTime) {
  const c = candleCloseTime ? new Date(candleCloseTime).toISOString() : 'none'
  return `${pair}:${c}`
}

/**
 * @param {object} o
 * @param {string} o.attemptKey                key for the current market state
 * @param {Set<string>} o.attemptedKeys        keys already requested this process
 * @param {boolean} o.hasUsablePermit          an unexpired permit already exists
 * @param {boolean} [o.disabled]               automated confirmation switched off
 */
export function shouldRequestConfirmation({ attemptKey, attemptedKeys, hasUsablePermit, disabled = false } = {}) {
  if (disabled) return false
  if (hasUsablePermit) return false
  if (!attemptKey || attemptKey.endsWith(':none')) return false   // unresolvable market state
  return !(attemptedKeys instanceof Set) || !attemptedKeys.has(attemptKey)
}
