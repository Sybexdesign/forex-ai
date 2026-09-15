// lib/strategy-validation.mjs
// SHARED validation/normalisation for strategy settings.
//
// WHY THIS MODULE EXISTS
//
// The manualLots ceiling used to live inline in /api/strategy as a literal `0.50`,
// while the UI and /api/orders used `MAX_LOTS = 10`. Three places, two different
// numbers, and the mismatch silently REJECTED every 1..10 lot save the UI had
// accepted. A validation rule that only exists inside a Next route also cannot be
// tested without importing next/server, supabase and env — which is why the bug
// survived.
//
// So the rule lives here, the real route calls it, and the tests exercise THE SAME
// function. There is no test-only duplicate.

import { MAX_LOTS } from './trade-levels'
import { MANUAL_MAX_RISK_PCT_CEILING } from './manual-sizing.mjs'

/**
 * Validate + normalise the sizing-related fields of an incoming settings object.
 *
 * Mutates and returns a `normalised` copy; never throws.
 *
 * @returns {{ok:true, normalised:object, manualLots:number|null, manualRiskPct:number|null}
 *          | {ok:false, error:string}}
 */
export function normaliseSizingSettings(settings) {
  if (!settings || typeof settings !== 'object') return { ok: true, normalised: settings, manualLots: null, manualRiskPct: null }

  const normalised = { ...settings }
  let manualLots = null
  let manualRiskPct = null

  // ── manualLots: 0/''→null (AUTO); otherwise (0, MAX_LOTS] ──────────────────
  if (settings.manualLots !== undefined && settings.manualLots !== null) {
    if (String(settings.manualLots).trim() !== '') {
      const lots = parseFloat(settings.manualLots)
      if (!isFinite(lots) || lots < 0 || lots > MAX_LOTS) {
        return { ok: false, error: `manualLots must be a number between 0 and ${MAX_LOTS}` }
      }
      manualLots = lots > 0 ? lots : null
    }
    normalised.manualLots = manualLots
  }

  // ── manualRiskPct: manual-mode risk BUDGET, (0, ceiling] ───────────────────
  if (settings.manualRiskPct !== undefined && settings.manualRiskPct !== null) {
    if (String(settings.manualRiskPct).trim() !== '') {
      const pct = parseFloat(settings.manualRiskPct)
      if (!isFinite(pct) || pct <= 0 || pct > MANUAL_MAX_RISK_PCT_CEILING) {
        return { ok: false, error: `manualRiskPct must be a number between 0 and ${MANUAL_MAX_RISK_PCT_CEILING}` }
      }
      manualRiskPct = pct
      normalised.manualRiskPct = pct
    }
  }

  return { ok: true, normalised, manualLots, manualRiskPct }
}
