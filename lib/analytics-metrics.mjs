/**
 * SybexForexAI — SCOPED ANALYTICS METRICS (Phase 4.2C)
 *
 * Every figure this module returns is computed from an EXPLICIT population.
 * It will not average a missing value as zero, and it will not put a gross-only
 * row into a net statistic. When a metric cannot be computed honestly from the
 * supplied population it returns `null` plus a reason, never a plausible-looking
 * number.
 */

import {
  POPULATION,
  partitionTrades,
  describeScope,
  ANALYTICS_SCOPE_VERSION,
} from './analytics-scope.mjs'

export const METRICS_VERSION = 'analytics_metrics_v1'
const EPS = 0.01

function r2(n) { return Number.isFinite(n) ? Math.round(n * 100) / 100 : null }
function r4(n) { return Number.isFinite(n) ? Math.round(n * 10000) / 10000 : null }

function median(xs) {
  if (!xs.length) return null
  const s = [...xs].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

/** Max drawdown of the cumulative P&L sequence, in absolute currency. */
function maxDrawdown(values = []) {
  let cum = 0, peak = 0, dd = 0
  for (const v of values) {
    cum += v
    if (cum > peak) peak = cum
    const d = peak - cum
    if (d > dd) dd = d
  }
  return r2(dd) ?? 0
}

/**
 * Core performance statistics for ONE homogeneous population.
 *
 * @param {number[]} values realised P&L in account currency, one per execution
 * @param {string} basis  'NET' | 'GROSS' — stamped on the result so a caller
 *                        cannot accidentally present gross output as net
 */
export function computeStats(values = [], basis = 'NET') {
  // `Number(null)` is 0 and `Number('')` is 0, so a naive Number.isFinite check
  // would silently treat a MISSING result as a breakeven and dilute every
  // statistic. Missing means missing.
  const v = values
    .filter((x) => x !== null && x !== undefined && x !== '' && Number.isFinite(Number(x)))
    .map(Number)
  if (!v.length) {
    return {
      basis, n: 0, net: null, grossWin: null, grossLoss: null,
      winRate: null, lossRate: null, profitFactor: null, expectancy: null,
      avg: null, median: null, largestWin: null, largestLoss: null,
      maxDrawdown: null, maxConsecutiveLosses: null,
      version: METRICS_VERSION,
    }
  }
  const wins = v.filter((x) => x > EPS)
  const losses = v.filter((x) => x < -EPS)
  const bes = v.filter((x) => Math.abs(x) <= EPS)
  const sum = v.reduce((a, b) => a + b, 0)
  const grossWin = wins.reduce((a, b) => a + b, 0)
  const grossLoss = Math.abs(losses.reduce((a, b) => a + b, 0))
  const decided = wins.length + losses.length

  // Profit factor is undefined (not infinite, not 0) when there are no losses
  // yet. Returning Infinity or 0 would both be lies of different signs.
  const profitFactor = grossLoss > 0 ? r4(grossWin / grossLoss) : null

  let streak = 0, maxStreak = 0
  for (const x of v) {
    if (x < -EPS) { streak++; if (streak > maxStreak) maxStreak = streak }
    else streak = 0
  }

  const winRate = decided ? wins.length / decided : null
  const lossRate = decided ? losses.length / decided : null
  const avgWin = wins.length ? grossWin / wins.length : 0
  const avgLoss = losses.length ? grossLoss / losses.length : 0
  const expectancy = decided ? winRate * avgWin - lossRate * avgLoss : null

  return {
    basis,
    n: v.length,
    net: r2(sum),
    grossWin: r2(grossWin),
    grossLoss: r2(grossLoss),
    wins: wins.length,
    losses: losses.length,
    breakevens: bes.length,
    winRate: winRate === null ? null : r4(winRate),
    lossRate: lossRate === null ? null : r4(lossRate),
    profitFactor,
    expectancy: r2(expectancy),
    avg: r2(sum / v.length),
    median: r2(median(v)),
    largestWin: wins.length ? r2(Math.max(...wins)) : null,
    largestLoss: losses.length ? r2(Math.min(...losses)) : null,
    maxDrawdown: maxDrawdown(v),
    maxConsecutiveLosses: maxStreak,
    version: METRICS_VERSION,
  }
}

/**
 * Build the full scoped analytics block for a trade array.
 *
 * NET figures come ONLY from POPULATION.NET_CONFIRMED.
 * GROSS figures come ONLY from POPULATION.GROSS_ONLY (and are labelled GROSS).
 * Everything else is counted and disclosed but contributes to no P&L figure.
 */
export function buildScopedAnalytics(trades = []) {
  const part = partitionTrades(trades)
  const netRows = part.buckets[POPULATION.NET_CONFIRMED]
  const grossRows = part.buckets[POPULATION.GROSS_ONLY]

  const net = computeStats(netRows.map((t) => Number(t.net_realised_pnl)), 'NET')
  // Gross-only rows have no net_realised_pnl by construction, so pl_usd is the
  // only honest number available for them.
  const gross = computeStats(grossRows.map((t) => Number(t.pl_usd)), 'GROSS')

  return {
    scope: {
      counts: part.counts,
      totalRows: part.totalRows,
      genuineExecutions: part.genuineExecutions,
      disclosure: describeScope(part.counts),
      version: ANALYTICS_SCOPE_VERSION,
    },
    /** Confirmed net performance. Safe to present as net profitability. */
    net: { ...net, population: POPULATION.NET_CONFIRMED, confirmed: true },
    /** Provisional directional performance. MUST be labelled gross. */
    gross: { ...gross, population: POPULATION.GROSS_ONLY, confirmed: false },
    /** True only when every genuine execution is net-complete and there is at
     *  least one. Drives whether the UI is allowed to say "net". */
    netComplete: part.genuineExecutions > 0
      && part.counts[POPULATION.NET_CONFIRMED] === part.genuineExecutions,
    excluded: {
      simulations: part.counts[POPULATION.SIMULATION],
      cancelled: part.counts[POPULATION.CANCELLED],
      open: part.counts[POPULATION.OPEN],
      accountingPending: part.counts[POPULATION.ACCOUNTING_PENDING],
      accountingError: part.counts[POPULATION.ACCOUNTING_ERROR],
    },
    version: METRICS_VERSION,
  }
}

/**
 * Equity curve restricted to one population. Mixing populations in one curve
 * produces a shape that never existed at the broker.
 */
export function scopedEquityCurve(trades = [], startingBalance = 0, population = POPULATION.NET_CONFIRMED) {
  const part = partitionTrades(trades)
  const rows = part.buckets[population] || []
  const key = population === POPULATION.NET_CONFIRMED ? 'net_realised_pnl' : 'pl_usd'
  const basis = population === POPULATION.NET_CONFIRMED ? 'NET' : 'GROSS'
  const sorted = [...rows]
    .filter((t) => t.closed_at && Number.isFinite(Number(t[key])))
    .sort((a, b) => new Date(a.closed_at).getTime() - new Date(b.closed_at).getTime())
  if (!sorted.length) return { points: [], basis, population }
  const total = sorted.reduce((s, t) => s + Number(t[key]), 0)
  let bal = startingBalance - total
  const points = sorted.map((t, i) => {
    bal += Number(t[key])
    return { i, day: new Date(t.closed_at).toISOString().slice(0, 10), balance: r2(bal) }
  })
  return { points, basis, population }
}

