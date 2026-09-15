// lib/order-planner.mjs
// ── THE ORDER PLANNER (production) ──────────────────────────────────────────
//
// The decision logic that turns (strategy + account + instrument) into the exact
// numbers the broker will receive: lots, stop distance, target distance.
//
// ── WHY IT IS A SEPARATE MODULE ─────────────────────────────────────────────
//
// It used to live inline inside /api/orders, where it could only be verified by
// reading the source. The acceptance-critical claims of Manual sizing — "a 10-lot
// request reaches the broker as 10 lots", "10 never becomes 0.50" — were therefore
// asserted by regex against the route text rather than by execution.
//
// The logic is unchanged. It is only lifted behind the smallest useful boundary so
// the SAME code the route runs can be executed in a test with a mocked broker.
// The route still calls this module; there is no test-only reimplementation.
//
// ── DEPENDENCY INJECTION ────────────────────────────────────────────────────
//
// `calcPositionSize` is the broker's AUTO sizing function, injected rather than
// imported, so the test mocks the only thing it needs to (the broker) while every
// other step — strategy normalisation, the Manual policy, the ceiling — runs the
// real production code path.
//
// ── WHAT IT DOES NOT DO ─────────────────────────────────────────────────────
//
// It does not skip or weaken anything universal. Account/daily-loss/news/session
// guards, MAX_LOTS, geometry and stale-price checks, the broker minimum stop and
// the strategy SL cap are all still enforced — the first ones upstream in the
// route, the last two right here.

import { MAX_LOTS, MIRROR_SL_CAP, minStopPips } from './trade-levels'
import { planManualSizing, MANUAL_REJECT } from './manual-sizing.mjs'
import { getPipValuePerLot } from './brokers/interface'

export { MANUAL_REJECT }

/** Planner-specific rejections, alongside the Manual policy's own reasons. */
export const PLAN_REJECT = {
  /** Auto-sizing (or a manual request) resolved to nothing placeable. */
  LOTS_NOT_POSITIVE: 'LOTS_NOT_POSITIVE',
  /** Broader than the application ceiling — rejected, never clamped. */
  LOTS_ABOVE_MAX: 'LOTS_ABOVE_MAX',
  /** Instrument pip value unavailable — refusing to guess. */
  GEOMETRY_INVALID: MANUAL_REJECT.GEOMETRY_INVALID,
}


/**
 * Plan a position: decide the lot size and the SL/TP distances that will be sent.
 *
 * MANUAL (`strategy.manualLots > 0`): the requested lots are AUTHORITATIVE. The
 * stop is derived from the manual risk budget. The lots are never rewritten.
 *
 * AUTO (otherwise): `calcPositionSize(balance, riskPct, safeSlPips, pair)` is
 * authoritative, exactly as before. `manualRiskPct` is not consulted at all.
 *
 * @param {object} o
 * @param {object} o.strategy            normalised StrategySettings
 * @param {string} o.pair
 * @param {number} o.balance
 * @param {(balance:number, riskPct:number, slPips:number, pair:string) => number} o.calcPositionSize
 *        the broker's AUTO sizing function (injected)
 * @param {number|null} [o.defaultManualRiskPct] canonical default (DEFAULT_STRATEGY)
 * @param {number|null} [o.pipValuePerLot]  geometry override (tests); else resolved from pair
 * @param {number|null} [o.minStop]         broker min-stop override (tests)
 * @param {number|null} [o.slCap]           strategy SL cap override (tests)
 * @returns {object} a successful plan, or {ok:false, reason, message, stage, requestedLots}
 */
export function planOrder({
  strategy, pair, balance, calcPositionSize,
  defaultManualRiskPct = null,
  pipValuePerLot: pipValueOverride = null,
  minStop: minStopOverride = null,
  slCap: slCapOverride = null,
}) {
  const pipValuePerLot = pipValueOverride ?? getPipValuePerLot(pair)
  const minStop  = minStopOverride ?? minStopPips(pair)
  const slCap    = slCapOverride   ?? MIRROR_SL_CAP

  const requestedLots = (typeof strategy?.manualLots === 'number' && strategy.manualLots > 0)
    ? strategy.manualLots
    : null

  // ── Broker min-stop floor (hoisted above sizing) ───────────────────────────
  // Sized against the stop distance that will actually be PLACED. Sizing against
  // the pre-widening strategy.slPips over-sized positions by up to ~2x.
  let safeSlPips = strategy.slPips
  let safeTpPips = strategy.tpPips
  let slWidenedToMinStop = false
  if (safeSlPips < minStop) { safeSlPips = Math.round(minStop * 1.1); slWidenedToMinStop = true }
  if (safeTpPips < minStop) { safeTpPips = Math.round(minStop * 1.1) }

  // ── Lot size: MANUAL request is authoritative; AUTO is broker-computed ─────
  let lots
  let lotSource
  let manualRisk = null
  let rawSlPips = null
  let slClampedToCap = false

  if (requestedLots != null) {
    lots = requestedLots
    lotSource = 'manual'
  } else {
    lots = calcPositionSize(balance, strategy.riskPct, safeSlPips, pair)
    lotSource = 'auto'
  }

  if (!lots || lots <= 0) {
    return {
      ok: false, reason: PLAN_REJECT.LOTS_NOT_POSITIVE, stage: 'sizing', requestedLots,
      message: 'Position size calculated as 0 — check balance, risk % and SL pips in Strategy settings',
    }
  }

  // ── MANUAL: derive the STOP from the risk budget. Never resize the position ─
  if (lotSource === 'manual') {
    const rr = (strategy.slPips > 0 && strategy.tpPips > 0) ? (strategy.tpPips / strategy.slPips) : null
    const manualPlan = planManualSizing({
      manualLots: lots,
      balance,
      // The policy deliberately carries no default: the strategy layer is the one
      // place that CHOOSES the number.
      manualRiskPct: strategy.manualRiskPct ?? defaultManualRiskPct,
      pipValuePerLot,
      minStopPips: minStop,
      maxSlPips: slCap,
      rr,
    })
    if (!manualPlan.ok) {
      // Explicit rejection. We do NOT quietly trade a different size to fit.
      return {
        ok: false, reason: manualPlan.reason, message: manualPlan.message,
        stage: 'manual-sizing', requestedLots: lots,
      }
    }
    safeSlPips     = Math.round(manualPlan.slPips)
    if (manualPlan.tpPips != null) safeTpPips = manualPlan.tpPips
    rawSlPips      = manualPlan.rawSlPips
    slClampedToCap = manualPlan.slClampedToCap
    manualRisk = {
      riskPct: manualPlan.riskPct,
      permittedRiskUsd: manualPlan.permittedRiskUsd,
      riskUsd: manualPlan.riskUsd,
      accountRiskPct: manualPlan.accountRiskPct,
      slClampedToCap: manualPlan.slClampedToCap,
    }
  }

  // ── Application ceiling (all sources) — REJECT, never clamp ───────────────
  if (lots > MAX_LOTS) {
    return {
      ok: false, reason: PLAN_REJECT.LOTS_ABOVE_MAX, stage: 'ceiling', requestedLots,
      message: `Position size ${lots} lots exceeds the ${MAX_LOTS}-lot ceiling — rejected. Reduce risk % or balance exposure.`,
    }
  }

  return {
    ok: true,
    lots,                                   // AUTHORITATIVE — echoed, never rewritten
    lotSource,
    slPips: safeSlPips,
    tpPips: safeTpPips,
    requestedLots,
    rawSlPips,
    slClampedToCap,
    slWidenedToMinStop,
    pipValuePerLot,
    minStopPips: minStop,
    slCapPips: slCap,
    manualRisk,
  }
}

/**
 * Assemble the exact request handed to the broker adapter.
 *
 * This is the BOUNDARY: everything before it is policy, this is the last
 * transformation before execution. Splitting it out is what lets a test assert on
 * the precise object a broker would receive — `lots` included — without a network
 * call. The adapter converts pip distances to prices using its own pip table, so
 * no price arithmetic is duplicated here.
 */
export function buildBrokerRequest({ pair, direction, plan, currentPrice }) {
  if (!plan?.ok) throw new Error('buildBrokerRequest requires a successful plan')
  return {
    pair,
    direction,
    lots: plan.lots,                        // the authoritative size
    takeProfitPips: plan.tpPips,
    stopLossPips: plan.slPips,
    currentPrice,
  }
}

