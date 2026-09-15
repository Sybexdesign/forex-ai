// lib/manual-sizing.mjs
// MANUAL lot-size policy — pure, deterministic, unit-testable.
//
// ── WHY THIS MODULE EXISTS ───────────────────────────────────────────────────
//
// The order path used to apply the AUTOMATIC hard cap to MANUAL requests:
//
//     hardCapUsd = balance × riskPct% × hardCapMultiplier        (an AUTO sizing input)
//     if (lots × pipValuePerLot × slPips > hardCapUsd) lots = hardCapUsd / (…)
//
// With $10,000 balance, 1% risk, ×1.25 multiplier and a 25-pip stop that is $125,
// so a 10-lot request was silently rewritten to 0.50 lots. The cap was doing its
// job as an AUTO *sizing* target, but it was being applied to MANUAL *sizing* —
// two different responsibilities sharing one number.
//
// ── THE SEPARATION ───────────────────────────────────────────────────────────
//
//   AUTO   : riskPct drives the LOT SIZE. Unchanged — this module is not used.
//   MANUAL : the LOT SIZE is the user's input, and the STOP LOSS is derived to
//            fit an explicit manual risk budget. Requested lots are
//            authoritative and are never silently rewritten.
//
//     slPips = permittedRiskUsd / (lots × pipValuePerLot)
//
// A larger position therefore gets a TIGHTER stop for the same budget — the
// correct relationship. It does NOT get a smaller position.
//
// ── WHAT REMAINS UNIVERSAL ───────────────────────────────────────────────────
//
//   * MAX_LOTS ceiling (10) — application maximum, every mode
//   * broker minimum stop distance — below it a stop is not placeable
//   * the strategy's SL cap
//   * finite, positive instrument geometry and price
//   * account-level catastrophic guards (margin, daily loss, max positions)
//
// A request that cannot be satisfied within those is REJECTED with a reason —
// never silently executed at a different size.

import { MAX_LOTS } from './trade-levels'

/**
 * Default manual risk budget. ⚠️ NOT USED AS A FALLBACK ANY MORE.
 *
 * The canonical default lives in `DEFAULT_STRATEGY.manualRiskPct`. This constant is
 * retained only as the documented reference value and as the ceiling's sibling, so
 * there is exactly one place that CHOOSES the number.
 */
export const MANUAL_MAX_RISK_PCT_DEFAULT = 25
/** Absolute ceiling we will accept for a manual risk budget. */
export const MANUAL_MAX_RISK_PCT_CEILING = 50

const round2 = (n) => (Number.isFinite(n) ? Math.round(n * 100) / 100 : null)

/**
 * THE SHARED PREVIEW MODEL — what the Strategy page shows BEFORE execution.
 *
 * The page must NOT reimplement sizing arithmetic in React: that is how a UI and
 * its execution path drift apart. This function wraps `planManualSizing()` and
 * shapes the result for display, so the preview and the order planner are
 * provably the same policy.
 *
 * MISSING DATA IS NEVER FABRICATED. If the account or the instrument geometry is
 * not available yet, the model reports `status: 'AWAITING_DATA'` with the specific
 * reason instead of inventing a plausible-looking calculation.
 *
 * @returns {{
 *   mode: 'AUTO'|'MANUAL',
 *   status: 'EXECUTABLE'|'CANNOT_EXECUTE'|'AWAITING_DATA',
 *   reason: string|null, message: string|null,
 *   requestedLots: number|null, manualRiskPct: number|null, autoRiskPct: number|null,
 *   balance: number|null, pipValuePerLot: number|null,
 *   riskBudgetUsd: number|null, rawSlPips: number|null, finalSlPips: number|null,
 *   actualRiskUsd: number|null, actualRiskPct: number|null,
 *   tpPips: number|null, rr: number|null,
 *   slCapped: boolean, slCappedFrom: number|null, slBelowBrokerMin: boolean,
 *   brokerMinStopPips: number|null, maxLots: number, lotsAreAuthoritative: boolean,
 *   manualExceedsAutoRisk: boolean,
 * }}
 */
export function buildManualSizingPreview({
  manualLots, balance, manualRiskPct, autoRiskPct = null,
  pipValuePerLot = null, minStopPips = null, maxSlPips = null,
  strategySlPips = null, strategyTpPips = null,
} = {}) {
  const lots = Number(manualLots)
  const isManual = Number.isFinite(lots) && lots > 0

  const rr = (Number.isFinite(Number(strategySlPips)) && Number(strategySlPips) > 0
           && Number.isFinite(Number(strategyTpPips)) && Number(strategyTpPips) > 0)
    ? Number(strategyTpPips) / Number(strategySlPips)
    : null

  const shell = {
    mode: isManual ? 'MANUAL' : 'AUTO',
    reason: null, message: null,
    requestedLots: isManual ? lots : null,
    manualRiskPct: Number.isFinite(Number(manualRiskPct)) ? Number(manualRiskPct) : null,
    autoRiskPct: Number.isFinite(Number(autoRiskPct)) ? Number(autoRiskPct) : null,
    balance: Number.isFinite(Number(balance)) && Number(balance) > 0 ? Number(balance) : null,
    pipValuePerLot: Number.isFinite(Number(pipValuePerLot)) && Number(pipValuePerLot) > 0 ? Number(pipValuePerLot) : null,
    riskBudgetUsd: null, rawSlPips: null, finalSlPips: null,
    actualRiskUsd: null, actualRiskPct: null,
    tpPips: null, rr: rr == null ? null : Math.round(rr * 1000) / 1000,
    slCapped: false, slCappedFrom: null, slBelowBrokerMin: false,
    brokerMinStopPips: Number.isFinite(Number(minStopPips)) ? Number(minStopPips) : null,
    maxLots: MAX_LOTS,
    lotsAreAuthoritative: isManual,
    manualExceedsAutoRisk: false,
  }

  // AUTO: nothing manual is calculated. The automatic system owns lot size, SL, TP
  // and risk, and `manualRiskPct` is deliberately not consulted.
  //
  // It is also reported as null rather than echoed: a populated `manualRiskPct` on
  // an AUTO result is inert today but invites a consumer to display or act on it,
  // which is how an AUTO sizing input drifts back into manual territory. AUTO
  // exposes no manual risk budget because there is none in play.
  if (!isManual) return { ...shell, status: 'EXECUTABLE', manualRiskPct: null }


  // MANUAL with data missing → say so, do not invent a number.
  if (shell.balance == null) {
    return { ...shell, status: 'AWAITING_DATA', reason: 'awaiting-account-data', message: 'Awaiting account data' }
  }
  if (shell.pipValuePerLot == null) {
    return { ...shell, status: 'AWAITING_DATA', reason: 'awaiting-instrument-geometry', message: 'Awaiting instrument geometry' }
  }

  const plan = planManualSizing({
    manualLots: lots, balance: shell.balance, manualRiskPct, pipValuePerLot: shell.pipValuePerLot,
    minStopPips, maxSlPips, rr,
  })

  if (!plan.ok) {
    return {
      ...shell,
      status: 'CANNOT_EXECUTE',
      reason: plan.reason,
      message: plan.message,
      // Show the numbers that explain the refusal — the user must see WHY.
      slBelowBrokerMin: plan.reason === MANUAL_REJECT.SL_BELOW_BROKER_MIN,
      riskBudgetUsd: shell.manualRiskPct == null ? null : round2(shell.balance * shell.manualRiskPct / 100),
      rawSlPips: shell.manualRiskPct == null ? null : round2((shell.balance * shell.manualRiskPct / 100) / (lots * shell.pipValuePerLot)),
    }
  }

  return {
    ...shell,
    status: 'EXECUTABLE',
    reason: null, message: null,
    requestedLots: plan.lots,                 // authoritative, echoed back unchanged
    manualRiskPct: plan.riskPct,
    riskBudgetUsd: plan.permittedRiskUsd,     // the BUDGET
    rawSlPips: plan.rawSlPips,
    finalSlPips: plan.slPips,
    actualRiskUsd: plan.riskUsd,              // the ACTUAL risk — often < budget
    actualRiskPct: plan.accountRiskPct,
    tpPips: plan.tpPips,
    slCapped: plan.slClampedToCap,
    slCappedFrom: plan.slClampedToCap ? plan.rawSlPips : null,
    manualExceedsAutoRisk: shell.autoRiskPct != null && plan.riskPct > shell.autoRiskPct,
  }
}


export const MANUAL_REJECT = {
  LOTS_INVALID:        'manual-lots-invalid',
  LOTS_ABOVE_MAX:      'manual-lots-above-max',
  GEOMETRY_INVALID:    'manual-geometry-invalid',
  BALANCE_INVALID:     'manual-balance-invalid',
  RISK_BUDGET_ZERO:    'manual-risk-budget-zero',
  RISK_PCT_MISSING:    'manual-risk-pct-missing',
  SL_BELOW_BROKER_MIN: 'manual-sl-below-broker-min',
}

/**
 * Resolve the manual risk budget from the strategy layer.
 *
 * The canonical value is `DEFAULT_STRATEGY.manualRiskPct`. This function CLAMPS to
 * the ceiling and rejects nonsense, but it no longer *supplies* a default — so a
 * caller that forgets to pass the setting gets an explicit rejection rather than a
 * silently different number than the UI shows. ONE place chooses the default.
 */
export function resolveManualRiskPct(raw) {
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0) return null          // caller must supply it
  return Math.min(n, MANUAL_MAX_RISK_PCT_CEILING)
}

/**
 * Plan a MANUAL position.
 *
 * @param {object} o
 * @param {number} o.manualLots       — the user's requested size (authoritative)
 * @param {number} o.balance          — account balance in account currency
 * @param {number} [o.manualRiskPct]  — manual risk budget, % of balance
 * @param {number} o.pipValuePerLot   — authoritative geometry
 * @param {number} o.minStopPips      — broker minimum stop distance
 * @param {number} o.maxSlPips        — strategy SL cap
 * @param {number} [o.rr]             — strategy reward:risk, for TP derivation
 * @returns {{ok:true, lots, riskPct, permittedRiskUsd, slPips, tpPips, riskUsd, accountRiskPct, reason:null}
 *          | {ok:false, reason:string, message:string}}
 */
export function planManualSizing({
  manualLots, balance, manualRiskPct, pipValuePerLot, minStopPips, maxSlPips, rr = null,
}) {
  const lots = Number(manualLots)
  if (!Number.isFinite(lots) || lots <= 0) {
    return { ok: false, reason: MANUAL_REJECT.LOTS_INVALID, message: 'Manual lot size must be a positive number' }
  }
  if (lots > MAX_LOTS) {
    return { ok: false, reason: MANUAL_REJECT.LOTS_ABOVE_MAX, message: `Manual lot size ${lots} exceeds the ${MAX_LOTS}-lot maximum` }
  }
  const pvpl = Number(pipValuePerLot)
  if (!Number.isFinite(pvpl) || pvpl <= 0) {
    return { ok: false, reason: MANUAL_REJECT.GEOMETRY_INVALID, message: 'Instrument pip value is unavailable or invalid — refusing to guess' }
  }
  const bal = Number(balance)
  if (!Number.isFinite(bal) || bal <= 0) {
    return { ok: false, reason: MANUAL_REJECT.BALANCE_INVALID, message: 'Account balance is unavailable — cannot size a manual risk budget' }
  }

  const riskPct          = resolveManualRiskPct(manualRiskPct)
  if (riskPct == null) {
    // The strategy layer is the single source of the default. If it did not supply
    // one we refuse rather than inventing a number the UI would not be showing.
    return { ok: false, reason: MANUAL_REJECT.RISK_PCT_MISSING, message: 'Manual risk budget is not configured — set Manual Risk % in Strategy settings' }
  }
  const permittedRiskUsd = bal * (riskPct / 100)
  if (!(permittedRiskUsd > 0)) {
    return { ok: false, reason: MANUAL_REJECT.RISK_BUDGET_ZERO, message: 'Manual risk budget resolves to zero' }
  }

  // Stop distance follows from the budget. A bigger position gets a TIGHTER stop
  // for the same money at risk — the position size is NOT reduced.
  const rawSlPips = permittedRiskUsd / (lots * pvpl)
  if (!Number.isFinite(rawSlPips) || rawSlPips <= 0) {
    return { ok: false, reason: MANUAL_REJECT.GEOMETRY_INVALID, message: 'Calculated stop distance is not a finite positive number' }
  }

  const minStop = Number(minStopPips)
  // TOO TIGHT: the broker will not accept a stop this close. We must NOT silently
  // shrink the position to make the stop valid — that is precisely the old
  // behaviour this policy replaces.
  if (Number.isFinite(minStop) && minStop > 0 && rawSlPips < minStop) {
    return {
      ok: false,
      reason: MANUAL_REJECT.SL_BELOW_BROKER_MIN,
      message: `At ${lots} lots the manual risk budget allows only ${round2(rawSlPips)} pips, below the broker minimum of ${minStop} pips. Raise the manual risk budget or reduce lot size.`,
    }
  }

  // TOO WIDE: the stop would exceed the strategy cap. Clamping DOWN is safe — it
  // risks LESS than the budget, so it can never exceed the manual allowance.
  const maxSl  = Number(maxSlPips)
  const slPips = (Number.isFinite(maxSl) && maxSl > 0 && rawSlPips > maxSl) ? maxSl : rawSlPips

  const riskUsd        = lots * pvpl * slPips
  const accountRiskPct = (riskUsd / bal) * 100

  return {
    ok: true,
    reason: null,
    lots,                                   // AUTHORITATIVE — never rewritten
    riskPct,
    permittedRiskUsd: round2(permittedRiskUsd),
    slPips: round2(slPips),
    rawSlPips: round2(rawSlPips),
    slClampedToCap: slPips !== rawSlPips,
    tpPips: (Number.isFinite(rr) && rr > 0) ? Math.round(slPips * rr) : null,
    riskUsd: round2(riskUsd),
    accountRiskPct: round2(accountRiskPct),
  }
}
