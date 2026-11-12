// tests/order-authority.test.mjs
// Phase 4.1A — central order authority policy.
// Covers: confidence rejection, out-of-window automated submission, manual
// execution, unauthorised API submission, expired signal, duplicate request id,
// missing signal, and every order source.
// Run: npm run test:order-authority
import assert from 'node:assert/strict'
import {
  AUTHORITY_POLICY_VERSION, BLOCKING_REASONS, DECISION, REASON, SUBMISSION_SOURCE,
  classifySubmission, deriveRequestId, evaluateOrderAuthority,
} from '../lib/order-authority.mjs'

// ── A — the production evidence that started this phase ──────────────────────
{
  // 12 Nov 2026: these are the ACTUAL signal_id_ref values on tickets
  // 3454451953 / 3454458505. They carry NO worker- prefix.
  const t1 = classifySubmission({ signalIdRef: 'scalp-XAUUSD-1794450323236', source: 'scalp' })
  const t2 = classifySubmission({ signalIdRef: 'scalp-XAUUSD-1794450734543', source: 'scalp' })

  assert.equal(t1.submissionSource, SUBMISSION_SOURCE.UI_SCALP_CARD, 'A: ticket 3454451953 is a browser scalp card')
  assert.equal(t2.submissionSource, SUBMISSION_SOURCE.UI_SCALP_CARD, 'A: ticket 3454458505 is a browser scalp card')
  assert.equal(t1.manual, true, 'A: it is a human decision, not automation')
  assert.equal(t1.inferredFrom, 'signal_id_ref_prefix', 'A: classification came from the only reliable evidence')
  console.log('PASS A: 12 Nov orders classify as UI_SCALP_CARD (browser), never WORKER_AUTOTRADE')
}

// ── B — the worker's own submissions remain distinguishable ──────────────────
{
  const w = classifySubmission({ signalIdRef: 'worker-scalp-XAUUSD-1794450323236', source: 'scalp' })
  assert.equal(w.submissionSource, SUBMISSION_SOURCE.WORKER_AUTOTRADE, 'B')
  assert.equal(w.automated, true, 'B')
  // The critical pair: identical `source` column, opposite authority lane.
  assert.notEqual(w.submissionSource, SUBMISSION_SOURCE.UI_SCALP_CARD, "B: source='scalp' alone must not conflate them")
  const m = classifySubmission({ signalIdRef: 'mirror-XAUUSD-1794450323236' })
  assert.equal(m.submissionSource, SUBMISSION_SOURCE.UI_MIRROR_CARD, 'B')
  console.log("PASS B: worker / browser / mirror are separable even though source='scalp' for both")
}

// ── C — explicit submission_source wins over inference ──────────────────────
{
  const c = classifySubmission({ submissionSource: 'UI_METALS', signalIdRef: 'worker-scalp-XAUUSD-9' })
  assert.equal(c.submissionSource, SUBMISSION_SOURCE.UI_METALS, 'C')
  assert.equal(c.inferredFrom, 'explicit_submission_source', 'C')
  const unknown = classifySubmission({ submissionSource: 'NOT_A_LANE', signalIdRef: 'abc' })
  assert.equal(unknown.submissionSource, SUBMISSION_SOURCE.UNKNOWN, 'C: bogus lane is not trusted')
  console.log('PASS C: explicit lane wins; unknown lanes are not accepted blindly')
}

// ── D — confidence rejection (automated) ────────────────────────────────────
{
  const d = evaluateOrderAuthority({
    signalIdRef: 'worker-scalp-XAUUSD-1', userId: 'u1',
    confidence: 40, minConfidence: 55,
  })
  assert.equal(d.decision, DECISION.REJECTED_UNAUTHORISED, 'D')
  assert.equal(d.reason, REASON.CONFIDENCE_BELOW_THRESHOLD, 'D')
  assert.equal(d.blocking, false, 'D: already enforced by the worker — not duplicated as a hard block here')
  assert.equal(d.policyVersion, AUTHORITY_POLICY_VERSION, 'D: version stamped')

  const pass = evaluateOrderAuthority({
    signalIdRef: 'worker-scalp-XAUUSD-1', userId: 'u1',
    confidence: 70, minConfidence: 55,
  })
  assert.equal(pass.decision, DECISION.APPROVED_AUTOMATED, 'D: above threshold approves')
  console.log('PASS D: confidence-rejected automated signal is rejected by the policy')
}

// ── E — out-of-window automated submission ──────────────────────────────────
{
  const outside = evaluateOrderAuthority({
    signalIdRef: 'worker-scalp-XAUUSD-2', userId: 'u1',
    autoTradeWindowOpen: false, windowAuthoritative: true,
  })
  assert.equal(outside.decision, DECISION.REJECTED_UNAUTHORISED, 'E')
  assert.equal(outside.reason, REASON.OUTSIDE_AUTHORISED_WINDOW, 'E')

  // A window that is NOT asserted at this layer must not be invented here: the
  // real window is conditional on Prop Firm Mode and owned by the worker.
  const notAsserted = evaluateOrderAuthority({ signalIdRef: 'worker-scalp-XAUUSD-2', userId: 'u1' })
  assert.equal(notAsserted.decision, DECISION.APPROVED_AUTOMATED, 'E: window not re-derived at the API')
  assert.match(notAsserted.detail, /owned by the worker/, 'E: limitation is stated, not hidden')
  console.log('PASS E: out-of-window automation rejected when asserted; never re-derived silently')
}

// ── F — manual execution still works, and stays distinguishable ─────────────
{
  const manual = evaluateOrderAuthority({
    signalIdRef: 'scalp-XAUUSD-1794450323236', userId: 'u1',
    signalAtMs: 1_700_000_000_000, nowMs: 1_700_000_060_000,
  })
  assert.equal(manual.decision, DECISION.APPROVED_MANUAL, 'F: human scalp order is allowed')
  assert.equal(manual.reason, REASON.OK_MANUAL_WITH_SIGNAL_CONTEXT, 'F')
  assert.notEqual(manual.decision, DECISION.APPROVED_AUTOMATED, 'F: never conflated with automation')
  console.log('PASS F: manual execution unaffected and clearly labelled APPROVED_MANUAL')
}

// ── G — missing signal is NOT automatic manual authorisation ────────────────
{
  const g = evaluateOrderAuthority({ submissionSource: 'UI_METALS', userId: 'u1' })
  assert.equal(g.reason, REASON.MANUAL_WITHOUT_SIGNAL_CONTEXT, 'G: a missing signal is called out')
  assert.equal(g.blocking, false, 'G: but blocking it would change manual behaviour — reported, not enacted')

  const auto = evaluateOrderAuthority({ submissionSource: 'WORKER_AUTOTRADE', userId: 'u1' })
  assert.equal(auto.decision, DECISION.REJECTED_UNAUTHORISED, 'G: automation without a signal is refused')
  assert.equal(auto.reason, REASON.MISSING_SIGNAL_CONTEXT_FOR_AUTOMATION, 'G')
  assert.equal(auto.blocking, true, 'G: and that one IS blocking')
  console.log('PASS G: missing signal is not treated as authorised manual execution')
}


// ── H — expired signal ──────────────────────────────────────────────────────
{
  const h = evaluateOrderAuthority({
    signalIdRef: 'scalp-XAUUSD-1', userId: 'u1',
    signalAtMs: 1_700_000_000_000, nowMs: 1_700_000_000_000 + 5 * 60_000, maxSignalAgeMs: 2 * 60_000,
  })
  assert.equal(h.decision, DECISION.REJECTED_UNAUTHORISED, 'H')
  assert.equal(h.reason, REASON.SIGNAL_EXPIRED, 'H')
  assert.equal(h.blocking, true, 'H: an expired signal must not reach the broker on any lane')
  console.log('PASS H: expired signal is rejected')
}

// ── I — duplicate request ids cannot create duplicate orders ────────────────
{
  const i = evaluateOrderAuthority({
    signalIdRef: 'worker-scalp-XAUUSD-3', userId: 'u1', requestId: 'req-1',
    seenRequestIds: ['req-1'],
  })
  assert.equal(i.decision, DECISION.REJECTED_UNAUTHORISED, 'I')
  assert.equal(i.reason, REASON.DUPLICATE_REQUEST_ID, 'I')
  assert.equal(i.blocking, true, 'I')

  const fresh = evaluateOrderAuthority({
    signalIdRef: 'worker-scalp-XAUUSD-3', userId: 'u1', requestId: 'req-2', seenRequestIds: ['req-1'],
  })
  assert.equal(fresh.decision, DECISION.APPROVED_AUTOMATED, 'I: a new request id is fine')
  console.log('PASS I: duplicate request id rejected; new request id accepted')
}

// ── J — unattributed manual order ───────────────────────────────────────────
{
  const j = evaluateOrderAuthority({ signalIdRef: 'scalp-XAUUSD-1', userId: null })
  assert.equal(j.decision, DECISION.REJECTED_UNAUTHORISED, 'J')
  assert.equal(j.reason, REASON.UNATTRIBUTED_MANUAL_ORDER, 'J')
  assert.equal(j.blocking, true, 'J: an order with no owner cannot be authorised')
  console.log('PASS J: unattributed manual submission refused')
}

// ── K — unclassified legacy caller is audited, not broken ───────────────────
{
  const k = evaluateOrderAuthority({ userId: 'u1', signalIdRef: 'legacy-ref' })
  assert.equal(k.submissionSource, SUBMISSION_SOURCE.UNKNOWN, 'K')
  assert.equal(k.reason, REASON.UNCLASSIFIED_SUBMISSION_SOURCE, 'K')
  assert.equal(k.blocking, false, 'K: legacy callers keep working until migrated')
  console.log('PASS K: unclassified legacy caller recorded as UNKNOWN, not blocked')
}

// ── L — only the intended reason codes may block ────────────────────────────
{
  assert.equal(BLOCKING_REASONS.has(REASON.DUPLICATE_REQUEST_ID), true)
  assert.equal(BLOCKING_REASONS.has(REASON.SIGNAL_EXPIRED), true)
  assert.equal(BLOCKING_REASONS.has(REASON.MISSING_SIGNAL_CONTEXT_FOR_AUTOMATION), true)
  assert.equal(BLOCKING_REASONS.has(REASON.UNATTRIBUTED_MANUAL_ORDER), true)
  // Explicitly audited-only — changing these would alter approved behaviour.
  assert.equal(BLOCKING_REASONS.has(REASON.MANUAL_WITHOUT_SIGNAL_CONTEXT), false, 'L')
  assert.equal(BLOCKING_REASONS.has(REASON.OUTSIDE_AUTHORISED_WINDOW), false, 'L')
  assert.equal(BLOCKING_REASONS.has(REASON.CONFIDENCE_BELOW_THRESHOLD), false, 'L')
  assert.equal(BLOCKING_REASONS.has(REASON.UNCLASSIFIED_SUBMISSION_SOURCE), false, 'L')
  console.log('PASS L: enforcement surface is exactly the four safe reason codes')
}

// ── M — request id derivation is stable and collision-safe ──────────────────
{
  const a = deriveRequestId({
    submissionSource: 'UI_SCALP_CARD', userId: 'u1', pair: 'XAU/USD',
    direction: 'SELL', signalIdRef: 'scalp-XAUUSD-1794450734543', signalAtMs: 1794450734543,
  })
  const b = deriveRequestId({
    submissionSource: 'UI_SCALP_CARD', userId: 'u1', pair: 'XAU/USD',
    direction: 'SELL', signalIdRef: 'scalp-XAUUSD-1794450734543', signalAtMs: 1794450734543,
  })
  const c = deriveRequestId({ submissionSource: 'WORKER_AUTOTRADE', userId: 'u1', pair: 'XAU/USD', direction: 'SELL' })
  assert.equal(a, b, 'M: identical submissions derive an identical id (retry collides)')
  assert.notEqual(a, c, 'M: a different lane derives a different id')
  console.log('PASS M: request id is a deterministic retry collision, not a random value')
}

console.log('\norder-authority: 13/13 groups passed')

