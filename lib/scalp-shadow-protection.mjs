// lib/scalp-shadow-protection.mjs
// ─────────────────────────────────────────────────────────────────────────────
// READ-ONLY shadow evaluator for OPEN SCALP positions.
//
// Scalp trades are placed by workers/scalper.mjs and are NOT routed through
// manageTrades(), so lib/profit-protection.mjs has never evaluated them. This
// module lets the shadow study observe real scalp positions WITHOUT changing any
// trading behaviour.
//
// WHAT IT CANNOT DO — BY CONSTRUCTION
//
//   * It imports NO broker adapter and NO close/modify function. There is no
//     code path from here to a broker write; `shadowDecision()` is consulted
//     only to record what LIVE mode WOULD have done.
//   * It performs no I/O. The caller supplies the position snapshot and persists
//     the returned rows. That keeps the algorithm testable without a broker and
//     keeps persistence failure out of the trading loop.
//   * It reimplements none of the retention bands. It calls the SAME
//     `profitProtection()` the MT5 path calls, so the study compares one
//     algorithm rather than two subtly different ones.
//
// WHY PIP METADATA IS A PARAMETER
//
// getPipValue()/getPipValuePerLot() live in lib/brokers/interface.ts, which a
// plain-Node .mjs worker cannot import. Copying them here would let the two
// drift and would silently misstate planned risk — the number the whole study
// divides by. So the caller passes the authoritative values in, exactly as
// `profitProtection()` already takes them.
// ─────────────────────────────────────────────────────────────────────────────

import { profitProtection, shadowDecision, STAGE_RANK } from './profit-protection.mjs'
import { toRow, rowKind } from './profit-telemetry.mjs'
import { mergeTradeState } from './trade-state.mjs'

/** Every decision string this module can emit, matching the MT5 path's vocabulary. */
export const SHADOW_DECISIONS = {
  none: 'NONE',
  moveSl: 'WOULD_MOVE_SL',
  moveSlToBe: 'WOULD_MOVE_SL_TO_BE',
  close: 'WOULD_CLOSE',
  /**
   * §5 — the label for a GENUINE broker closure.
   *
   * This is deliberately NOT `WOULD_CLOSE`. `WOULD_CLOSE` is a COUNTERFACTUAL
   * about a position that is still open; stamping it on the close row asserted
   * that the shadow rule had wanted this trade closed, which the shadow had
   * never actually decided. `closeSummaryFromRows()` already discounts any
   * `WOULD_CLOSE` on a `row_kind='close'` row, so recording the truth here is
   * what makes "first WOULD_CLOSE" mean "first time the rule would have acted
   * while the position was live" — the only reading the study can use.
   *
   * `BROKER_CLOSE` still ends in `_CLOSE`, so `rowKind()` continues to classify
   * it as `row_kind='close'`. Lifecycle termination is unchanged.
   */
  brokerClose: 'BROKER_CLOSE',
}

/**
 * Map profitProtection's ACTION to the decision label the telemetry layer reads.
 *
 * The two vocabularies are deliberately bridged here and nowhere else:
 * `profitProtection` speaks in what it would DO ('ratchet-lock'), telemetry
 * speaks in what it would have done ('WOULD_MOVE_SL'). lib/profit-telemetry.mjs
 * keys its early-BE detection off the literal 'WOULD_MOVE_SL_TO_BE', so this
 * mapping is what makes scalp rows readable by the existing analysis.
 */
export function decisionFor(action, closeRequested) {
  if (closeRequested) return SHADOW_DECISIONS.close
  switch (action) {
    case 'early-giveback-be':        return SHADOW_DECISIONS.moveSlToBe
    case 'giveback-collapse-close':  return SHADOW_DECISIONS.close
    case null:
    case undefined:                  return SHADOW_DECISIONS.none
    default:                         return String(action).startsWith('ratchet-')
      ? SHADOW_DECISIONS.moveSl
      : SHADOW_DECISIONS.none
  }
}

/**
 * §6 — exact runtime 1R from the position's own geometry.
 *
 *     |entry − initialSl| ÷ pip × pipValuePerLot × lots
 *
 * WHY `initialSl` AND NOT THE CURRENT SL
 *
 * If a stop is ever moved the CURRENT SL no longer describes the money that was
 * originally at risk, and 1R would shrink with every ratchet — inflating peakR
 * and quietly moving every trade into a higher protection band. The initial SL is
 * captured on first observation and persisted, so 1R stays the risk actually taken.
 *
 * Returns null rather than a guess when geometry is unusable: a missing SL or a
 * zero pip value must produce "no risk figure", never a fabricated one, because
 * every R multiple in the study divides by this.
 */
export function plannedRiskUsd({ entry, initialSl, lots, pip, pipValuePerLot }) {
  // Reject absent values BEFORE coercion. `Number(null)` is 0 and
  // `Number.isFinite(0)` is true, so coercing first made a MISSING stop level
  // compute as |entry − 0| — a gigantic, entirely fictional 1R. Capital returns
  // `undefined` for a position with no stopLevel, so this is a live case, and
  // every R multiple in the study divides by this number.
  const absent = (v) => v === null || v === undefined || v === ''
  if (absent(entry) || absent(initialSl) || absent(lots) || absent(pip) || absent(pipValuePerLot)) {
    return null
  }

  const e = Number(entry), sl = Number(initialSl), l = Number(lots)
  const p = Number(pip), pv = Number(pipValuePerLot)
  if (!Number.isFinite(e) || !Number.isFinite(sl)) return null
  if (!(l > 0) || !(p > 0) || !(pv > 0)) return null
  const distance = Math.abs(e - sl)
  if (!(distance > 0)) return null
  const risk = (distance / p) * pv * l
  return Number.isFinite(risk) && risk > 0 ? Math.round(risk * 100) / 100 : null
}

/**
 * Normalise one broker `OpenTrade` into the shape the evaluator consumes.
 *
 * `initialSl` comes from previously-seen state when available, so a moved stop
 * cannot rewrite history. Everything else comes from the live snapshot.
 */
export function normaliseScalpPosition(trade, { priorState = null, pip, pipValuePerLot } = {}) {
  const lots = Number(trade?.lots)
  const entry = Number(trade?.entryPrice)
  const currentSl = trade?.stopLossPrice != null ? Number(trade.stopLossPrice) : null
  const initialSl = Number.isFinite(Number(priorState?.initialSl))
    ? Number(priorState.initialSl)
    : currentSl

  // ── Genuine mark price, or an explicit null ─────────────────────────────────
  // `trade.markPrice` is the broker's authoritative mark (see the field's
  // contract in lib/brokers/interface.ts). `trade.currentPrice` is NOT used as a
  // fallback: for MT5-direct it is permanently the entry price, which would make
  // this column — and any price-derived reasoning — read as a flat line for the
  // entire life of the position while looking perfectly plausible.
  //
  // A null here is the honest state and the caller must FAIL CLOSED on it.
  const rawMark = trade?.markPrice
  const markPrice = rawMark != null && Number.isFinite(Number(rawMark)) && Number(rawMark) > 0
    ? Number(rawMark)
    : null

  // `Number(undefined) || 0` used to turn a missing P&L field into a
  // BREAKEVEN reading — which silently flattens the profit trajectory and can
  // freeze the peak at zero. A missing figure is not zero: keep it null and let
  // the evaluator refuse the observation.
  const rawProfit = trade?.unrealizedPL
  const currentProfit = rawProfit != null && rawProfit !== '' && Number.isFinite(Number(rawProfit))
    ? Number(rawProfit)
    : null

  return {
    ticket: trade?.id != null ? String(trade.id) : null,
    tradeId: priorState?.tradeId ?? null,
    pair: trade?.pair ?? null,
    direction: trade?.direction === 'SELL' ? 'SELL' : 'BUY',
    lots,
    entry,
    // The telemetry `current_price` column carries the genuine mark (or nothing).
    currentPrice: markPrice,
    markPrice,
    markUsable: markPrice != null,
    currentSl,
    initialSl,
    currentProfit,
    openedAt: priorState?.openedAt || trade?.openTime || new Date().toISOString(),
    pip,
    pipValuePerLot,
    riskUsd: plannedRiskUsd({ entry, initialSl, lots, pip, pipValuePerLot }),
  }
}

/**
 * Lineage of a row's `row_kind`, at the scalp-shadow boundary.
 *
 * WHY THIS EXISTS INSTEAD OF CHANGING `rowKind()`
 *
 * `rowKind()` maps ANY decision ending in `_CLOSE` to `row_kind='close'`. For the
 * MT5 manager that is right: its close decision coincides with the manager
 * actually closing the position. Here it is wrong, and the difference matters
 * more than any other single fact in this study.
 *
 * A `WOULD_CLOSE` from this module is a COUNTERFACTUAL about a position that is
 * STILL OPEN. It is not an event in the trade's life. If it were written as
 * `row_kind='close'`, the analysis layer would treat the lifecycle as finished
 * and could never observe the thing the study most needs to know: that the
 * shadow rule would have clipped a runner the real system let reach +2.0R.
 *
 * So the distinction is made here, explicitly, at the one boundary where it
 * applies — and `rowKind()` keeps its existing meaning for every current
 * consumer. Changing that helper globally would have silently reclassified
 * historical MT5 telemetry; this cannot.
 *
 * INVARIANT: `row_kind='close'` is emitted ONLY by buildScalpCloseRow(), which
 * runs only after the reconciliation path has confirmed a REAL broker closure.
 */
export function scalpRowKind(shadowDecision) {
  if (shadowDecision === SHADOW_DECISIONS.close) return 'decision'
  return rowKind({ shadowDecision, action: null })
}

/**
 * §3 §5 — evaluate ONE open scalp position. Read-only, no I/O, no broker call.
 *
 * @returns {{row: object|null, state: object, decision: string, reason: string|null}}
 *   `row` is a profit_protection_telemetry row, or null when the position cannot
 *   be evaluated at all. `state` is the caller's next durable state for this
 *   ticket. NOTHING is written anywhere by this function.
 */
export function evaluateScalpShadow({ position, priorState = null, shadowMode = true }) {
  const ticket = position?.ticket
  const prior = priorState || {}

  // A position with no ticket or no usable risk cannot be studied. Returning no
  // row is the honest outcome: a fabricated riskUsd would corrupt every R figure
  // in the study, which is worse than a gap the reader can see.
  if (!ticket) {
    return { row: null, state: prior, decision: SHADOW_DECISIONS.none, reason: 'no-ticket' }
  }
  if (!(position.riskUsd > 0)) {
    return { row: null, state: prior, decision: SHADOW_DECISIONS.none, reason: 'no-risk' }
  }

  // §2 — FAIL CLOSED on an unusable mark price.
  //
  // There is no fabricated fallback here on purpose. The old behaviour (mark =
  // entry price) produced a column that read as a flat line for every lifecycle
  // while looking completely plausible, which is worse for the study than a
  // visible gap. No mark ⇒ no observation, and the runtime reports the reason.
  if (!position.markUsable) {
    return { row: null, state: prior, decision: SHADOW_DECISIONS.none, reason: 'mark-price-unavailable' }
  }

  // §3 — a MISSING P&L reading is not a breakeven reading. Admitting one would
  // flatten the trajectory and can pin the peak at zero, so refuse instead.
  //
  // The absent check must come BEFORE coercion: `Number(null)` is 0 and
  // `Number.isFinite(0)` is true, so coercing first let a MISSING reading pass as
  // a genuine breakeven. This is the same trap `plannedRiskUsd()` documents above.
  const profitAbsent = position.currentProfit === null
    || position.currentProfit === undefined
    || position.currentProfit === ''
  if (profitAbsent || !Number.isFinite(Number(position.currentProfit))) {
    return { row: null, state: prior, decision: SHADOW_DECISIONS.none, reason: 'no-profit-reading' }
  }

  // Peak is monotonic across cycles AND across restarts, because the caller
  // persists `state`. A restart must never lower a recorded peak.
  const peakProfit = Math.max(Number(prior.peakProfit) || 0, position.currentProfit)

  const result = profitProtection({
    dir: position.direction,
    entry: position.entry,
    currentSl: position.currentSl,
    currentProfit: position.currentProfit,
    peakProfit,
    riskUsd: position.riskUsd,
    lots: position.lots,
    pipValuePerLot: position.pipValuePerLot,
    pip: position.pip,
    stage: prior.protectionStage || '',
    retentionFloorUsd: Number(prior.retentionFloorUsd) || 0,
  })

  const decision = decisionFor(result.action, result.closeRequested)

  // In shadow mode this is ALWAYS {modify:false, close:false}. It is computed so
  // the row can record what live mode WOULD have done — never to act on it.
  const would = shadowDecision({
    shadowMode,
    newSl: result.newSl,
    closeRequested: result.closeRequested,
  })
  if (would.modify || would.close) {
    // Unreachable while shadowMode is true. Thrown rather than logged, because a
    // shadow module that can emit a command is a safety failure, not a warning.
    throw new Error('scalp-shadow-protection: shadow mode must never authorise a broker action')
  }

  const item = {
    ticket,
    tradeId: position.tradeId ?? null,
    pair: position.pair,
    direction: position.direction,
    lots: position.lots,
    openPrice: position.entry,
    initialSl: position.initialSl,
    currentSl: position.currentSl,
    currentPrice: position.currentPrice,
    currentProfit: position.currentProfit,
    peakProfit,
    plannedRiskUsd: position.riskUsd,
    currentR: position.riskUsd > 0 ? position.currentProfit / position.riskUsd : 0,
    peakR: result.peakR ?? (position.riskUsd > 0 ? peakProfit / position.riskUsd : 0),
    retainedPct: result.retentionPct,
    givebackPct: result.givebackPct,
    protectionStage: result.stage || prior.protectionStage || '',
    targetFloorUsd: result.floorUsd,
    proposedProtectionSl: result.newSl,
    existingManagerAction: null, // scalp positions receive no manager action — that is the point
    shadowDecision: decision,
    // MUST stay null. `rowKind()` classifies on `action`, and a non-null action
    // here would be a claim that something was done.
    action: null,
    actionAt: result.actionAt,
  }

  const row = toRow(item, { protectionMode: shadowMode ? 'shadow' : 'live' })

  // Counterfactual close ≠ lifecycle close — see scalpRowKind() above. This
  // position is OPEN by definition (it came from openTrades), so a WOULD_CLOSE
  // is recorded as a decision and the real lifecycle stays open until a
  // confirmed broker closure produces a 'close' row.
  row.row_kind = scalpRowKind(row.shadow_decision)

  /**
   * §5 — the FRESH observation, not the merged state.
   *
   * Returned separately so the caller owns persistence: this module performs no
   * I/O, and the merge (which enforces monotonicity) happens in one place where
   * it can be guarded before writing. `state` is provided as a convenience for
   * callers that just want the merged view.
   */
  const at = result.actionAt || new Date().toISOString()
  const stateDelta = {
    brokerTicket: ticket,
    tradeId: position.tradeId ?? prior.tradeId ?? null,
    openedAt: position.openedAt,
    initialSl: position.initialSl,
    plannedRiskUsd: position.riskUsd,
    peakProfit,
    peakR: item.peakR,
    protectionStage: item.protectionStage,
    retentionFloorUsd: result.floorUsd,
    // "First time it WOULD have acted" is a one-way fact — recorded once per decision kind.
    firstWouldMoveSlAt: decision === SHADOW_DECISIONS.moveSl ? at : undefined,
    firstWouldMoveSlToBeAt: decision === SHADOW_DECISIONS.moveSlToBe ? at : undefined,
    firstWouldCloseAt: decision === SHADOW_DECISIONS.close ? at : undefined,
    lastDecision: decision,
    lastEvaluatedAt: at,
    // §4 — the LAST GENUINE broker position snapshot for this lifecycle.
    //
    // This is what lets the close row carry real position data. Close detection
    // fires only once the position has already vanished from the account
    // snapshot, so by then the live `OpenTrade` is gone and
    // `buildScalpCloseRow()` has nothing left to read — which is exactly why
    // every production close row had NULL lots / open / current price / profit.
    // Capturing it here (and merging it forward in `mergeScalpShadowState`)
    // keeps the last known snapshot available, durably, across restarts.
    lastPosition: {
      ticket,
      pair: position.pair,
      direction: position.direction,
      lots: position.lots,
      entry: position.entry,
      currentPrice: position.currentPrice,
      currentSl: position.currentSl,
      currentProfit: position.currentProfit,
    },
  }

  return {
    row,
    state: mergeScalpShadowState(prior, stateDelta),
    stateDelta,
    decision,
    reason: null,
  }
}

/**
 * §Closure — the final row for a scalp position confirmed closed.
 *
 * `row_kind = 'close'` is what tells the analysis layer a lifecycle ended, and
 * `lib/profit-telemetry.mjs` classifies a row as a close only when the shadow
 * decision ends in `_CLOSE` or the action reads as a close. `buildCloseItem`
 * therefore marks the decision explicitly rather than relying on inference.
 *
 * Called only once per ticket, after the trade's own record shows it closed —
 * so this is not a second broker-close detector.
 */
export function buildScalpCloseRow({ finalState, lastPosition, closedAt, shadowMode = true }) {
  const state = finalState || {}
  // §4 — read the last GENUINE position snapshot. By the time a close is
  // detected the position has already left the account snapshot, so the live
  // `OpenTrade` no longer exists and the only surviving copy is the one the
  // evaluator persisted on the last observation. An explicit `lastPosition`
  // argument still wins when a caller has a fresher snapshot in hand.
  const explicit = (lastPosition && typeof lastPosition === 'object' && lastPosition.pair) ? lastPosition : null
  const retained = (state.lastPosition && typeof state.lastPosition === 'object') ? state.lastPosition : null
  const pos = explicit || retained || {}
  const item = {
    ticket: state.brokerTicket ?? pos.ticket ?? null,
    tradeId: state.tradeId ?? pos.tradeId ?? null,
    pair: pos.pair ?? null,
    direction: pos.direction ?? null,
    lots: pos.lots ?? null,
    openPrice: pos.entry ?? null,
    initialSl: state.initialSl ?? pos.initialSl ?? null,
    currentSl: pos.currentSl ?? null,
    currentPrice: pos.currentPrice ?? null,
    // The FINAL realised value is resolved by the analysis join against `trades`;
    // the last observed unrealised figure is carried here as the close reading.
    currentProfit: pos.currentProfit ?? null,
    peakProfit: state.peakProfit ?? null,
    plannedRiskUsd: state.plannedRiskUsd ?? null,
    currentR: state.plannedRiskUsd > 0 ? (pos.currentProfit ?? 0) / state.plannedRiskUsd : null,
    peakR: state.peakR ?? null,
    retainedPct: null,
    givebackPct: null,
    protectionStage: state.protectionStage || '',
    targetFloorUsd: state.retentionFloorUsd ?? 0,
    proposedProtectionSl: null,
    existingManagerAction: null,
    // §5 — a GENUINE broker closure is not a counterfactual. Stamping
    // `WOULD_CLOSE` here asserted that the shadow rule had wanted this position
    // closed, which it had never decided. The real closure gets its own label;
    // any true `WOULD_CLOSE` from earlier in the lifecycle already reached the
    // analysis as a `row_kind='decision'` row.
    shadowDecision: SHADOW_DECISIONS.brokerClose,
    action: 'close',
    actionAt: closedAt || new Date().toISOString(),
  }
  return toRow(item, { protectionMode: shadowMode ? 'shadow' : 'live' })
}


/** Exposed for tests and for callers that want to assert the read-only property. */
export const SHADOW_IS_READ_ONLY = true
export { rowKind, STAGE_RANK }

/**
 * §5 — merge durable scalp shadow state, monotonically.
 *
 * WHY NOT `mergeTradeState`
 *
 * That helper is shaped for the MT5 manager and enforces ITS invariants
 * (beApplied, partialLocked, reversalAlertSent). It would let the fields the
 * study actually depends on move backwards, and it drops nothing we need but
 * guarantees nothing we need either. The invariants below are this module's own.
 *
 * THE INVARIANTS, AND WHY EACH ONE MATTERS
 *
 *   peakProfit / peakR      — the numerator and denominator of every R figure.
 *                             A restart that lowered a peak would silently
 *                             reclassify a trade into a lower protection band.
 *   protectionStage         — a stage is EARNED by a peak the trade already
 *                             reached. Losing it means the ratchet can never
 *                             re-arm at the level it already justified.
 *   retentionFloorUsd       — a floor is protection already granted.
 *   initialSl               — 1R is derived from it. If it moved, 1R would shrink
 *                             and peakR would inflate, dragging trades into
 *                             higher bands. Frozen after first valid capture.
 *   first*At timestamps     — "first time it WOULD have acted" is a one-way fact.
 *
 * Everything else (lastEvaluatedAt, stateSeq, peakProfit's latest reading) is
 * simply overwritten by the newer observation.
 */
export function mergeScalpShadowState(prev, next) {
  const prior = prev && typeof prev === 'object' ? prev : {}
  const fresh = next && typeof next === 'object' ? next : {}
  const maxNum = (a, b) => {
    const na = Number.isFinite(Number(a)) ? Number(a) : -Infinity
    const nb = Number.isFinite(Number(b)) ? Number(b) : -Infinity
    const m = Math.max(na, nb)
    return m === -Infinity ? undefined : m
  }
  const firstOf = (a, b) => a || b || undefined
  const stageRank = (s) => (s && Number.isFinite(STAGE_RANK[s]) ? STAGE_RANK[s] : -1)
  const winningStage = (a, b) => (stageRank(a) >= stageRank(b) ? a || b : b || a)

  return {
    brokerTicket: fresh.brokerTicket ?? prior.brokerTicket ?? null,
    tradeId: fresh.tradeId ?? prior.tradeId ?? null,
    // Frozen: the FIRST valid capture wins and is never rewritten.
    openedAt: prior.openedAt || fresh.openedAt || null,
    initialSl: Number.isFinite(Number(prior.initialSl)) ? prior.initialSl : fresh.initialSl,
    plannedRiskUsd: Number.isFinite(Number(prior.plannedRiskUsd))
      ? prior.plannedRiskUsd
      : fresh.plannedRiskUsd,
    peakProfit: maxNum(prior.peakProfit, fresh.peakProfit),
    peakR: maxNum(prior.peakR, fresh.peakR),
    protectionStage: winningStage(prior.protectionStage, fresh.protectionStage) || '',
    retentionFloorUsd: maxNum(prior.retentionFloorUsd, fresh.retentionFloorUsd) ?? 0,
    stateSeq: maxNum(prior.stateSeq, fresh.stateSeq) ?? null,
    firstWouldMoveSlAt: firstOf(prior.firstWouldMoveSlAt, fresh.firstWouldMoveSlAt),
    firstWouldMoveSlToBeAt: firstOf(prior.firstWouldMoveSlToBeAt, fresh.firstWouldMoveSlToBeAt),
    firstWouldCloseAt: firstOf(prior.firstWouldCloseAt, fresh.firstWouldCloseAt),
    // Not protection — free to move forward.
    lastDecision: fresh.lastDecision ?? prior.lastDecision ?? null,
    lastEvaluatedAt: fresh.lastEvaluatedAt ?? prior.lastEvaluatedAt ?? null,
    // §4 — the most recent GENUINE position snapshot. "Latest known wins": this is
    // an observation, not a protection level, so it may move forward freely. A
    // merge that carries no position (e.g. a state-only write) preserves the prior
    // one, so the close row can still read it after a restart.
    lastPosition: (fresh.lastPosition && typeof fresh.lastPosition === 'object')
      ? fresh.lastPosition
      : (prior.lastPosition && typeof prior.lastPosition === 'object' ? prior.lastPosition : null),
  }
}

/**
 * Verify a merged state has not regressed. Used as a pre-write guard so a bug in
 * the merge cannot reach the database unnoticed.
 * @returns {{ok: boolean, issues: string[]}}
 */
export function assertScalpStateMonotonic(prev, merged) {
  const p = prev || {}
  const m = merged || {}
  const issues = []
  const lt = (a, b) => Number.isFinite(Number(a)) && (!Number.isFinite(Number(b)) || Number(b) < Number(a))
  if (lt(p.peakProfit, m.peakProfit)) issues.push('peakProfit')
  if (lt(p.peakR, m.peakR)) issues.push('peakR')
  if (lt(p.retentionFloorUsd, m.retentionFloorUsd)) issues.push('retentionFloorUsd')
  if ((STAGE_RANK[m.protectionStage] ?? -1) < (STAGE_RANK[p.protectionStage] ?? -1)) issues.push('protectionStage')
  if (Number.isFinite(Number(p.initialSl)) && Number(p.initialSl) !== Number(m.initialSl)) issues.push('initialSl')
  if (p.firstWouldMoveSlAt && !m.firstWouldMoveSlAt) issues.push('firstWouldMoveSlAt')
  if (p.firstWouldMoveSlToBeAt && !m.firstWouldMoveSlToBeAt) issues.push('firstWouldMoveSlToBeAt')
  if (p.firstWouldCloseAt && !m.firstWouldCloseAt) issues.push('firstWouldCloseAt')
  return { ok: issues.length === 0, issues }
}



