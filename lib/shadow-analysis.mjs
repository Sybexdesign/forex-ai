// lib/shadow-analysis.mjs
// Profit-protection shadow STUDY — pure analysis helpers.
//
// Sits ABOVE lib/profit-telemetry.mjs: that module turns rows into per-trade
// ACTUAL vs COUNTERFACTUAL summaries; this one classifies those summaries and
// assembles the study report (per-trade table, zones, capture efficiency).
//
// NO I/O here and NO trading logic. Every `estShadow*` figure is an estimate
// derived from the conservative counterfactual in profit-telemetry.mjs — never
// broker-realised money, and never presented as such.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Materiality threshold for calling a shadow/actual difference a real
 * difference: a dollar amount AND a fraction of 1R, whichever is larger, so the
 * call is neither noise on a small trade nor a rounding artefact on a large one.
 */
export const MATERIAL_USD = 1.0
export const MATERIAL_FRACTION_OF_R = 0.05

export const materialityThreshold = (riskUsd) => {
  const r = Number(riskUsd)
  if (!Number.isFinite(r) || r <= 0) return MATERIAL_USD
  return Math.max(MATERIAL_USD, r * MATERIAL_FRACTION_OF_R)
}

/** The study's classification vocabulary. */
export const CLASSIFICATIONS = [
  'INSUFFICIENT DATA',
  'ROUND-TRIP PREVENTED',
  'EARLY-BE POSSIBLY PREMATURE',
  'POSSIBLE WINNER CLIP',
  'SHADOW IMPROVED',
  'NO MATERIAL DIFFERENCE',
]

/**
 * Classify one per-trade summary.
 *
 * Precedence is deliberate, and the order is the argument:
 *
 *   1. INSUFFICIENT DATA first — with no realised result or no positive MFE
 *      there is nothing to compare, and classifying it as anything else would
 *      pad the sample with trades that cannot support a conclusion.
 *   2. ROUND-TRIP PREVENTED — the strongest positive signal: the trade went
 *      positive, gave it all back and closed at a loss, while the shadow rescue
 *      would have banked something.
 *   3. The two RISK signals BEFORE the positive ones. If a shadow rule would
 *      have closed a winner early, that is the finding that should block live
 *      enablement, so it must not be masked by a favourable dollar delta.
 *   4. SHADOW IMPROVED / NO MATERIAL DIFFERENCE last.
 */
export function classify(summary) {
  const actual = summary?.actualRealisedPnlUsd
  const mfe = summary?.actualMfeUsd
  const est = summary?.estShadowPnlUsd

  if (actual == null || est == null) return 'INSUFFICIENT DATA'
  if (!(Number(mfe) > 0)) return 'INSUFFICIENT DATA'

  const threshold = materialityThreshold(summary.riskUsd)
  const delta = Number(est) - Number(actual)

  // Positive MFE that ended in a realised loss — the round-trip case.
  if (summary.preventedRoundTripEst) return 'ROUND-TRIP PREVENTED'

  // The shadow would have stopped a runner early on a trade still working.
  if (delta < -threshold && summary.hadEarlyRescueTrigger) return 'EARLY-BE POSSIBLY PREMATURE'
  if (summary.clippedEst && delta < -threshold) return 'POSSIBLE WINNER CLIP'

  if (delta > threshold) return 'SHADOW IMPROVED'
  return 'NO MATERIAL DIFFERENCE'
}

/** Attach the classification, keeping every source field intact. */
export const withClassification = (summary) => ({
  ...summary,
  classification: classify(summary),
  deltaUsd:
    summary.actualRealisedPnlUsd != null && summary.estShadowPnlUsd != null
      ? Math.round((summary.estShadowPnlUsd - summary.actualRealisedPnlUsd) * 100) / 100
      : null,
})

export const ZONE_ORDER = ['A', 'B', 'C', 'SR']

const medianOf = (vals) => {
  if (!vals.length) return null
  const v = [...vals].sort((a, b) => a - b)
  return Math.round(v[Math.floor(v.length / 2)] * 1000) / 1000
}

/**
 * Per-zone actual vs estimated outcomes.
 *
 * The point of splitting by zone is that a single "average improvement" hides
 * the thing that matters: the ratchet may help in the middle, where trades give
 * profit back, while systematically hurting the >=2R runners. Averaging those
 * together reports a mild net gain and buries the clipping.
 */
export function zoneReport(summaries) {
  const out = {}
  for (const zone of ZONE_ORDER) {
    const inZone = summaries.filter((s) => s.zone === zone)
    const sum = (sel) => Math.round(inZone.reduce((a, s) => a + (Number(sel(s)) || 0), 0) * 100) / 100
    out[zone] = {
      count: inZone.length,
      actualTotalPnlUsd: sum((s) => s.actualRealisedPnlUsd),
      estShadowTotalPnlUsd: sum((s) => s.estShadowPnlUsd),
      actualMedianCapture: medianOf(inZone.map((s) => s.actualCaptureEfficiency).filter((v) => v != null)),
      estShadowMedianCapture: medianOf(inZone.map((s) => s.estShadowCaptureEfficiency).filter((v) => v != null)),
      classifications: inZone.reduce((acc, s) => {
        acc[s.classification] = (acc[s.classification] || 0) + 1
        return acc
      }, {}),
    }
  }
  return out
}

/** Capture-efficiency distribution, computed identically for both series. */
export function captureEfficiency(summaries) {
  const stats = (vals) => {
    if (!vals.length) {
      return { count: 0, median: null, mean: null, buckets: { lt25: 0, p25_50: 0, p50_75: 0, gt75: 0 } }
    }
    const v = [...vals].sort((a, b) => a - b)
    const bucket = (lo, hi) => v.filter((x) => x >= lo && x < hi).length
    return {
      count: v.length,
      median: medianOf(v),
      mean: Math.round((v.reduce((a, b) => a + b, 0) / v.length) * 1000) / 1000,
      buckets: {
        lt25: bucket(0, 0.25),
        p25_50: bucket(0.25, 0.5),
        p50_75: bucket(0.5, 0.75),
        gt75: bucket(0.75, Infinity),
      },
    }
  }
  const actual = stats(summaries.map((s) => s.actualCaptureEfficiency).filter((v) => v != null))
  const shadow = stats(summaries.map((s) => s.estShadowCaptureEfficiency).filter((v) => v != null))
  return {
    actual,
    shadow,
    medianImprovement:
      actual.median != null && shadow.median != null
        ? Math.round((shadow.median - actual.median) * 1000) / 1000
        : null,
    // A positive MFE that still closed at a loss — the behaviour the study is
    // trying to eliminate. Reported for both actual and estimated.
    positiveMfeEndingInLoss: {
      actual: summaries.filter((s) => (s.actualMfeUsd ?? 0) > 0 && (s.actualRealisedPnlUsd ?? 0) < 0).length,
      estShadow: summaries.filter((s) => (s.actualMfeUsd ?? 0) > 0 && (s.estShadowPnlUsd ?? 0) < 0).length,
    },
    roundTripsPreventedEst: summaries.filter((s) => s.preventedRoundTripEst).length,
    winnersClippedEst: summaries.filter((s) => s.clippedEst).length,
  }
}

/**
 * Sample adequacy. Drives the headline recommendation, so it is computed rather
 * than eyeballed: the brief's own floor is diversity across zones and sides, not
 * merely a trade count.
 */
export function sampleAdequacy(summaries, { targetMin = 20 } = {}) {
  const zones = zoneReport(summaries)
  const zonesWith = ZONE_ORDER.filter((z) => zones[z].count > 0)
  const buy = summaries.filter((s) => s.direction === 'BUY').length
  const sell = summaries.filter((s) => s.direction === 'SELL').length
  const reasons = []
  if (summaries.length < targetMin) {
    reasons.push(`only ${summaries.length} comparable trade(s); target >= ${targetMin}`)
  }
  if (!buy || !sell) reasons.push('one-sided sample (needs both BUY and SELL)')
  if (zonesWith.length < 3) {
    reasons.push(`covers only ${zonesWith.length} zone(s): ${zonesWith.join(', ') || 'none'}`)
  }
  return {
    tradeCount: summaries.length,
    targetMin,
    zonesCovered: zonesWith,
    buySell: { buy, sell },
    adequate: reasons.length === 0,
    reasons,
  }
}

// ── Counterfactual clipping analysis ─────────────────────────────────────────
//
// WHAT THIS ANSWERS
//
// The question the study exists to settle is whether the shadow protection rule
// would have CLIPPED a winner: the model says "close now", the real system keeps
// the trade open, and the trade subsequently runs much further than the model
// would have allowed.
//
// WHY THIS ONLY WORKS BECAUSE `WOULD_CLOSE` IS A DECISION, NOT A CLOSE
//
// A `WOULD_CLOSE` is recorded with `row_kind='decision'` precisely so that it
// does NOT terminate the lifecycle. That is what makes the trajectory below
// observable at all. If it were written as `row_kind='close'`, this function
// would see a lifecycle ending at the would-close point, and the runner that
// followed would be attributed to a *different*, never-recorded trade — the
// clipping found everywhere it matters would be invisible.
//
// `realLifecycleTerminatedByWouldClose` is asserted false on every would-close
// for that reason, and the tests hold it.

/** How far past the would-close point the trade must run before we call it a clip. */
export const CLIP_MATERIAL_R = 0.5

const numOrNull = (v) => (v == null || !Number.isFinite(Number(v)) ? null : Number(v))
const tsOf = (r) => {
  const t = r?.created_at ? new Date(r.created_at).getTime() : NaN
  return Number.isFinite(t) ? t : 0
}
const orderRows = (rows) => [...(rows || [])].sort((a, b) => tsOf(a) - tsOf(b))

/**
 * Reconstruct ONE trade's lifecycle from its telemetry rows. Pure: no I/O, no
 * clock, no trading logic — everything returned is read off the persisted rows.
 *
 * @param {Array} rows — every telemetry row for a single broker ticket
 */
export function lifecycleOutcome(rows) {
  const ordered = orderRows(rows)
  const ticket  = ordered[0]?.broker_ticket ?? null
  const tradeId = ordered.find((r) => r.trade_id)?.trade_id ?? null

  const actualClose = ordered.filter((r) => r.row_kind === 'close')[0] || null

  // A would-close is a COUNTERFACTUAL decision about a position still open. It
  // is deliberately not a close row, and it never counts as one.
  const wouldCloseEvents = ordered.filter(
    (r) => r.row_kind !== 'close' && String(r.shadow_decision || '') === 'WOULD_CLOSE',
  )
  const firstWouldClose = wouldCloseEvents[0] || null

  const afterWouldClose = firstWouldClose ? ordered.slice(ordered.indexOf(firstWouldClose) + 1) : []
  const trajectory      = firstWouldClose ? [firstWouldClose, ...afterWouldClose] : []

  const maxOf = (sel) => trajectory.reduce((m, r) => {
    const v = numOrNull(sel(r))
    return v == null ? m : Math.max(m, v)
  }, -Infinity)

  const maxR      = maxOf((r) => r.current_r)
  const maxProfit = maxOf((r) => r.current_profit_usd)

  const rAtWouldClose  = firstWouldClose ? numOrNull(firstWouldClose.current_r) : null
  const actualCloseR   = actualClose ? numOrNull(actualClose.current_r) : null
  const actualClosePnl = actualClose ? numOrNull(actualClose.current_profit_usd) : null

  const postWouldCloseMaxR      = Number.isFinite(maxR) ? maxR : null
  const postWouldCloseMaxProfit = Number.isFinite(maxProfit) ? maxProfit : null

  // The finding: the model wanted out, the trade kept working, and it finished
  // positive materially beyond where the model would have exited.
  const ranFurtherR = postWouldCloseMaxR != null && rAtWouldClose != null
    ? Math.round((postWouldCloseMaxR - rAtWouldClose) * 10000) / 10000
    : null
  const clippedRunner = Boolean(
    firstWouldClose && ranFurtherR != null && ranFurtherR >= CLIP_MATERIAL_R && (actualClosePnl ?? 0) > 0,
  )

  return {
    brokerTicket: ticket,
    tradeId,
    // Context the CLI reports per trade. Read off the rows, never inferred.
    pair:         ordered[0]?.pair ?? null,
    direction:    ordered[0]?.direction ?? null,
    plannedRiskUsd: numOrNull(ordered.find((r) => r.planned_risk_usd != null)?.planned_risk_usd),
    rowCount: ordered.length,
    // No close row has arrived, so the real lifecycle is still open. The study
    // compares a WOULD_CLOSE against what the trade ACTUALLY did, so it must
    // keep reading rows until this becomes false.
    lifecycleOpen: !actualClose,
    wouldCloseCount: wouldCloseEvents.length,
    realLifecycleTerminatedByWouldClose: wouldCloseEvents.some((r) => r.row_kind === 'close'),
    firstWouldClose: firstWouldClose
      ? {
          at:                     firstWouldClose.created_at ?? null,
          rAtWouldClose,
          profitAtWouldClose:     numOrNull(firstWouldClose.current_profit_usd),
          targetFloorUsd:         numOrNull(firstWouldClose.target_floor_usd),
          peakRAtWouldClose:      numOrNull(firstWouldClose.peak_r),
          peakProfitAtWouldClose: numOrNull(firstWouldClose.peak_profit_usd),
        }
      : null,
    // Subsequent maximum favourable excursion — the counterfactual's opportunity cost.
    postWouldCloseMaxR,
    postWouldCloseMaxProfit,
    ranFurtherR,
    actualClose: actualClose
      ? { at: actualClose.created_at ?? null, r: actualCloseR, profitUsd: actualClosePnl }
      : null,
    // The AUTHORITATIVE realised P&L lives in trades.pl_usd and is joined by
    // profit-telemetry's closeSummaryFromRows; the close row's figure is the
    // decision-time reading and is flagged as such.
    actualFinalRealisedSource: actualClose ? 'close-row (decision-time; join trades for realised)' : null,
    // Convenience alias so the CLI can report "actual final R" directly.
    actualFinalR: actualCloseR,
    clippedRunner,
  }
}

/** Convenience: rows grouped by broker ticket → per-trade lifecycle outcomes. */
export function lifecycleOutcomesByTicket(rows) {
  const byTicket = new Map()
  for (const r of rows || []) {
    const k = String(r?.broker_ticket ?? '')
    if (!k) continue
    if (!byTicket.has(k)) byTicket.set(k, [])
    byTicket.get(k).push(r)
  }
  const out = {}
  for (const [k, rs] of byTicket) out[k] = lifecycleOutcome(rs)
  return out
}

/** Aggregate the clipping finding across everything observed so far. */
export function clippingReport(rowsByTicket) {
  const outcomes       = Object.values(rowsByTicket || {})
  const withWouldClose = outcomes.filter((o) => o.firstWouldClose)
  const clipped        = withWouldClose.filter((o) => o.clippedRunner)
  const stillOpen      = withWouldClose.filter((o) => o.lifecycleOpen)

  return {
    tradesObserved:       outcomes.length,
    // Completed vs still-running REAL lifecycles. A lifecycle is incomplete
    // whenever no genuine close row has arrived — a WOULD_CLOSE does not end it.
    lifecyclesClosed:     outcomes.filter((o) => o.actualClose).length,
    lifecyclesOpen:       outcomes.filter((o) => o.actualClose == null).length,
    tradesWithWouldClose: withWouldClose.length,
    tradesClipped:        clipped.length,
    clippedTickets:       clipped.map((o) => o.brokerTicket),
    // A would-close on a trade that has NOT actually closed yet cannot be judged
    // either way — the runner may still be coming. Surfaced so the sample is not
    // read as final before those lifecycles end.
    wouldCloseStillOpen:        stillOpen.length,
    wouldCloseStillOpenTickets: stillOpen.map((o) => o.brokerTicket),
    clipRate: withWouldClose.length
      ? Math.round((clipped.length / withWouldClose.length) * 1000) / 1000
      : null,
    label: 'COUNTERFACTUAL — a clip means the shadow rule would have missed the move, not that money was lost',
    perTrade: withWouldClose,
  }
}

/**
 * Assemble the full study report.
 *
 * `shadowCommandEmitted > 0` is surfaced at the top rather than buried, because
 * it is the one condition that makes every other number unusable: if the shadow
 * module ever emitted a broker command, the sample is not a clean shadow sample.
 */
export function buildReport(summaries, meta = {}) {
  const classified = summaries.map(withClassification)
  const sum = (sel) =>
    Math.round(classified.reduce((a, s) => a + (Number(sel(s)) || 0), 0) * 100) / 100
  const shadowLeaks = classified.filter((s) => s.shadowCommandEmitted)
  const comparable = classified.filter((s) => s.classification !== 'INSUFFICIENT DATA')

  return {
    generatedAt: new Date().toISOString(),
    ...meta,
    shadowSafety: {
      shadowCommandEmittedCount: shadowLeaks.length,
      tickets: shadowLeaks.map((s) => s.brokerTicket),
      verdict:
        shadowLeaks.length === 0
          ? 'OK — no shadow command reached a broker'
          : 'CRITICAL — shadow protection affected a live trade; sample is not a clean shadow sample',
    },
    sample: {
      tradeCount: classified.length,
      comparableCount: comparable.length,
      buy: classified.filter((s) => s.direction === 'BUY').length,
      sell: classified.filter((s) => s.direction === 'SELL').length,
      brokersRealised: classified.filter((s) => s.actualRealisedSource === 'broker').length,
      decisionTimeOnly: classified.filter((s) => s.actualRealisedSource !== 'broker').length,
    },
    actual: {
      totalRealisedPnlUsd: sum((s) => s.actualRealisedPnlUsd),
      winners: classified.filter((s) => (s.actualRealisedPnlUsd ?? 0) > 0).length,
      losers: classified.filter((s) => (s.actualRealisedPnlUsd ?? 0) < 0).length,
    },
    estShadow: {
      label: 'COUNTERFACTUAL / ESTIMATED',
      totalPnlUsd: sum((s) => s.estShadowPnlUsd),
      estimatedDeltaUsd: sum((s) => s.deltaUsd),
    },
    classifications: classified.reduce((acc, s) => {
      acc[s.classification] = (acc[s.classification] || 0) + 1
      return acc
    }, {}),
    zones: zoneReport(classified),
    capture: captureEfficiency(classified),
    // Counterfactual clipping. Needs the raw ROWS, not the summaries: the whole
    // point is the trajectory AFTER a would-close, which a per-trade summary has
    // already collapsed away.
    clipping: meta.rows ? clippingReport(lifecycleOutcomesByTicket(meta.rows)) : null,
    adequacy: sampleAdequacy(comparable),
    perTrade: classified,
    caveats: [
      'All estShadow* values are COUNTERFACTUAL / ESTIMATED — never broker-realised.',
      'ACTUAL values are broker-realised where trades.pl_usd/mfe_usd exist; otherwise the close decision-time value, flagged per trade.',
      'A shadow result being better is NOT evidence of money earned; it is a hypothesis the live phase would have to test.',
    ],
  }
}

