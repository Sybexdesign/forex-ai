// lib/protection-candidates.mjs
// Candidate composition for live trade protection.
//
// THE ARCHITECTURAL INVARIANT THIS ENCODES
//
//   ATR is a COMPLEMENTARY protection candidate, not a PREREQUISITE.
//
// Today the ATR branch in trade-manager.ts is skipped outright when `atr <= 0`
// (`if (atr > 0 && midPx > 0 && pos.profit > TRAIL_MIN_PROFIT_USD)`). Because the
// trailing stop is frequently the tightest rule, losing ATR silently drops the
// trade back to the much weaker static +0.5R partial lock — the mechanism
// hypothesised (NOT proven) for the observed ~2.65R peak closing near +0.5R.
//
// This module makes that impossible by construction:
//   * ATR availability is an EXPLICIT, reported state — never a silent skip.
//   * Every candidate is composed and the most protective VALID one wins.
//   * The R/MFE candidate comes from the EXISTING `profitProtection()`. There is
//     deliberately no second MFE algorithm here.
//   * A missing ATR therefore cannot remove the R/MFE candidate.
//
// NOTHING HERE TOUCHES A BROKER. It returns candidates and a selection; the
// caller decides whether to act (and in shadow mode it must not).

import { profitProtection, pickMostProtectiveSl } from './profit-protection.mjs'

/** Explicit ATR availability states. A missing ATR must name itself. */
export const ATR_REASON = {
  AVAILABLE:            'atr-available',
  NO_CANDLE_CACHE:      'atr-unavailable-no-candle-cache',
  INSUFFICIENT_CANDLES: 'atr-unavailable-insufficient-candles',
  NO_DATA:              'atr-unavailable-no-data',
  ZERO:                 'atr-unavailable-zero',
  INVALID:              'atr-unavailable-invalid',
  INVALID_PRICE:        'atr-unavailable-invalid-market-price',
  BELOW_MIN_PROGRESS:   'atr-below-min-progress',
}

/**
 * Decide whether an ATR trailing candidate can be formed, and SAY WHY NOT.
 *
 * Never fabricates an ATR and never substitutes a default. `available` describes
 * the DATA; `eligible` describes whether the trade has progressed far enough for
 * trailing to be meaningful. Keeping them apart lets a diagnostic answer both
 * "was ATR evaluated?" and "if not, why not?".
 */
export function classifyAtr({ atr, candles = null, requiredCandles = 14, midPx = 0, profitR = 0, minProfitR = null } = {}) {
  if (!(Number.isFinite(Number(midPx)) && Number(midPx) > 0)) {
    return { available: false, eligible: false, reason: ATR_REASON.INVALID_PRICE, value: null }
  }
  if (candles === null && atr == null) {
    return { available: false, eligible: false, reason: ATR_REASON.NO_CANDLE_CACHE, value: null }
  }
  if (candles != null && Number(candles) < Number(requiredCandles)) {
    return { available: false, eligible: false, reason: ATR_REASON.INSUFFICIENT_CANDLES, value: null, candles: Number(candles) }
  }
  if (atr == null) return { available: false, eligible: false, reason: ATR_REASON.NO_DATA, value: null }
  const a = Number(atr)
  if (!Number.isFinite(a)) return { available: false, eligible: false, reason: ATR_REASON.INVALID, value: null }
  if (a <= 0) return { available: false, eligible: false, reason: ATR_REASON.ZERO, value: null }
  if (minProfitR != null && Number(profitR) < Number(minProfitR)) {
    return { available: true, eligible: false, reason: ATR_REASON.BELOW_MIN_PROGRESS, value: a }
  }
  return { available: true, eligible: true, reason: ATR_REASON.AVAILABLE, value: a }
}

/** The ATR trailing candidate, as an SL price AND an R level for comparison. */
export function atrTrailCandidate({ dir, entry, midPx, atr, mult, pip, pipValuePerLot, lots, plannedRiskUsd }) {
  const side = dir === 'BUY' ? 1 : -1
  const sl = midPx - side * Number(atr) * Number(mult)
  const usd = ((side * (sl - Number(entry))) / Number(pip)) * Number(pipValuePerLot) * Number(lots)
  const r = Number(plannedRiskUsd) > 0 ? usd / Number(plannedRiskUsd) : null
  return { rule: 'ATR', sl, r, valid: Number.isFinite(sl) }
}

/** Break-even candidate: SL at entry (protects 0R). */
export function breakEvenCandidate({ entry }) {
  return { rule: 'BE', sl: Number(entry), r: 0, valid: Number.isFinite(Number(entry)) }
}

/** Static partial-lock candidate: SL at entry + lockR × 1R. */
export function partialLockCandidate({ dir, entry, riskPrice, lockR }) {
  const side = dir === 'BUY' ? 1 : -1
  return { rule: 'PARTIAL_LOCK', sl: Number(entry) + side * Number(riskPrice) * Number(lockR), r: Number(lockR), valid: true }
}

/**
 * Compose every protection candidate and select the most protective VALID one.
 *
 * FAIL-CLOSED CONTRACT
 *   * invalid planned risk  → no MFE candidate, reason
 *     `profit-protection-risk-unavailable`. No fabricated R.
 *   * invalid geometry      → no MFE candidate, reason
 *     `profit-protection-geometry-unavailable`. No guessed price conversion.
 *   * in both cases ATR may still participate IF its own inputs are trustworthy,
 *     and the existing SL always remains part of the comparison.
 *
 * The R/MFE candidate comes from the EXISTING `profitProtection()`. This module
 * adds no second MFE algorithm.
 */
export function composeProtection(o = {}) {
  const {
    dir = 'BUY', entry, currentSl, lots, pip, pipValuePerLot,
    plannedRiskUsd, currentProfit = 0, peakProfit = 0,
    stage = '', retentionFloorUsd = 0,
    riskPrice = null, lockR = 0.5,
    atr = null, atrCandles = null, midPx = 0, atrMult = 1.0,
    atrRequiredCandles = 14, trailMinProfitR = null, mode = 'shadow',
  } = o

  const side = dir === 'BUY' ? 1 : -1
  const risk = Number(plannedRiskUsd)
  const riskValid = Number.isFinite(risk) && risk > 0
  const geometryValid = Number.isFinite(Number(pip)) && Number(pip) > 0
    && Number.isFinite(Number(pipValuePerLot)) && Number(pipValuePerLot) > 0
    && Number.isFinite(Number(lots)) && Number(lots) > 0
  const currentR = riskValid ? Number(currentProfit) / risk : null
  const peakR    = riskValid ? Number(peakProfit) / risk : null

  const diagnostics = {
    dir, entry, currentProfit, peakProfit, plannedRiskUsd: riskValid ? risk : null,
    currentR, peakR, currentSl, stage, retentionFloorUsd,
    atrAvailable: false, atrReason: null, atrValue: null,
    atrCandles: Number.isFinite(Number(atrCandles)) ? Number(atrCandles) : null,
    atrCandidateR: null, mfeCandidateR: null, beCandidateR: null, partialCandidateR: null,
    existingR: null, selectedRule: 'NONE', finalSl: currentSl ?? null,
    wouldModify: false, reason: null, mode,
  }

  // ATR availability is classified on EVERY cycle, even when it will not be used.
  const atrState = classifyAtr({
    atr, candles: atrCandles, requiredCandles: atrRequiredCandles,
    midPx, profitR: currentR ?? 0, minProfitR: trailMinProfitR,
  })
  diagnostics.atrAvailable = atrState.available
  diagnostics.atrReason    = atrState.reason
  diagnostics.atrValue     = atrState.value

  const rOf = (sl) => ((side * (Number(sl) - Number(entry))) / Number(pip)) * Number(pipValuePerLot) * Number(lots) / risk

  // The existing live SL is ALWAYS part of the comparison.
  const existingR = (geometryValid && riskValid && Number.isFinite(Number(currentSl))) ? rOf(currentSl) : null
  diagnostics.existingR = existingR

  const candidates = []
  if (atrState.available && atrState.eligible && geometryValid && riskValid) {
    const c = atrTrailCandidate({ dir, entry, midPx, atr: atrState.value, mult: atrMult, pip, pipValuePerLot, lots, plannedRiskUsd: risk })
    if (c.valid) { candidates.push(c); diagnostics.atrCandidateR = c.r }
  }
  if (geometryValid) {
    const be = breakEvenCandidate({ entry })
    candidates.push(be)
    diagnostics.beCandidateR = be.r
    if (riskPrice != null) {
      const pl = partialLockCandidate({ dir, entry, riskPrice, lockR })
      candidates.push(pl)
      diagnostics.partialCandidateR = pl.r
    }
  }

  // ── R/MFE candidate — the EXISTING engine ────────────────────────────────
  if (!riskValid) {
    diagnostics.reason = 'profit-protection-risk-unavailable'
    diagnostics.mfeReason = 'profit-protection-risk-unavailable'
  } else if (!geometryValid) {
    diagnostics.reason = 'profit-protection-geometry-unavailable'
    diagnostics.mfeReason = 'profit-protection-geometry-unavailable'
  } else {
    const pp = profitProtection({
      dir, entry, currentSl, currentProfit, peakProfit,
      riskUsd: risk, lots, pipValuePerLot, pip, stage, retentionFloorUsd,
    })
    if (pp.newSl !== null) {
      candidates.push({ rule: 'MFE', sl: pp.newSl, r: rOf(pp.newSl), valid: true, ppReason: pp.reason })
      diagnostics.mfeCandidateR = rOf(pp.newSl)
      diagnostics.ppReason = pp.reason
      // Surface the Runner C distinction explicitly.
      diagnostics.proposedFloorUsd = pp.proposedFloorUsd
      diagnostics.committedFloorUsd = pp.floorUsd
    } else {
      diagnostics.mfeCandidateR = null
      diagnostics.mfeReason = pp.reason ?? 'no-candidate'
    }
  }

  // ── Selection: most protective VALID candidate, never below the live SL ──
  // pickMostProtectiveSl takes `current` as a floor/ceiling, so the existing
  // valid SL is structurally part of the comparison and cannot be loosened.
  const valid = candidates.filter((c) => c.valid && Number.isFinite(Number(c.sl)))
  const best = pickMostProtectiveSl(dir, currentSl, valid.map((c) => c.sl))
  diagnostics.finalSl = best ?? null

  const liveN = Number(currentSl)
  const improved = best != null && (!Number.isFinite(liveN) || Number(best) !== liveN)
  const winner = valid.find((c) => Math.abs(Number(c.sl) - Number(best)) < 1e-12) || null

  if (improved && winner) {
    diagnostics.selected = winner
    diagnostics.selectedRule = winner.rule
    diagnostics.wouldModify = true
  } else if (Number.isFinite(existingR)) {
    diagnostics.selectedRule = 'EXISTING_SL'
  } else if (winner) {
    diagnostics.selected = winner
    diagnostics.selectedRule = winner.rule
    diagnostics.wouldModify = true
  }

  return {
    selected: diagnostics.selected ?? null,
    selectedRule: diagnostics.selectedRule,
    finalSl: diagnostics.finalSl,
    wouldModify: diagnostics.wouldModify,
    diagnostics,
  }
}

