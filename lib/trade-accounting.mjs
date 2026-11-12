// lib/trade-accounting.mjs
// ─────────────────────────────────────────────────────────────────────────────
// SybexForexAI — CANONICAL EXECUTION ACCOUNTING (Phase 4.1B)
//
// Pure + deterministic. One definition of "net realised P&L", of profitability,
// and of accounting completeness — shared by the RPC mirror, /api/mt5-sync, the
// refresh service, the analytics layer and the tests.
//
// PRODUCTION FINDING THIS REPLACES
// --------------------------------
// `trades.trade_result` was NULL for 100% of 1,284 production rows, `commission`
// and `swap` for 100%, and `realised_r` for all but 14. The reason is not a
// missing column (all 11 Phase-4 columns exist) but that the ONLY live close
// path — public.mt5_webhook_sync() — writes result/pl_usd/exit_price/
// trade_status/realised_r and never trade_result.
//
// SIGN CONVENTIONS (verified against the MT5 deal model, NOT assumed)
// ------------------------------------------------------------------
//   • MT5 `DealProfit`  = gross, excludes commission and swap.
//   • MT5 `DealCommission` and `DealSwap` are already SIGNED: a cost is negative,
//     a credit (positive swap) is positive.
//   • Therefore: net = gross + commission + swap + other_fees, with every term
//     taken as the broker supplied it.
//   • A commission payload supplied as a POSITIVE magnitude (some bridge/EA
//     builds do this) would silently convert a loss into a smaller loss, so
//     `signConvention` is explicit and recorded — never guessed silently.
//
// The formula is only applied when every term is actually known. "Missing" is
// NEVER coerced to zero: a trade with unknown commission is reported as
// accounting-incomplete with net = NULL, not as a gross-only "net".
// ─────────────────────────────────────────────────────────────────────────────

export const ACCOUNTING_VERSION = 'accounting_v1'

/** |net| <= epsilon ⇒ BREAKEVEN. Mirrors execution-truth's epsilon. */
export const ACCOUNTING_BE_EPSILON_USD = 0.01

export const RESULT = { WIN: 'WIN', LOSS: 'LOSS', BREAKEVEN: 'BREAKEVEN', UNKNOWN: 'UNKNOWN' }

/**
 * What a profitability verdict was derived from.
 *   'NET'        — gross + commission + swap all known. Complete accounting.
 *   'GROSS_ONLY' — broker gross is known but commission/swap are not. The verdict
 *                  is real (it IS broker-reported money) but it can still be
 *                  overturned by costs, so accountingComplete stays false and the
 *                  basis is recorded instead of being hidden.
 *   'NONE'       — nothing known. UNKNOWN.
 */
export const RESULT_BASIS = { NET: 'NET', GROSS_ONLY: 'GROSS_ONLY', NONE: 'NONE' }

/**
 * How the caller's commission/swap numbers are signed.
 *   'signed'      — negative = cost (MT5 native). Default, matches the EA/RPC.
 *   'cost_positive' — positive magnitude = cost; negated before summing.
 */
export const SIGN_CONVENTION = { SIGNED: 'signed', COST_POSITIVE: 'cost_positive' }

const isMissing = (v) => v === undefined || v === null || v === ''

function toNum(v) {
  if (isMissing(v)) return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

/**
 * Compute canonical net realised P&L.
 *
 * @param {object} x
 * @param {number} x.grossProfit        broker realised gross profit (DealProfit)
 * @param {number} [x.commission]       signed commission as supplied by the broker
 * @param {number} [x.swap]             signed swap
 * @param {number} [x.otherFees]        signed other broker fees
 * @param {string} [x.signConvention]   SIGN_CONVENTION.* (default 'signed')
 * @param {number} [x.epsilon]
 * @returns {{ netPnl: number|null, grossPnl: number|null, complete: boolean,
 *             missing: string[], result: string, signConvention: string,
 *             version: string, components: object }}
 */
export function computeNetPnl(x = {}) {
  const signConvention = x.signConvention === SIGN_CONVENTION.COST_POSITIVE
    ? SIGN_CONVENTION.COST_POSITIVE
    : SIGN_CONVENTION.SIGNED
  const epsilon = toNum(x.epsilon) ?? ACCOUNTING_BE_EPSILON_USD

  const gross = toNum(x.grossProfit)
  const commission = toNum(x.commission)
  const swap = toNum(x.swap)
  const otherFees = toNum(x.otherFees)

  const missing = []
  if (gross === null) missing.push('grossProfit')
  if (commission === null) missing.push('commission')
  if (swap === null) missing.push('swap')
  // otherFees is optional: an absent fee field genuinely means "no other fees
  // were reported", which is different from a broker that reports fees and says
  // null. Callers that have a fees field must pass it.
  const fees = otherFees === null ? 0 : otherFees

  if (gross === null) {
    return {
      netPnl: null, grossPnl: null, complete: false, missing,
      result: RESULT.UNKNOWN, resultBasis: RESULT_BASIS.NONE,
      signConvention, version: ACCOUNTING_VERSION,
      components: { grossProfit: null, commission, swap, otherFees },
    }
  }

  const costsKnown = commission !== null && swap !== null && fees !== null
  const sign = signConvention === SIGN_CONVENTION.COST_POSITIVE ? -1 : 1
  const c = commission === null ? null : commission * sign
  const s = swap === null ? null : swap * sign
  const f = (otherFees === null ? 0 : otherFees) * sign

  const netPnl = costsKnown ? round2(gross + c + s + f) : null
  // With complete costs the verdict is final. Without them the broker gross is
  // still REAL money, so it yields a provisional verdict flagged GROSS_ONLY —
  // never a fabricated net, and never a silent UNKNOWN that throws away evidence.
  const result = costsKnown ? classifyNet(netPnl, epsilon) : classifyNet(round2(gross), epsilon)

  return {
    netPnl,
    grossPnl: round2(gross),
    complete: missing.length === 0,
    missing,
    result,
    resultBasis: costsKnown ? RESULT_BASIS.NET : RESULT_BASIS.GROSS_ONLY,
    signConvention,
    version: ACCOUNTING_VERSION,
    components: { grossProfit: round2(gross), commission: c, swap: s, otherFees: f },
  }
}

function round2(n) {
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null
}

/** Classify a known net P&L into a canonical profitability outcome. */
export function classifyNet(netPnl, epsilon = ACCOUNTING_BE_EPSILON_USD) {
  const n = toNum(netPnl)
  if (n === null) return RESULT.UNKNOWN
  if (Math.abs(n) <= epsilon) return RESULT.BREAKEVEN
  return n > 0 ? RESULT.WIN : RESULT.LOSS
}

/**
 * Legacy `result` values are lifecycle, not profitability.
 *
 * Production had 487 rows with result='CLOSED' written by the
 * "reconcile DB OPEN trades against EA live positions" branch of
 * mt5_webhook_sync(), which sets result='CLOSED', closed_at=now() and leaves
 * pl_usd NULL. Those rows are CLOSED trades with UNKNOWN profitability — they are
 * emphatically not losses and must never be counted as such.
 */
export const LEGACY_CLOSED_VALUES = new Set(['CLOSED', 'CANCELLED'])

/**
 * Resolve the canonical (status, result) pair for a trade row.
 *
 * Precedence:
 *   1. An explicit, already-canonical `trade_result` wins (never second-guessed).
 *   2. Otherwise derive from known net P&L (canonical formula).
 *   3. Otherwise UNKNOWN — never WIN/LOSS from the legacy field.
 *
 * @param {object} trade
 * @returns {{ tradeStatus: string|null, tradeResult: string, source: string,
 *             accountingComplete: boolean, missing: string[] }}
 */
export function resolveOutcome(trade = {}) {
  const closedAt = trade.closed_at ?? trade.closedAt ?? null
  const raw = String(trade.result ?? trade.status ?? '').toUpperCase().trim()

  let tradeStatus = String(trade.trade_status ?? '').toUpperCase().trim() || null
  if (!tradeStatus) {
    if (raw === 'OPEN') tradeStatus = closedAt ? 'CLOSED' : 'OPEN'
    else if (raw === 'CLOSED' || raw === 'WIN' || raw === 'LOSS' || raw === 'BREAKEVEN') tradeStatus = 'CLOSED'
    else if (raw === 'CANCELLED') tradeStatus = 'CANCELLED'
    else if (raw === 'PENDING') tradeStatus = 'PENDING'
    else if (raw === 'PARTIALLY_CLOSED' || raw === 'PARTIAL') tradeStatus = 'PARTIALLY_CLOSED'
    else tradeStatus = null
  }

  const explicit = String(trade.trade_result ?? '').toUpperCase().trim()
  if (explicit === RESULT.WIN || explicit === RESULT.LOSS || explicit === RESULT.BREAKEVEN) {
    return { tradeStatus, tradeResult: explicit, resultBasis: 'EXPLICIT', source: 'explicit_trade_result', accountingComplete: true, missing: [] }
  }

  const acct = computeNetPnl({
    grossProfit: trade.pl_usd ?? trade.grossProfit ?? trade.gross_profit,
    commission: trade.commission,
    swap: trade.swap,
    otherFees: trade.other_fees ?? trade.otherFees,
    signConvention: trade.signConvention ?? trade.sign_convention,
  })

  if (acct.resultBasis === RESULT_BASIS.NET && acct.result !== RESULT.UNKNOWN) {
    return { tradeStatus, tradeResult: acct.result, resultBasis: 'NET', source: 'net_realised_pnl', accountingComplete: true, missing: [] }
  }

  // Broker gross is real evidence even when costs are still unknown. The verdict
  // is returned, but flagged GROSS_ONLY with accountingComplete=false so nothing
  // downstream can mistake it for a net figure.
  if (acct.resultBasis === RESULT_BASIS.GROSS_ONLY && acct.result !== RESULT.UNKNOWN) {
    return { tradeStatus, tradeResult: acct.result, resultBasis: 'GROSS_ONLY', source: 'gross_realised_pnl', accountingComplete: false, missing: acct.missing }
  }

  // No money known at all — e.g. the 487 legacy result='CLOSED' rows, which carry
  // closed_at but neither pl_usd nor costs. Closed lifecycle, UNKNOWN verdict.
  return {
    tradeStatus,
    tradeResult: RESULT.UNKNOWN,
    resultBasis: 'NONE',
    source: LEGACY_CLOSED_VALUES.has(raw) ? 'legacy_closed_no_financials' : 'insufficient_financial_evidence',
    accountingComplete: false,
    missing: acct.missing,
  }
}

/**
 * Aggregate broker deals for one position into a single accounting result.
 *
 * A position can close in several deals (partial closes). Rules:
 *   • every deal is keyed by its broker deal ticket — a re-delivered deal is
 *     ignored, never double counted;
 *   • deals without a ticket are refused (they cannot be de-duplicated);
 *   • partial vs final closure is inferred from the reported volume;
 *   • net P&L is summed per deal then rounded once.
 *
 * @param {Array<object>} deals [{ dealTicket, grossProfit, commission, swap, otherFees, volume, volumeRequested, closedAt, signConvention }]
 * @param {object} [opts] { positionVolume, signConvention }
 */
export function aggregateDeals(deals = [], opts = {}) {
  const seen = new Set()
  const accepted = []
  const rejected = []
  let duplicates = 0

  for (const d of deals) {
    const ticket = String(d?.dealTicket ?? d?.deal_ticket ?? '').trim()
    if (!ticket) { rejected.push({ deal: d, reason: 'missing_deal_ticket' }); continue }
    if (seen.has(ticket)) { duplicates++; rejected.push({ deal: d, reason: 'duplicate_deal_ticket' }); continue }
    seen.add(ticket)
    accepted.push({ ...d, dealTicket: ticket })
  }

  const perDeal = accepted.map((d) => ({
    dealTicket: d.dealTicket,
    ...computeNetPnl({
      grossProfit: d.grossProfit ?? d.pl_usd,
      commission: d.commission,
      swap: d.swap,
      otherFees: d.otherFees ?? d.other_fees,
      signConvention: d.signConvention ?? opts.signConvention,
    }),
  }))

  const allComplete = perDeal.length > 0 && perDeal.every((d) => d.complete)
  const netPnl = allComplete ? round2(perDeal.reduce((a, d) => a + (d.netPnl ?? 0), 0)) : null
  const grossPnl = perDeal.every((d) => d.grossPnl !== null)
    ? round2(perDeal.reduce((a, d) => a + d.grossPnl, 0))
    : null

  const closedVolume = round4(accepted.reduce((a, d) => a + (toNum(d.volume) ?? 0), 0))
  const positionVolume = toNum(opts.positionVolume ?? accepted[0]?.volumeRequested)
  const partial = positionVolume !== null && closedVolume > 0 && closedVolume < positionVolume - 1e-9

  return {
    deals: perDeal,
    dealCount: perDeal.length,
    duplicateDeals: duplicates,
    rejected,
    netPnl,
    grossPnl,
    closedVolume,
    positionVolume,
    partial,
    lifecycle: partial ? 'PARTIALLY_CLOSED' : 'CLOSED',
    result: netPnl === null ? RESULT.UNKNOWN : classifyNet(netPnl),
    complete: allComplete,
    version: ACCOUNTING_VERSION,
  }
}

function round4(n) {
  return Number.isFinite(n) ? Math.round(n * 10000) / 10000 : null
}

/**
 * Accounting completeness verdict for a single stored trade row.
 * Drives the Production Integrity panel; explains WHY a row is incomplete.
 */
export function accountingCompleteness(trade = {}) {
  const missing = []
  if (toNum(trade.pl_usd) === null) missing.push('gross_profit')
  if (toNum(trade.commission) === null) missing.push('commission')
  if (toNum(trade.swap) === null) missing.push('swap')
  if (!String(trade.broker_ticket ?? '').trim()) missing.push('broker_ticket')
  if (String(trade.trade_result ?? '').toUpperCase().trim() === '') missing.push('trade_result')
  return {
    complete: missing.length === 0,
    missing,
    netPnl: toNum(trade.net_realised_pnl),
    status: missing.length === 0 ? 'HEALTHY' : (toNum(trade.pl_usd) === null ? 'INCOMPLETE' : 'WARNING'),
  }
}

