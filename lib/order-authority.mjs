// lib/order-authority.mjs
// ─────────────────────────────────────────────────────────────────────────────
// SybexForexAI — CENTRAL ORDER AUTHORITY POLICY (Phase 4.1A)
//
// Pure + deterministic. No DB, no I/O, no broker. Imported by /api/orders and by
// the tests, so the policy that runs in production is the policy under test.
//
// WHY THIS MODULE EXISTS
// ----------------------
// On 2026-11-12 two XAU/USD SELL orders (broker tickets 3454451953 / 3454458505)
// reached MT5 while the scalper worker logged `auto-trade skipped-confidence`.
// There was no contradiction inside the worker — the orders never came from it.
// The rows could not prove that, because `trades.source` is 'scalp' for BOTH the
// worker (workers/scalper.mjs placeOrder) and the browser scalp card
// (components/pages/AutoTradePage.tsx handleScalpOrder).
//
// The ONLY field that distinguished them was `signal_id_ref`, by its prefix:
//
//   worker  → `worker-${section}-${PAIR}${Date.now()}`   workers/scalper.mjs:1916
//   browser → `scalp-${PAIR}${fetchedAt}`                 AutoTradePage.tsx:718
//             `mirror-${PAIR}${fetchedAt}`                AutoTradePage.tsx:778
//
// That is an accidental audit trail: nothing enforced it, nothing recorded who
// submitted an order, and no authorisation decision was ever persisted. This
// module replaces the accident with an explicit contract.
//
// DESIGN CONSTRAINT (Phase 4.1A — auditability first, enforcement second)
// ----------------------------------------------------------------------
// Recording the decision is unconditional. BLOCKING on it is opt-in per reason
// code (see BLOCKING_REASONS), because several reason codes describe the
// existing manual-trading behaviour. Changing what a human may do is a separate
// change that must be reported before it is implemented — so it is NOT done here.
// ─────────────────────────────────────────────────────────────────────────────

/** Bump whenever a decision rule below changes meaning. Persisted per order. */
export const AUTHORITY_POLICY_VERSION = 'order_authority_v1'

/**
 * Every submission path that can reach POST /api/orders, enumerated explicitly so
 * a new caller has to pick a lane instead of defaulting into an existing one.
 */
export const SUBMISSION_SOURCE = {
  WORKER_AUTOTRADE: 'WORKER_AUTOTRADE',   // workers/scalper.mjs — automated
  UI_SCALP_CARD: 'UI_SCALP_CARD',         // AutoTradePage — human, scalp direction
  UI_MIRROR_CARD: 'UI_MIRROR_CARD',       // AutoTradePage — human, inverted direction
  UI_AUTO_TRADER: 'UI_AUTO_TRADER',       // AutoTradePage — human-triggered autotrader
  UI_SCAN_APPROVE: 'UI_SCAN_APPROVE',     // AutoTradePage — human approving a scan signal
  UI_METALS: 'UI_METALS',                 // MetalsPage
  UI_SCALP_PAGE: 'UI_SCALP_PAGE',         // ScalpPage
  UI_SCALPER_PAGE: 'UI_SCALPER_PAGE',     // ScalperPage
  UI_ANALYSIS: 'UI_ANALYSIS',             // AnalysisPage
  EXTERNAL_API: 'EXTERNAL_API',           // approved integration
  UNKNOWN: 'UNKNOWN',                     // legacy/unspecified caller
}

/** Sources that are machine-driven. Everything else is a human decision. */
const AUTOMATED_SOURCES = new Set([
  SUBMISSION_SOURCE.WORKER_AUTOTRADE,
  SUBMISSION_SOURCE.EXTERNAL_API,
])

const MANUAL_SOURCES = new Set([
  SUBMISSION_SOURCE.UI_SCALP_CARD,
  SUBMISSION_SOURCE.UI_MIRROR_CARD,
  SUBMISSION_SOURCE.UI_AUTO_TRADER,
  SUBMISSION_SOURCE.UI_SCAN_APPROVE,
  SUBMISSION_SOURCE.UI_METALS,
  SUBMISSION_SOURCE.UI_SCALP_PAGE,
  SUBMISSION_SOURCE.UI_SCALPER_PAGE,
  SUBMISSION_SOURCE.UI_ANALYSIS,
])

export const DECISION = {
  APPROVED_AUTOMATED: 'APPROVED_AUTOMATED',
  APPROVED_MANUAL: 'APPROVED_MANUAL',
  REJECTED_UNAUTHORISED: 'REJECTED_UNAUTHORISED',
}

export const REASON = {
  OK_AUTOMATED_GATES_PASSED: 'OK_AUTOMATED_GATES_PASSED',
  OK_MANUAL_WITH_SIGNAL_CONTEXT: 'OK_MANUAL_WITH_SIGNAL_CONTEXT',
  OK_MANUAL_EXPLICITLY_AUTHORISED: 'OK_MANUAL_EXPLICITLY_AUTHORISED',
  DUPLICATE_REQUEST_ID: 'DUPLICATE_REQUEST_ID',
  SIGNAL_EXPIRED: 'SIGNAL_EXPIRED',
  MISSING_SIGNAL_CONTEXT_FOR_AUTOMATION: 'MISSING_SIGNAL_CONTEXT_FOR_AUTOMATION',
  CONFIDENCE_BELOW_THRESHOLD: 'CONFIDENCE_BELOW_THRESHOLD',
  OUTSIDE_AUTHORISED_WINDOW: 'OUTSIDE_AUTHORISED_WINDOW',
  UNATTRIBUTED_MANUAL_ORDER: 'UNATTRIBUTED_MANUAL_ORDER',
  MANUAL_WITHOUT_SIGNAL_CONTEXT: 'MANUAL_WITHOUT_SIGNAL_CONTEXT',
  UNCLASSIFIED_SUBMISSION_SOURCE: 'UNCLASSIFIED_SUBMISSION_SOURCE',
  MISSING_REQUEST_ID: 'MISSING_REQUEST_ID',
}


/**
 * Reason codes that are allowed to block the request.
 *
 * Deliberately EXCLUDED (audited, never blocked) because blocking them would
 * change existing manual-trading behaviour or duplicate a policy that already
 * lives somewhere authoritative:
 *
 *   MANUAL_WITHOUT_SIGNAL_CONTEXT   — a human may currently trade without a
 *                                     signal; changing that is a product
 *                                     decision, not an integrity fix.
 *   OUTSIDE_AUTHORISED_WINDOW       — the window is conditional on Prop Firm
 *                                     Mode (workers/scalper.mjs:2386) and is
 *                                     owned by the worker. Re-deriving it in the
 *                                     API risks changing an approved window.
 *   CONFIDENCE_BELOW_THRESHOLD      — owned by the worker (scalper.mjs:2225).
 *                                     Enforcing it here for manual orders would
 *                                     silently block humans.
 *   UNCLASSIFIED_SUBMISSION_SOURCE  — legacy callers must keep working until
 *                                     they are migrated; audited meanwhile.
 */
export const BLOCKING_REASONS = new Set([
  REASON.DUPLICATE_REQUEST_ID,
  REASON.SIGNAL_EXPIRED,
  REASON.MISSING_SIGNAL_CONTEXT_FOR_AUTOMATION,
  REASON.UNATTRIBUTED_MANUAL_ORDER,
])

/**
 * Infer the submission lane from what the caller actually sent.
 *
 * An explicit `submission_source` always wins (new callers). Otherwise the
 * `signal_id_ref` prefix is used, because that is the only field production
 * evidence proved reliable (12 Nov 2026: `scalp-XAUUSD-…` ⇒ browser).
 *
 * @returns {{ submissionSource: string, inferredFrom: string, automated: boolean, manual: boolean }}
 */
export function classifySubmission(input = {}) {
  const explicit = String(input.submissionSource ?? input.submission_source ?? '').trim().toUpperCase()
  if (explicit && (AUTOMATED_SOURCES.has(explicit) || MANUAL_SOURCES.has(explicit))) {
    return finish(explicit, 'explicit_submission_source')
  }

  const ref = String(input.signalIdRef ?? input.signal_id_ref ?? '')
  const signalId = String(input.signalId ?? input.signal_id ?? '')
  const probe = ref || signalId

  if (probe.startsWith('worker-')) return finish(SUBMISSION_SOURCE.WORKER_AUTOTRADE, 'signal_id_ref_prefix')
  if (probe.startsWith('scalp-')) return finish(SUBMISSION_SOURCE.UI_SCALP_CARD, 'signal_id_ref_prefix')
  if (probe.startsWith('mirror-')) return finish(SUBMISSION_SOURCE.UI_MIRROR_CARD, 'signal_id_ref_prefix')

  return finish(SUBMISSION_SOURCE.UNKNOWN, 'unclassified')
}

function finish(submissionSource, inferredFrom) {
  return {
    submissionSource,
    inferredFrom,
    automated: AUTOMATED_SOURCES.has(submissionSource),
    manual: MANUAL_SOURCES.has(submissionSource),
  }
}


/**
 * Evaluate the single central policy for one order submission.
 *
 * @param {object} input
 * @param {string}  [input.submissionSource]         explicit lane (preferred)
 * @param {string}  [input.signalIdRef]              signal_id_ref as submitted
 * @param {string}  [input.signalId]                 legacy signalId
 * @param {string}  [input.userId]                   authenticated user id
 * @param {boolean} [input.manualAuthorised]         caller asserts a human authorised this
 * @param {number}  [input.confidence]               signal confidence
 * @param {number}  [input.minConfidence]            worker threshold, when known
 * @param {number}  [input.signalAtMs]               signal timestamp (epoch ms)
 * @param {number}  [input.nowMs]                    evaluation time (epoch ms)
 * @param {number}  [input.maxSignalAgeMs]           freshness budget
 * @param {boolean|null} [input.autoTradeWindowOpen] null = not asserted at this layer
 * @param {boolean} [input.windowAuthoritative]      caller is the owner of the window
 * @param {string}  [input.requestId]                idempotency key
 * @param {Set<string>|string[]} [input.seenRequestIds] already-accepted request ids
 * @returns {{ decision: string, reason: string, detail: string, blocking: boolean,
 *            submissionSource: string, policyVersion: string, automated: boolean }}
 */
export function evaluateOrderAuthority(input = {}) {
  const classified = classifySubmission(input)
  const { submissionSource, automated, inferredFrom } = classified
  const policyVersion = AUTHORITY_POLICY_VERSION

  const emit = (decision, reason, detail, extra = {}) => ({
    decision,
    reason,
    detail,
    submissionSource,
    inferredFrom,
    policyVersion,
    automated,
    blocking: decision === DECISION.REJECTED_UNAUTHORISED && (
      extra.blocking !== undefined ? !!extra.blocking : BLOCKING_REASONS.has(reason)
    ),
  })

  // ── 0. Idempotency: the same request id must never produce a second order ──
  const requestId = String(input.requestId ?? '').trim()
  const seen = normaliseSeen(input.seenRequestIds)
  if (requestId && seen.has(requestId)) {
    return emit(DECISION.REJECTED_UNAUTHORISED, REASON.DUPLICATE_REQUEST_ID,
      `request_id ${requestId} was already accepted — refusing to resubmit`, { blocking: true })
  }

  // ── 1. Signal freshness — applies to every lane that carries a signal ─────
  const signalAtMs = num(input.signalAtMs)
  const nowMs = num(input.nowMs) ?? Date.now()
  const maxAge = num(input.maxSignalAgeMs)
  if (signalAtMs !== null && maxAge !== null && (nowMs - signalAtMs) > maxAge) {
    const ageS = Math.round((nowMs - signalAtMs) / 1000)
    return emit(DECISION.REJECTED_UNAUTHORISED, REASON.SIGNAL_EXPIRED,
      `signal is ${ageS}s old (limit ${Math.round(maxAge / 1000)}s) — refresh before trading`,
      { blocking: true })
  }

  const hasSignalContext = Boolean(
    String(input.signalIdRef ?? input.signal_id_ref ?? '').trim() ||
    String(input.signalId ?? input.signal_id ?? '').trim() ||
    signalAtMs !== null
  )

  // ── 2. Automated lanes: the machine must prove its own gate passed ────────
  if (automated) {
    if (!hasSignalContext) {
      return emit(DECISION.REJECTED_UNAUTHORISED, REASON.MISSING_SIGNAL_CONTEXT_FOR_AUTOMATION,
        'automated submission carries no signal reference — an automated order must be traceable to a signal',
        { blocking: true })
    }
    const confidence = num(input.confidence)
    const minConfidence = num(input.minConfidence)
    if (confidence !== null && minConfidence !== null && confidence < minConfidence) {
      return emit(DECISION.REJECTED_UNAUTHORISED, REASON.CONFIDENCE_BELOW_THRESHOLD,
        `confidence ${confidence} is below the ${minConfidence} threshold`, { blocking: false })
    }
    const windowOpen = input.autoTradeWindowOpen
    if (windowOpen === false && input.windowAuthoritative === true) {
      return emit(DECISION.REJECTED_UNAUTHORISED, REASON.OUTSIDE_AUTHORISED_WINDOW,
        'automated submission is outside the authorised trading window', { blocking: false })
    }
    return emit(DECISION.APPROVED_AUTOMATED, REASON.OK_AUTOMATED_GATES_PASSED,
      (windowOpen === null || windowOpen === undefined)
        ? 'automated gates passed at this layer; trading window is owned by the worker and was not re-evaluated here'
        : 'automated gates passed')
  }

  // ── 3. Manual lanes: attributable human, and a reason to exist ────────────
  if (classified.manual) {
    const userId = input.userId
    if (userId === undefined || userId === null || String(userId).trim() === '') {
      return emit(DECISION.REJECTED_UNAUTHORISED, REASON.UNATTRIBUTED_MANUAL_ORDER,
        'manual submission has no authenticated user — an unattributed broker order cannot be authorised',
        { blocking: true })
    }
    if (!hasSignalContext && !input.manualAuthorised) {
      // NOT blocked (see BLOCKING_REASONS): audited + flagged as incomplete.
      return emit(DECISION.APPROVED_MANUAL, REASON.MANUAL_WITHOUT_SIGNAL_CONTEXT,
        'manual order without signal context — allowed today, but lineage will be incomplete',
        { blocking: false })
    }
    return emit(DECISION.APPROVED_MANUAL,
      hasSignalContext ? REASON.OK_MANUAL_WITH_SIGNAL_CONTEXT : REASON.OK_MANUAL_EXPLICITLY_AUTHORISED,
      'human-authorised submission inside the existing manual controls', { blocking: false })
  }

  // ── 4. Unclassified: legacy caller. Audit loudly, do not break it. ────────
  return emit(DECISION.APPROVED_MANUAL, REASON.UNCLASSIFIED_SUBMISSION_SOURCE,
    'submission source could not be classified — recorded as UNKNOWN for audit; migrate this caller',
    { blocking: false })
}

function num(v) {
  if (v === undefined || v === null || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

function normaliseSeen(v) {
  if (v instanceof Set) return v
  if (Array.isArray(v)) return new Set(v.map(String))
  return new Set()
}

/**
 * Generate the idempotency key for a submission when the caller did not supply
 * one. Deliberately derived from the *caller's* identity + signal, not a random
 * value, so an identical retry collides and is rejected instead of duplicating.
 */
export function deriveRequestId({ submissionSource, userId, pair, direction, signalIdRef, signalAtMs } = {}) {
  return [submissionSource, userId ?? '-', pair ?? '-', direction ?? '-', signalIdRef ?? '-', signalAtMs ?? '-']
    .map((p) => String(p))
    .join(':')
}

