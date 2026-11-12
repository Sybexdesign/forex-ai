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
 */
export function isGenuineExecution(trade = {}) {
  return str(trade.broker_ticket).length > 0
}

/**
 * Classify one trade row into exactly one population.
 *
 * Order matters and is deliberate: cancellation and open state are settled
 * first, simulation is checked before financial completeness (a mock row is not
 * an accounting failure), and "no money yet" is checked before "money but net".
 * Any ordering change would move rows between populations and silently alter
 * every reported figure.
 */
export function classifyTrade(trade = {}) {
  const genuine = isGenuineExecution(trade)
  const rawResult = str(trade.trade_result || trade.result).toUpperCase()
  const gross = num(trade.pl_usd)
  const netKnown = num(trade.net_realised_pnl)
  // accounting_complete is the broker-verified flag written by the derivation
  // trigger. `null` means "not applicable / never evaluated" (an OPEN row),
  // which is different from `false` ("evaluated and incomplete").
  const complete = trade.accounting_complete === true

  const base = {
    netPnl: null,
    grossPnl: gross,
    isGenuineExecution: genuine,
    contributesToNet: false,
    contributesToGross: false,
    version: ANALYTICS_SCOPE_VERSION,
  }

  if (CANCELLED_RESULTS.has(rawResult)) {
    return { ...base, population: POPULATION.CANCELLED, reason: 'cancelled_or_rejected_before_execution' }
  }

  if (rawResult === 'OPEN' || str(trade.trade_status).toUpperCase() === 'OPEN') {
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
  const flaggedError = str(trade.accounting_status).toUpperCase() === 'ERROR'
    || missing.some((m) => /error|invalid/i.test(String(m)))
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

  return {
    classified,
    buckets,
    counts,
    totalRows: classified.length,
    genuineExecutions: genuine,
    version: ANALYTICS_SCOPE_VERSION,
  }
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
