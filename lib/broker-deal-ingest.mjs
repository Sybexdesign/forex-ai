/**
 * SybexForexAI — BROKER DEAL INGESTION (Phase 4.2B)
 *
 * Translates a `closedPositions[]` entry from the MT5 EA into the exact columns
 * the accounting trigger reads. Kept free of I/O so every rule below is
 * unit-testable and the HTTP route stays a thin adapter.
 *
 * THE CONTRACT (versioned, because EA and server must agree):
 *
 *   executionPayloadVersion absent / 1  -> v9.3.1-shaped payload.
 *       The EA folded DEAL_PROFIT + DEAL_COMMISSION + DEAL_SWAP into a single
 *       `profit` number and read only ONE exit deal. The components cannot be
 *       recovered, so commission and swap stay NULL and the row stays
 *       gross-only. Inventing zero here would manufacture a net figure the
 *       broker never confirmed — the exact failure Phase 4.2 exists to remove.
 *
 *   executionPayloadVersion >= 2        -> v9.4-shaped payload.
 *       `grossProfit` (Σ DEAL_PROFIT), `commission`, `swap`, `fee`,
 *       `dealCount`, `dealTickets`, `volumeClosed`, `partial` arrive
 *       separately and SIGNED as the broker reports them (Exness charges are
 *       negative). Those values are written through untouched so the trigger
 *       can compute and prove net = gross + commission + swap + fees.
 *
 * NOTHING IS COERCED. A missing or non-finite term becomes NULL plus a named
 * problem, never 0.
 */

export const PAYLOAD_VERSION = 2
export const BROKER_DEAL_CONTRACT = 'broker_deal_v2'

/** A single close this large in commission is a unit/parse error, not a fee. */
const IMPLAUSIBLE_ABS = 10_000

function readNum(v) {
  if (v === null || v === undefined || v === '') return { value: null, ok: false, present: false }
  const n = typeof v === 'number' ? v : Number(v)
  if (!Number.isFinite(n)) return { value: null, ok: false, present: true }
  return { value: n, ok: true, present: true }
}

/**
 * Resolve which payload contract this request speaks.
 * Unknown/garbage versions are treated as legacy (the safe, non-committal side).
 */
export function resolvePayloadVersion(body = {}) {
  const raw = body?.executionPayloadVersion ?? body?.p_payload?.executionPayloadVersion
  const n = Number(raw)
  const version = Number.isFinite(n) ? Math.trunc(n) : 0
  return {
    version: version >= PAYLOAD_VERSION ? PAYLOAD_VERSION : version,
    legacy: !(Number.isFinite(n) && Math.trunc(n) >= PAYLOAD_VERSION),
    eaVersion: String(body?.eaVersion ?? body?.p_payload?.eaVersion ?? 'unknown').slice(0, 32),
  }
}

/**
 * Parse one closedPositions entry into accounting terms.
 *
 * @param {object} cp      one entry from the EA's closedPositions array
 * @param {object} ctx     { payloadVersion }
 */
export function parseClosedPositionAccounting(cp = {}, ctx = {}) {
  const payloadVersion = Number(ctx.payloadVersion) || 0
  const legacy = payloadVersion < PAYLOAD_VERSION
  const problems = []

  // v9.4 sends grossProfit explicitly; older payloads only have `profit`, which
  // for v9.3.1 was already net-ish. Either way it is the best available gross
  // evidence and is what the trigger treats as pl_usd.
  const grossSrc = readNum(cp.grossProfit)
  const profitSrc = readNum(cp.profit)
  const gross = grossSrc.ok ? grossSrc.value : (profitSrc.ok ? profitSrc.value : null)
  if (gross === null) problems.push('missing_gross')

  const ticketsRaw = String(cp.dealTickets ?? '').trim()
  const dealTickets = ticketsRaw
    ? ticketsRaw.split(',').map((s) => s.trim()).filter(Boolean)
    : []
  const dealCount = Number.isFinite(Number(cp.dealCount))
    ? Math.trunc(Number(cp.dealCount))
    : dealTickets.length

  // A deal-ticket list that disagrees with the declared count means the EA
  // raced or truncated its string. The money may still be right, so it is
  // recorded but flagged rather than discarded.
  if (dealTickets.length > 0 && dealCount > 0 && dealTickets.length !== dealCount) {
    problems.push('deal_ticket_count_mismatch')
  }
  if (!legacy && dealTickets.length === 0) problems.push('missing_deal_tickets')

  const out = {
    gross,
    commission: null,
    swap: null,
    fee: null,
    dealCount,
    dealTickets,
    volumeClosed: readNum(cp.volumeClosed).value,
    partial: cp.partial === true,
    legacy,
    tradeable: gross !== null,
    problems,
  }

  if (legacy) {
    // Deliberately no components: they were never transmitted.
    problems.push('legacy_payload_no_components')
    return out
  }

  for (const field of ['commission', 'swap', 'fee']) {
    const r = readNum(cp[field])
    if (!r.present) { problems.push(`missing_${field}`); continue }
    if (!r.ok) { problems.push(`invalid_${field}`); continue }
    if (Math.abs(r.value) > IMPLAUSIBLE_ABS) { problems.push(`implausible_${field}`); continue }
    out[field] = r.value
  }

  // Cross-check the EA's own arithmetic. A disagreement means one of the terms
  // is wrong; the broker terms are kept (they are the source of truth) and the
  // row is flagged for review instead of silently trusted.
  const netSrc = readNum(cp.netProfit)
  if (netSrc.ok && out.commission !== null && out.swap !== null) {
    const expected = out.gross + out.commission + out.swap + (out.fee ?? 0)
    if (Math.abs(expected - netSrc.value) > 0.05) problems.push('net_disagrees_with_components')
  }

  return out
}

/**
 * Build the trades UPDATE patch for a genuine close.
 *
 * commission/swap/other_fees are included ONLY when the payload actually
 * carried them. Omitting a key (rather than setting it to null) matters: the
 * trigger fires on UPDATE OF pl_usd, commission, swap, other_fees, and nulling
 * a term is indistinguishable from "the broker says zero".
 */
export function buildCloseAccountingPatch(parsed = {}, ctx = {}) {
  const patch = { pl_usd: parsed.gross }
  if (!parsed.legacy) {
    if (parsed.commission !== null) patch.commission = parsed.commission
    if (parsed.swap !== null) patch.swap = parsed.swap
    if (parsed.fee !== null) patch.other_fees = parsed.fee
  }
  return patch
}

/**
 * A close is only "complete" when every cost term arrived. This mirrors the DB
 * trigger so the route can log the same verdict the database will store.
 */
export function accountingVerdict(parsed = {}) {
  const missing = []
  if (parsed.gross === null) missing.push('gross')
  if (parsed.commission === null) missing.push('commission')
  if (parsed.swap === null) missing.push('swap')
  const complete = missing.length === 0
  const net = complete
    ? Math.round((parsed.gross + parsed.commission + parsed.swap + (parsed.fee ?? 0)) * 100) / 100
    : null
  return { complete, missing, net, contract: BROKER_DEAL_CONTRACT }
}

