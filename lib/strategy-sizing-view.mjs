// lib/strategy-sizing-view.mjs
// ── THE STRATEGY PAGE VIEW-MODEL ────────────────────────────────────────────
//
// The page RENDERS this; it does not do sizing arithmetic.
//
// The block this replaces computed its own numbers in JSX and had already drifted
// from execution: it hardcoded `slCap = 25` while MIRROR_SL_CAP is 35, invented a
// $10k fallback balance, and told the user "orders route will reduce to ~0.50
// lots" — the exact silent reduction the Manual policy exists to remove. A preview
// that disagrees with the planner is worse than no preview.
//
// So every number here comes from `buildManualSizingPreview()`, the same policy
// /api/orders executes. This module only decides LABELS, FORMATTING and ORDER of
// rows, plus which notices to surface. It cannot invent a value: a row whose value
// is null renders as an explicit "awaiting" state.

import { MAX_LOTS, MIRROR_SL_CAP, minStopPips } from './trade-levels'
import { buildManualSizingPreview, MANUAL_MAX_RISK_PCT_CEILING } from './manual-sizing.mjs'
import { getPipValuePerLot } from './brokers/interface'
import { validateLotSize, lotSizeToText, isPartialLotInput } from './lot-size.mjs'

export { validateLotSize, lotSizeToText, isPartialLotInput }

/** Authoritative geometry for a pair — never a local `pair === 'XAU/USD' ? 10 : …`. */
export function geometryForPair(pair) {
  return {
    pipValuePerLot: getPipValuePerLot(pair),
    brokerMinStopPips: minStopPips(pair),
    slCapPips: MIRROR_SL_CAP,
  }
}

/**
 * Commit-boundary validation for the Manual Risk % draft.
 *
 * Mirrors validateLotSize()'s draft/commit contract exactly: EMPTY STAYS EMPTY
 * (never coerced to 0), and the accepted range is the CANONICAL (0, ceiling] —
 * this deliberately imports the ceiling rather than restating a frontend range.
 *
 * @returns {{ok:boolean, empty:boolean, value:number|null, error:string|null}}
 */
export function validateManualRiskPct(raw, opts = {}) {
  const max = opts.max ?? MANUAL_MAX_RISK_PCT_CEILING
  const text = raw == null ? '' : String(raw).trim()
  if (text === '') return { ok: true, empty: true, value: null, error: null }
  if (!/^\d*\.?\d*$/.test(text)) {
    return { ok: false, empty: false, value: null, error: 'Manual risk must be a number' }
  }
  const n = parseFloat(text)
  if (!isFinite(n))          return { ok: false, empty: false, value: null, error: 'Manual risk must be a number' }
  if (n <= 0)                return { ok: false, empty: false, value: null, error: 'Manual risk must be greater than 0%' }
  if (n > max)               return { ok: false, empty: false, value: null, error: `Manual risk must be ${max}% or less` }
  return { ok: true, empty: false, value: n, error: null }
}

/** True while the draft is still typeable (used to clear stale errors mid-edit). */
export function isPartialRiskInput(raw) {
  const t = raw == null ? '' : String(raw)
  return /^\d*\.?\d*$/.test(t)
}

/** Which sizing mode a committed Manual Lots value selects. */
export function resolveManualMode(manualLots) {
  const lots = Number(manualLots)
  return Number.isFinite(lots) && lots > 0 ? 'MANUAL' : 'AUTO'
}

const money = (sym, n) => `${sym}${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

/**
 * The shape returned by the shared sizing policy. Declared here so the page gets
 * real types instead of `object` — the whole point of the view model is that the
 * page reads values rather than recomputing them.
 * @typedef {object} ManualPreview
 * @property {'AUTO'|'MANUAL'} mode
 * @property {'EXECUTABLE'|'CANNOT_EXECUTE'|'AWAITING_DATA'} status
 * @property {string|null} reason
 * @property {string|null} message
 * @property {number|null} requestedLots
 * @property {number|null} manualRiskPct
 * @property {number|null} autoRiskPct
 * @property {number|null} balance
 * @property {number|null} pipValuePerLot
 * @property {number|null} riskBudgetUsd
 * @property {number|null} rawSlPips
 * @property {number|null} finalSlPips
 * @property {number|null} actualRiskUsd
 * @property {number|null} actualRiskPct
 * @property {number|null} tpPips
 * @property {number|null} rr
 * @property {boolean} slCapped
 * @property {number|null} slCappedFrom
 * @property {boolean} slBelowBrokerMin
 * @property {number|null} brokerMinStopPips
 * @property {number} maxLots
 * @property {boolean} lotsAreAuthoritative
 * @property {boolean} manualExceedsAutoRisk
 */

/**
 * @typedef {object} SizingViewRow
 * @property {string} key
 * @property {string} label
 * @property {string|null} value  null = not available → render as "awaiting"
 */

/**
 * @typedef {object} SizingNotice
 * @property {'info'|'warn'} tone
 * @property {string} text
 */

/**
 * @typedef {object} SizingView
 * @property {'AUTO'|'MANUAL'} mode
 * @property {ManualPreview} preview
 * @property {string} statusLabel
 * @property {string|null} constraint
 * @property {SizingViewRow[]} rows
 * @property {SizingNotice[]} notices
 * @property {number} maxLots
 * @property {{pipValuePerLot:number, minStopPips:number, maxSlPips:number}} geometry
 */

/**
 * Build the complete Manual-sizing view for the Strategy page.
 *
 * @param {object} [o]
 * @param {number|null|undefined} [o.manualLots]        committed value (null = AUTO)
 * @param {number|null|undefined} [o.manualRiskPct]     committed manual risk budget
 * @param {number|null|undefined} [o.defaultManualRiskPct] canonical default (DEFAULT_STRATEGY)
 * @param {number|null|undefined} [o.autoRiskPct]       strategy.riskPct — context only
 * @param {number|null|undefined} [o.balance]           live account balance (0/null = not synced)
 * @param {string} [o.pair]
 * @param {string|undefined} [o.currency]
 * @param {number|null|undefined} [o.strategySlPips]     for the R:R
 * @param {number|null|undefined} [o.strategyTpPips]
 * @param {number|null|undefined} [o.pipValuePerLot]     override geometry (tests)
 * @param {number|null|undefined} [o.brokerMinStopPips]
 * @param {number|null|undefined} [o.slCapPips]
 * @returns {SizingView} view model: {mode, preview, statusLabel, constraint, rows, notices, maxLots, geometry}
 */
export function buildStrategySizingView({
  manualLots = null, manualRiskPct = null, defaultManualRiskPct = null,
  autoRiskPct = null, balance = null, pair = 'XAU/USD', currency = 'USD',
  strategySlPips = null, strategyTpPips = null,
  pipValuePerLot = null, brokerMinStopPips = null, slCapPips = null,
} = {}) {
  const sym  = currency === 'USD' || !currency ? '$' : ''
  const mode = resolveManualMode(manualLots)

  // The committed risk %, falling back to the ONE canonical default. The policy
  // itself carries no default, so the fallback must happen here (and identically
  // in /api/orders) rather than being invented a second time downstream.
  const committedRisk = Number(manualRiskPct)
  const effectiveRiskPct = (Number.isFinite(committedRisk) && committedRisk > 0)
    ? committedRisk
    : (Number.isFinite(Number(defaultManualRiskPct)) ? Number(defaultManualRiskPct) : null)

  const geo = {
    pipValuePerLot:      pipValuePerLot      ?? getPipValuePerLot(pair),
    minStopPips:         brokerMinStopPips   ?? minStopPips(pair),
    maxSlPips:           slCapPips           ?? MIRROR_SL_CAP,
  }

  const preview = buildManualSizingPreview({
    manualLots,
    balance,
    manualRiskPct: effectiveRiskPct,
    autoRiskPct,
    pipValuePerLot: geo.pipValuePerLot,
    minStopPips:    geo.minStopPips,
    maxSlPips:      geo.maxSlPips,
    strategySlPips,
    strategyTpPips,
  })

  const p = preview

  const statusLabel = p.status === 'EXECUTABLE'     ? 'Executable'
                    : p.status === 'CANNOT_EXECUTE' ? 'Cannot Execute'
                    : (p.message || 'Awaiting data')

  // Explicit constraint text — never hide a clamp.
  let constraint = null
  if (p.status === 'CANNOT_EXECUTE' && p.slBelowBrokerMin) {
    constraint = `Calculated stop loss is below the minimum permitted for this instrument (${p.brokerMinStopPips} pips).`
  } else if (p.status === 'CANNOT_EXECUTE' && p.message) {
    constraint = p.message
  } else if (p.slCapped) {
    constraint = 'Maximum SL cap applied'
  }

  const awaitingBalance = p.status === 'AWAITING_DATA' && p.reason === 'awaiting-account-data'
  const awaitingGeo     = p.status === 'AWAITING_DATA' && p.reason === 'awaiting-instrument-geometry'

  // Ordered rows exactly as the acceptance criterion lists them. `value: null`
  // means "not available" and renders as an explicit awaiting placeholder.
  const rows = [
    { key: 'mode',   label: 'Position Sizing',        value: mode === 'MANUAL' ? 'Manual' : 'Automatic' },
    ...(mode === 'MANUAL' ? [
      { key: 'lots',  label: 'Requested Lot Size',    value: p.requestedLots == null ? null : `${p.requestedLots.toFixed(2)} lots` },
      { key: 'risk',  label: 'Manual Risk Limit',     value: p.manualRiskPct == null ? null : `${p.manualRiskPct}%` },
      { key: 'bal',   label: 'Account Balance',       value: awaitingBalance ? null : (p.balance == null ? null : money(sym, p.balance)) },
      { key: 'budget',label: 'Maximum Risk Budget',   value: pending(awaitingGeo, p.riskBudgetUsd == null ? null : money(sym, p.riskBudgetUsd)) },
      { key: 'rawsl', label: 'Raw Calculated Stop Loss', value: pending(awaitingGeo, p.rawSlPips == null ? null : `${p.rawSlPips} pips`) },
      { key: 'fsl',   label: 'Final Stop Loss',       value: pending(awaitingGeo, p.finalSlPips == null ? null : `${p.finalSlPips} pips`) },
      { key: 'loss',  label: 'Estimated Actual Loss at SL', value: pending(awaitingGeo, p.actualRiskUsd == null ? null : `−${money(sym, p.actualRiskUsd)}`) },
      { key: 'arpct', label: 'Actual Account Risk',   value: pending(awaitingGeo, p.actualRiskPct == null ? null : `${p.actualRiskPct}%`) },
      { key: 'rr',    label: 'Strategy Risk : Reward',value: p.rr == null ? null : `1 : ${p.rr}` },
      { key: 'tp',    label: 'Calculated Take Profit',value: pending(awaitingGeo, p.tpPips == null ? null : `${p.tpPips} pips`) },
    ] : []),
    { key: 'max', label: 'Application Maximum', value: `${MAX_LOTS.toFixed(2)} lots` },
    { key: 'status', label: 'Status', value: statusLabel },
  ]

  const notices = []
  if (mode === 'MANUAL' && p.manualExceedsAutoRisk) {
    notices.push({
      tone: 'info',
      text: `Manual sizing is configured with a ${p.manualRiskPct}% risk budget. Automatic sizing currently uses ${p.autoRiskPct}%.`,
    })
  }
  if (mode === 'MANUAL' && (manualRiskPct == null || Number(manualRiskPct) <= 0)) {
    notices.push({
      tone: 'warn',
      text: `No Manual Risk % saved — showing the strategy default (${effectiveRiskPct}%). Set it explicitly to make the budget yours.`,
    })
  }
  if (p.status === 'EXECUTABLE' && p.actualRiskPct != null && p.actualRiskPct >= 10) {
    notices.push({ tone: 'warn', text: `Estimated Account Exposure at SL: ${p.actualRiskPct}%` })
  }

  return { mode, preview: p, statusLabel, constraint, rows, notices, maxLots: MAX_LOTS, geometry: geo }

  function pending(isAwaiting, v) { return isAwaiting ? null : v }
}

