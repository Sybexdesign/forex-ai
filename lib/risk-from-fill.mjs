// lib/risk-from-fill.mjs
// ─────────────────────────────────────────────────────────────────────────────
// SybexForexAI — ACTUAL-FILL RISK & REALISED R (Phase 4.1E)
//
// Pure. No DB, no broker.
//
// PRODUCTION DEFECT THIS REPLACES (confirmed, 2026-11-12)
// ------------------------------------------------------
// Both XAU/USD SELLs carried the IDENTICAL stored `planned_risk_amount` of
// $1,748.50 even though the broker filled them at different stop distances:
//
//   ticket 3454451953  entry 3988.692  SL 3992.28   → distance 3.588 → $1,794.00
//   ticket 3454458505  entry 3987.047  SL 3990.81   → distance 3.763 → $1,881.50
//
// Cause (source inspection, app/api/orders/route.ts): planned_risk_amount is
// computed from the REQUESTED slPips before placement, while
// lib/brokers/mt5direct.adapter.ts re-anchors SL/TP to the live quote at fill
// time. The realised stop distance is therefore not the requested one, and
// `realised_r` (which divides by planned_risk_amount) is normalised against the
// wrong denominator:
//
//   stored   realised_r = 3368.50 / 1748.50 = +1.9265
//   correct  realised_r = 3368.50 / 1881.50 = +1.790
//
// RULE: risk is derived from the ACTUAL filled entry, the ACTUAL initial stop and
// the ACTUAL executed volume, using the instrument's own contract specification.
// A requested-risk estimate is never used as the final denominator. When the
// spec or any input is missing the answer is an explicit INCOMPLETE, never a
// guessed number.
//
// Moving a stop later (e.g. to breakeven) must never rewrite the initial risk, so
// `initialSlPrice` is captured once at fill time and kept in its own column.
// ─────────────────────────────────────────────────────────────────────────────

export const RISK_CALC_VERSION = 'risk_from_fill_v1'

/**
 * Instrument contract specifications.
 *
 * `pipSize`     — price increment treated as 1 pip by the app (lib/brokers/interface.ts)
 * `valuePerPip` — account-currency value of 1 pip per 1.00 lot
 * `currency`    — quote currency of the valuePerPip figure (USD here)
 *
 * NOTE: `valuePerPip` is the app's existing convention, reused verbatim so the
 * repair does not silently change position sizing. It is NOT recomputed from
 * contract size — changing it would alter risk controls, which is out of scope.
 */
export const INSTRUMENT_SPECS = {
  'XAU/USD': { pipSize: 0.1, valuePerPip: 10, currency: 'USD', source: 'lib/brokers/interface.getPipValuePerLot' },
  'XAG/USD': { pipSize: 0.01, valuePerPip: 50, currency: 'USD', source: 'lib/brokers/interface.getPipValuePerLot' },
  'BCO/USD': { pipSize: 0.01, valuePerPip: 10, currency: 'USD', source: 'lib/brokers/interface.getPipValuePerLot' },
  'BTC/USD': { pipSize: 1, valuePerPip: 1, currency: 'USD', source: 'lib/brokers/interface.getPipValuePerLot' },
  'ETH/USD': { pipSize: 1, valuePerPip: 1, currency: 'USD', source: 'lib/brokers/interface.getPipValuePerLot' },
}

const INDEX_PAIRS = ['SPX500', 'NAS100', 'UK100', 'GER40', 'JP225', 'US30']

/** Derive a default spec for pairs not explicitly tabulated (mirrors interface.ts). */
export function resolveSpec(pair) {
  if (!pair) return null
  const p = String(pair).toUpperCase()
  if (INSTRUMENT_SPECS[p]) return INSTRUMENT_SPECS[p]
  if (INDEX_PAIRS.includes(p)) return { pipSize: 1, valuePerPip: 1, currency: 'USD', source: 'index_default' }
  if (p.includes('JPY')) return { pipSize: 0.01, valuePerPip: 6.8, currency: 'USD', source: 'jpy_default' }
  return { pipSize: 0.0001, valuePerPip: 10, currency: 'USD', source: 'fx_default' }
}

const toNum = (v) => {
  if (v === undefined || v === null || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

/**
 * Monetary risk represented by the ACTUAL filled order.
 *
 * risk = (|filledEntry − initialSl| / pipSize) × valuePerPip × volume
 *
 * @returns {{ riskAmount: number|null, status: 'OK'|'INCOMPLETE',
 *             reason: string|null, distance: number|null, pips: number|null,
 *             spec: object|null, version: string }}
 */
export function riskFromFill({ pair, filledEntry, initialSl, volume, spec } = {}) {
  const s = spec ?? resolveSpec(pair)
  const entry = toNum(filledEntry)
  const sl = toNum(initialSl)
  const vol = toNum(volume)

  const base = { riskAmount: null, distance: null, pips: null, spec: s ?? null, version: RISK_CALC_VERSION }

  if (!s) return { ...base, status: 'INCOMPLETE', reason: 'MISSING_INSTRUMENT_SPEC' }
  if (entry === null) return { ...base, status: 'INCOMPLETE', reason: 'MISSING_FILLED_ENTRY' }
  if (sl === null) return { ...base, status: 'INCOMPLETE', reason: 'MISSING_INITIAL_STOP' }
  if (vol === null || vol <= 0) return { ...base, status: 'INCOMPLETE', reason: 'MISSING_OR_INVALID_VOLUME' }
  if (!(s.pipSize > 0) || !(s.valuePerPip > 0)) {
    return { ...base, status: 'INCOMPLETE', reason: 'INVALID_INSTRUMENT_SPEC' }
  }

  const distance = Math.round(Math.abs(entry - sl) * 1e6) / 1e6
  if (!(distance > 0)) return { ...base, status: 'INCOMPLETE', reason: 'ZERO_STOP_DISTANCE' }

  const pips = Math.round((distance / s.pipSize) * 1e4) / 1e4
  const riskAmount = Math.round(pips * s.valuePerPip * vol * 100) / 100
  if (!(riskAmount > 0)) return { ...base, status: 'INCOMPLETE', reason: 'NON_POSITIVE_RISK' }

  return { ...base, riskAmount, distance, pips, status: 'OK', reason: null }
}

/**
 * Realised R using the correct denominator.
 *
 *   realised_r = net_realised_pnl / initial_actual_risk
 *
 * NULL whenever either side is unreliable. Never substitutes a requested-risk
 * estimate for a missing actual risk.
 */
export function realisedRFromFill({ netPnl, initialRisk } = {}) {
  const pnl = toNum(netPnl)
  const risk = toNum(initialRisk)
  if (pnl === null || risk === null || !(risk > 0)) return null
  return Math.round((pnl / risk) * 10000) / 10000
}

/**
 * Aggregate realised R across multiple closing deals for one position.
 * R is a position-level property: sum the deals' net P&L, divide once by the
 * single initial risk. Averaging per-deal R values would double-count risk.
 */
export function aggregateRealisedR({ dealNetPnls = [], initialRisk } = {}) {
  const risk = toNum(initialRisk)
  if (risk === null || !(risk > 0)) return null
  const vals = dealNetPnls.map(toNum)
  if (vals.length === 0 || vals.some((v) => v === null)) return null
  const total = vals.reduce((a, b) => a + b, 0)
  return Math.round((total / risk) * 10000) / 10000
}

/**
 * Preserve historical risk provenance when correcting a stored value.
 * The original is never overwritten in place — it is carried alongside the
 * corrected value, its source and the calculation version.
 */
export function correctRisk({ stored, storedVersion, computed, source, ticket } = {}) {
  const original = toNum(stored)
  const corrected = toNum(computed)
  const differs = original === null
    ? corrected !== null
    : (corrected !== null && Math.abs(original - corrected) > 0.005)
  return {
    ticket: ticket ?? null,
    originalRiskAmount: original,
    originalVersion: storedVersion ?? 'orders_requested_pips_v0',
    correctedRiskAmount: corrected,
    correctedVersion: RISK_CALC_VERSION,
    source: source ?? null,
    corrected: differs,
  }
}

