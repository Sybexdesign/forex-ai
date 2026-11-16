/**
 * SybexForexAI — ANALYTICS POPULATION SCOPE (Phase 4.2C)
 *
 * WHY THIS EXISTS
 * Evidence, not opinion: `components/pages/DashboardPage.tsx` computed
 *
 *     closedTrades = trades.filter(t => t.result && t.result !== 'OPEN')
 *     winRate      = wins / closedTrades.length
 *     todayPL      = Σ (t.pl_usd || 0)
 *
 * Every one of those three expressions is unsafe on real production data:
 *
 *   1. `result !== 'OPEN'` includes `CLOSED`, `CANCELLED` and stale rows that
 *      carry no money at all. A row with no financial evidence was being
 *      counted in the win-rate denominator.
 *   2. `pl_usd || 0` coerces a MISSING value to zero. A missing number is not
 *      zero — it is "unknown", and averaging it as 0 drags every statistic.
 *   3. The population mixes ticket-less simulation/model rows with genuine
 *      broker executions. 1,143 of 1,284 production rows carry no broker
 *      ticket; folding them into "performance" mixes fiction with fact.
 *
 * This module computes nothing. It decides, for one row, which population that
 * row belongs to and therefore which metrics it may contribute to. The
 * arithmetic lives in `lib/analytics-metrics.mjs`, which refuses to put a
 * non-net population into a net figure.
 *
 * THE ONE RULE
 * A gross-only row may have a provisional direction (WIN/LOSS from gross), but
 * it must NEVER enter a confirmed NET metric. It is reported beside net with a
 * count, so the exclusion is visible rather than silent.
 */

/** The populations a trade row can belong to. Exactly one per row. */
export const POPULATION = {
  /** Broker-confirmed AND all cost terms known. The only population allowed to
   *  contribute to confirmed net profitability. */
  NET_CONFIRMED: 'NET_CONFIRMED',
  /** Broker-confirmed gross, but commission/swap absent. Directional evidence
   *  only — never presented as net. */
  GROSS_ONLY: 'GROSS_ONLY',
  /** Closed but no financial value at all yet (deal history not delivered). */
  ACCOUNTING_PENDING: 'ACCOUNTING_PENDING',
  /** Financial value present but unusable (non-finite, or flagged by broker). */
  ACCOUNTING_ERROR: 'ACCOUNTING_ERROR',
  /** No broker ticket — simulated / model / paper row. Retained, never counted
   *  as an execution. */
  SIMULATION: 'SIMULATION',
  /** Still open — not a result yet. */
  OPEN: 'OPEN',
  /** Cancelled or rejected before execution. Not a loss. */
  CANCELLED: 'CANCELLED',
}

export const ANALYTICS_SCOPE_VERSION = 'analytics_scope_v1'

const CANCELLED_RESULTS = new Set(['CANCELLED', 'REJECTED', 'CANCELED'])

function num(v) {
  if (v === null || v === undefined || v === '') return null
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : null
}

function str(v) {
  return String(v ?? '').trim()
}

/**
 * True when the row carries a broker execution reference.
 * Ticket-less rows are simulations: 1,143 of 1,284 production rows at the time
 * of writing, so this single predicate is the difference between reporting a
 * trading result and reporting a model artefact.
 *
 * Phase 4.2.1 (M-1 / A-2): this now delegates to `brokerTicketKind()`, so a row
 * whose `broker_ticket` merely REPEATS its own internal row id — an id disguised
 * as a ticket — is not a genuine execution. A UUID broker reference from another
 * venue still is: it classifies as OTHER_BROKER_REF, which is a real execution
 * that must keep counting. See the note on BROKER_TICKET_KIND below.
 */
export function isGenuineExecution(trade = {}) {
  return brokerTicketKind(trade) !== BROKER_TICKET_KIND.NONE
}

/**
 * WHAT KIND of broker identifier a row carries (Phase 4.2.1, defect M-1 / H-B).
 *
 * WHY THIS EXISTS
 * Production holds 141 rows with a `broker_ticket`, but only 30 of them are
 * numeric MT5 tickets. The other 111 hold a UUID that is byte-identical to the
 * row's `oanda_trade_id` — a genuine execution on a *different* broker, not an
 * MT5 position. Because `isGenuineExecution()` only asked "is the field
 * non-empty", the platform reported "141 genuine executions", overstating
 * broker-confirmed MT5 evidence by ~4.7x.
 *
 * The fix is classification, not deletion: a UUID-backed row is still a real
 * broker execution (its P&L is genuine and must keep counting), it simply must
 * never be *labelled* or *counted* as an MT5 ticket. Nothing historical is
 * rewritten.
 */
export const BROKER_TICKET_KIND = {
  /** Numeric MT5 position/deal ticket — the only kind an MT5 claim may rest on. */
  MT5_POSITION: 'MT5_POSITION',
  /** A broker execution reference from a non-MT5 venue (UUID / alphanumeric). */
  OTHER_BROKER_REF: 'OTHER_BROKER_REF',
  /** No broker reference at all — simulation, model or paper row. */
  NONE: 'NONE',
}

/** MT5 tickets are decimal integers. 20 digits covers the ulong range. */
const MT5_TICKET_RE = /^\d{1,20}$/
/** RFC-4122 UUID, i.e. the shape of `trades.id` / `oanda_trade_id`. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** True when `value` is a UUID — an internal identifier, never an MT5 ticket. */
export function isUuidRef(value) {
  return UUID_RE.test(str(value))
}

/**
 * Classify the identifier in `broker_ticket`.
 *
 * `internalId` is optional: when supplied and the ticket equals it, the row is
 * flagged as an internal id masquerading as a ticket rather than a broker
 * reference. The historical UUIDs are NOT of that shape (they equal
 * `oanda_trade_id`), which is why they classify as OTHER_BROKER_REF and keep
 * contributing to their population.
 */
export function brokerTicketKind(trade = {}, internalId = null) {
  const raw = str(trade.broker_ticket)
  if (!raw) return BROKER_TICKET_KIND.NONE
  const id = str(internalId ?? trade.id)
  if (id && raw === id) return BROKER_TICKET_KIND.NONE
  return MT5_TICKET_RE.test(raw) ? BROKER_TICKET_KIND.MT5_POSITION : BROKER_TICKET_KIND.OTHER_BROKER_REF
}

/**
 * True only for a numeric MT5 ticket. This is the predicate any "MT5-confirmed"
 * claim must use; `isGenuineExecution()` deliberately stays wider so that
 * non-MT5 broker executions keep counting as executions.
 */
export function isMt5TicketBacked(trade = {}) {
  return brokerTicketKind(trade) === BROKER_TICKET_KIND.MT5_POSITION
}

/**
 * Unknown-aware sum of realised P&L over an already-scoped row list.
 *
 * THE RULE (Phase 4.2.1, GATE-1 companion):
 *   - a finite number contributes its value, sign preserved;
 *   - `null` / `undefined` / `''` / `NaN` / `Infinity` make the TOTAL unknown
 *     (`pl: null`) — they are NOT zeros;
 *   - the caller decides what an unknown total means. Order gating fails closed;
 *     display surfaces show "unknown" and count it.
 *
 * Returns `{ pl, known, unknown, rows }` where `rows` is the number of rows
 * considered. `pl` is `null` when any considered row is unknown, even if other
 * rows are known — a partially-known total is not a total.
 */
export function sumKnownPL(trades = []) {
  const list = Array.isArray(trades) ? trades : []
  let sum = 0
  let known = 0
  let unknown = 0
  for (const t of list) {
    const v = num(t?.pl_usd)
    if (v === null) { unknown++; continue }
    sum += v
    known++
  }
  return {
    pl: unknown > 0 ? null : sum,
    known,
    unknown,
    rows: list.length,
  }
}

/**
 * Classify one trade row into exactly one population.
 *
 * Order matters and is deliberate: cancellation is settled first, then OPEN is
 * decided ONLY when no hard close evidence exists (see the H-1 note below),
 * then simulation is checked before financial completeness (a mock row is not an
 * accounting failure), and "no money yet" is checked before "money but net".
 * Any ordering change would move rows between populations and silently alter
 * every reported figure, so each step below is guarded by a test.
 */
export function classifyTrade(trade = {}) {
  const genuine = isGenuineExecution(trade)
  const rawResult = str(trade.trade_result || trade.result).toUpperCase()
  const rawStatus = str(trade.trade_status).toUpperCase()
  const closedAt = str(trade.closed_at)
  const gross = num(trade.pl_usd)
  const netKnown = num(trade.net_realised_pnl)
  // accounting_complete is the broker-verified flag written by the derivation
  // trigger. `null` means "not applicable / never evaluated" (an OPEN row),
  // which is different from `false` ("evaluated and incomplete").
  const complete = trade.accounting_complete === true

  // ── HARD CLOSE EVIDENCE (Phase 4.2.1, defect H-1 / Report B H-A) ─────────
  //
  // WHY THE ORDER CHANGED
  // This function used to return OPEN on `trade_status === 'OPEN'` BEFORE
  // looking at anything else. Production keeps 36 rows that carry
  // `result = 'LOSS'`, a `closed_at`, a realised `pl_usd` — and a stale
  // `trade_status = 'OPEN'`. Every one of them vanished from profitability, and
  // 14 genuine closes worth +298.79 were hidden behind 14 displayed losses,
  // which flipped the sign of the reported window.
  //
  // `trade_status` is a legacy mirror written once at submission and never
  // updated by the close ingester; `closed_at` + a resolved result is the
  // authoritative broker evidence. So close evidence wins, and the stale flag
  // decides only when no close evidence exists.
  //
  // Nothing is inferred: a row is NOT closed because it is old, because it is
  // missing from open positions, or because a timestamp exists without a
  // resolved result.
  const CLOSED_RESULTS = new Set(['WIN', 'LOSS', 'CLOSED'])
  const hasCloseEvidence = closedAt.length > 0
    && (CLOSED_RESULTS.has(rawResult) || rawStatus === 'CLOSED')

  const base = {
    netPnl: null,
    grossPnl: gross,
    isGenuineExecution: genuine,
    brokerEvidence: brokerTicketKind(trade),
    contributesToNet: false,
    contributesToGross: false,
    version: ANALYTICS_SCOPE_VERSION,
  }

  if (CANCELLED_RESULTS.has(rawResult)) {
    return { ...base, population: POPULATION.CANCELLED, reason: 'cancelled_or_rejected_before_execution' }
  }

  if (!hasCloseEvidence && (rawResult === 'OPEN' || rawStatus === 'OPEN')) {
    return { ...base, population: POPULATION.OPEN, reason: 'position_still_open' }
  }

  if (!genuine) {
    return { ...base, population: POPULATION.SIMULATION, reason: 'no_broker_ticket' }
  }

  // From here the row IS a genuine broker execution. Below decides how much
  // financial confidence it earns.
  if (gross === null && netKnown === null) {
    return { ...base, population: POPULATION.ACCOUNTING_PENDING, reason: 'closed_without_financial_value' }
  }

  const missing = Array.isArray(trade.accounting_missing) ? trade.accounting_missing : []
  // Phase 4.2.1 (defect M-3): the old predicate also read
  // `trade.accounting_status`, a column that does not exist in `trades` —
  // selecting it returns HTTP 400, so that half of the branch was unreachable
  // dead code that made a phantom column look real. Broker-flagged accounting
  // problems are carried in `accounting_missing` (created by Phase 4.1), which is
  // the column the derivation trigger actually writes.
  const flaggedError = missing.some((m) => /error|invalid/i.test(String(m)))
  if (flaggedError) {
    return { ...base, population: POPULATION.ACCOUNTING_ERROR, reason: 'broker_financial_value_unusable' }
  }

  if (complete && netKnown !== null) {
    return {
      ...base,
      population: POPULATION.NET_CONFIRMED,
      reason: 'broker_confirmed_with_complete_costs',
      netPnl: netKnown,
      contributesToNet: true,
      contributesToGross: true,
    }
  }

  // Genuine execution, money present, but costs unproven. Provisional only.
  return {
    ...base,
    population: POPULATION.GROSS_ONLY,
    reason: missing.length ? `missing:${missing.join('+')}` : 'costs_not_confirmed_by_broker',
    contributesToGross: true,
  }
}

/**
 * Split an arbitrary trade array into populations, preserving every row.
 * Nothing is dropped — excluded rows are counted so the exclusion is auditable.
 */
export function partitionTrades(trades = []) {
  const buckets = Object.fromEntries(Object.values(POPULATION).map((p) => [p, []]))
  const classified = (Array.isArray(trades) ? trades : []).map((t) => ({
    trade: t,
    verdict: classifyTrade(t),
  }))
  for (const c of classified) buckets[c.verdict.population].push(c.trade)

  const counts = Object.fromEntries(
    Object.entries(buckets).map(([k, v]) => [k, v.length]),
  )
  const genuine = counts[POPULATION.NET_CONFIRMED] + counts[POPULATION.GROSS_ONLY]
    + counts[POPULATION.ACCOUNTING_PENDING] + counts[POPULATION.ACCOUNTING_ERROR]

  // Phase 4.2.1 (defect M-1): executions and MT5 tickets are different claims.
  // `genuineExecutions` stays as it was so no consumer's number changes, but the
  // MT5 figure is now available and can be quoted when the claim is about MT5.
  const ticketKinds = { [BROKER_TICKET_KIND.MT5_POSITION]: 0, [BROKER_TICKET_KIND.OTHER_BROKER_REF]: 0, [BROKER_TICKET_KIND.NONE]: 0 }
  for (const c of classified) ticketKinds[c.verdict.brokerEvidence]++

  return {
    classified,
    buckets,
    counts,
    ticketKinds,
    totalRows: classified.length,
    genuineExecutions: genuine,
    mt5TicketExecutions: ticketKinds[BROKER_TICKET_KIND.MT5_POSITION],
    otherBrokerExecutions: ticketKinds[BROKER_TICKET_KIND.OTHER_BROKER_REF],
    version: ANALYTICS_SCOPE_VERSION,
  }
}

/**
 * The populations that represent a CLOSED broker execution, in the order a
 * reader should think about them: confirmed net, gross-only, pending accounting,
 * accounting error. A row in any of these is a real trade whose money may be
 * present, partial, or not yet known — but it is never a model artefact and
 * never a still-open position.
 */
export const EXECUTION_POPULATIONS = [
  POPULATION.NET_CONFIRMED,
  POPULATION.GROSS_ONLY,
  POPULATION.ACCOUNTING_PENDING,
  POPULATION.ACCOUNTING_ERROR,
]

/**
 * Rows that a risk limit (or a performance figure) may be computed over.
 *
 * This is the single definition of "the rows that count", used by the order
 * guard, the client daily P&L, and the prop-firm page, so those three surfaces
 * cannot drift apart. Everything excluded — simulations, cancelled, still-open,
 * rows with no ticket — is deliberately left out.
 *
 * Pair it with `sumKnownPL()`: this function decides *which* rows, that one
 * decides what their sum is allowed to claim.
 */
export function closedExecutions(trades = []) {
  const partition = partitionTrades(trades)
  return EXECUTION_POPULATIONS.flatMap((p) => partition.buckets[p] || [])
}

/**
 * Human-readable denominator disclosure, e.g.
 *   "98 broker executions | 0 net-complete | 98 gross-only | 1,143 simulated"
 * A reader can see what was excluded and why without opening a query console.
 */
export function describeScope(counts = {}) {
  const n = (k) => Number(counts[k] || 0).toLocaleString('en-GB')
  const executions = Number(counts[POPULATION.NET_CONFIRMED] || 0)
    + Number(counts[POPULATION.GROSS_ONLY] || 0)
    + Number(counts[POPULATION.ACCOUNTING_PENDING] || 0)
    + Number(counts[POPULATION.ACCOUNTING_ERROR] || 0)
  const parts = [
    `${executions.toLocaleString('en-GB')} broker executions`,
    `${n(POPULATION.NET_CONFIRMED)} net-complete`,
    `${n(POPULATION.GROSS_ONLY)} gross-only`,
  ]
  if (counts[POPULATION.ACCOUNTING_PENDING]) parts.push(`${n(POPULATION.ACCOUNTING_PENDING)} accounting-pending`)
  if (counts[POPULATION.ACCOUNTING_ERROR]) parts.push(`${n(POPULATION.ACCOUNTING_ERROR)} accounting-error`)
  if (counts[POPULATION.SIMULATION]) parts.push(`${n(POPULATION.SIMULATION)} simulated`)
  if (counts[POPULATION.CANCELLED]) parts.push(`${n(POPULATION.CANCELLED)} cancelled`)
  return parts.join(' | ')
}
