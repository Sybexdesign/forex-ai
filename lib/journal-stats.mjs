/**
 * SybexForexAI — JOURNAL STATISTICS (Phase 4.2D)
 *
 * WHY THIS EXISTS
 * `components/pages/JournalPage.tsx` still computed its statistics exactly the
 * way `DashboardPage` did before Phase 4.2C fixed it:
 *
 *     closedTrades = trades.filter(t => t.result && t.result !== 'OPEN')
 *     winRate      = wins.length / closedTrades.length
 *     profitFactor = Σ max(0, pl_usd||0) / |Σ min(0, pl_usd||0)|
 *     equity       = bal += (t.pl_usd || 0)
 *
 * Three defects, identical in kind to the Dashboard's, survived there:
 *
 *   1. `result !== 'OPEN'` keeps CANCELLED rows and ticket-less simulation rows
 *      in the denominators. On production data that is 95 simulated and 15
 *      cancelled rows against 14 genuine executions — the journal was mostly
 *      reporting a model, not a broker account.
 *   2. `pl_usd || 0` turns an unknown result into a breakeven.
 *   3. Gross-only rows (commission/swap not yet confirmed) were presented as
 *      profit with no indication that the cost terms are missing.
 *
 * So the two screens would have disagreed: the Dashboard labelled its figures
 * GROSS and disclosed exclusions, while the Journal showed a bigger, unlabelled
 * number computed over a population that includes fiction. Two contradictory
 * P&L figures on adjacent screens is worse than one wrong figure.
 *
 * This module returns journal-shaped statistics computed from ONE explicit
 * population, with the basis (NET or GROSS) stamped on the result so the page
 * cannot present gross as net. Arithmetic is delegated to
 * `lib/analytics-metrics.mjs`; classification to `lib/analytics-scope.mjs`.
 *
 * WHAT THIS MODULE DELIBERATELY DOES NOT DO
 * It does not feed any trading decision. The order-gating inputs
 * (`todayPL` in `components/AppShell.tsx`, the prop-firm guard in
 * `app/api/orders/route.ts`) are intentionally untouched: changing them would
 * change when the bot is allowed to trade, which needs its own sign-off.
 */

import {
  POPULATION,
  partitionTrades,
  describeScope,
  ANALYTICS_SCOPE_VERSION,
} from './analytics-scope.mjs'
import { computeStats } from './analytics-metrics.mjs'

export const JOURNAL_STATS_VERSION = 'journal_stats_v1'

/** Matches analytics-metrics.mjs: |x| <= EPS is a breakeven, not a win. */
const EPS = 0.01

/**
 * Null-safe number. `Number(null)` is 0 and `Number('')` is 0, so a plain
 * Number.isFinite check would silently treat a missing result as breakeven.
 */
function num(v) {
  if (v === null || v === undefined || v === '') return null
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : null
}

function r2(n) { return Number.isFinite(n) ? Math.round(n * 100) / 100 : null }
function toPct(ratio) { return ratio === null || ratio === undefined ? null : Math.round(ratio * 1000) / 10 }

export const CANCELLED_RESULTS = new Set(['CANCELLED', 'REJECTED', 'CANCELED'])

/**
 * The best honest realised value for ONE genuine execution.
 *
 * Net when the broker confirmed a complete cost breakdown, otherwise the gross
 * figure. Returns null when neither exists — a row with no money is unknown,
 * not zero.
 */
export function realisedValue(trade = {}) {
  const net = num(trade.net_realised_pnl)
  if (net !== null) return net
  return num(trade.pl_usd)
}

/** Row result, tolerating the `trade_result`/`result` column split. */
function rowResult(trade = {}) {
  return String(trade.trade_result || trade.result || '').trim().toUpperCase()
}


/**
 * Journal statistics for a user's trade rows.
 *
 * @param {Array<object>} trades
 * @param {{ startingBalance?: number }} [opts]
 */
export function buildJournalStats(trades = [], opts = {}) {
  const part = partitionTrades(trades)
  const netRows = part.buckets[POPULATION.NET_CONFIRMED] || []
  const grossRows = part.buckets[POPULATION.GROSS_ONLY] || []
  const pendingRows = part.buckets[POPULATION.ACCOUNTING_PENDING] || []

  // Executions with a broker ticket. Everything else stays out of the
  // statistics but is still counted in `disclosure` so nothing is hidden.
  const genuineRows = [...netRows, ...grossRows, ...pendingRows]

  const netComplete = part.genuineExecutions > 0
    && part.counts[POPULATION.NET_CONFIRMED] === part.genuineExecutions

  // A figure may only be called NET when every genuine execution is net-derived.
  // Otherwise the whole set is GROSS-provisional, including the subset that
  // happens to be net-complete — mixing bases inside one sum would produce a
  // number that exists nowhere.
  const basis = netComplete ? 'NET' : 'GROSS'

  const netStats = computeStats(netRows.map((t) => num(t.net_realised_pnl)), 'NET')
  const grossStats = computeStats(grossRows.map((t) => num(t.pl_usd)), 'GROSS')
  const headline = netComplete
    ? netStats
    : computeStats(genuineRows.map(realisedValue).filter((v) => v !== null), 'GROSS')

  // ─── Chronology ────────────────────────────────────────────────────────────
  const ordered = [...genuineRows].sort(
    (a, b) => new Date(a.closed_at || 0).getTime() - new Date(b.closed_at || 0).getTime(),
  )
  const valued = ordered
    .map((t) => ({ row: t, value: realisedValue(t) }))
    .filter((x) => x.value !== null)

  // ─── Pip statistics (a different dimension from money: decided rows only) ──
  const decidedWins = genuineRows.filter((t) => rowResult(t) === 'WIN' && num(t.pips) !== null)
  const decidedLosses = genuineRows.filter((t) => rowResult(t) === 'LOSS' && num(t.pips) !== null)
  const avgWinPips = decidedWins.length
    ? decidedWins.reduce((s, t) => s + Math.abs(num(t.pips)), 0) / decidedWins.length
    : null
  const avgLossPips = decidedLosses.length
    ? decidedLosses.reduce((s, t) => s + Math.abs(num(t.pips)), 0) / decidedLosses.length
    : null

  // ─── Per-pair ─────────────────────────────────────────────────────────────
  const pairMap = {}
  for (const t of genuineRows) {
    const key = String(t.pair || 'UNKNOWN').replace('/', '')
    if (!pairMap[key]) pairMap[key] = { pair: key, wins: 0, losses: 0, n: 0, pl: 0 }
    const p = pairMap[key]
    p.n += 1
    const v = realisedValue(t)
    if (v !== null) p.pl += v
    const res = rowResult(t)
    if (res === 'WIN') p.wins += 1
    else if (res === 'LOSS') p.losses += 1
  }
  const pairStats = Object.values(pairMap)
    .map((p) => ({ ...p, pl: r2(p.pl) }))
    .sort((a, b) => b.pl - a.pl)

  // ─── Streaks (money sign, consistent with winRate above) ──────────────────
  let curWin = 0, curLoss = 0, maxWin = 0, maxLoss = 0
  for (const { value } of valued) {
    if (value > EPS) { curWin += 1; curLoss = 0; if (curWin > maxWin) maxWin = curWin }
    else if (value < -EPS) { curLoss += 1; curWin = 0; if (curLoss > maxLoss) maxLoss = curLoss }
  }

  // ─── Equity curve ─────────────────────────────────────────────────────────
  // Anchored so the final point equals the supplied balance. Mixing populations
  // here (as the old code did) produced a curve shape that never existed at the
  // broker.
  const startingBalance = num(opts.startingBalance)
  const anchor = startingBalance === null ? 0 : startingBalance
  const total = valued.reduce((s, x) => s + x.value, 0)
  let bal = anchor - total
  const equityCurve = valued.map((x, i) => {
    bal += x.value
    return { trade: i + 1, balance: r2(bal), pl: x.value }
  })

  return {
    version: JOURNAL_STATS_VERSION,
    scopeVersion: ANALYTICS_SCOPE_VERSION,

    /** 'NET' only when every genuine execution is net-derived. */
    basis,
    netComplete,

    /** Headline money figures for the population above. */
    n: headline.n,
    net: headline.net,
    winRate: toPct(headline.winRate),
    profitFactor: headline.profitFactor,
    expectancy: headline.expectancy,
    wins: headline.wins ?? 0,
    losses: headline.losses ?? 0,
    breakevens: headline.breakevens ?? 0,
    largestWin: headline.largestWin,
    largestLoss: headline.largestLoss,
    maxDrawdown: headline.maxDrawdown,

    avgWinPips: avgWinPips === null ? null : r2(avgWinPips),
    avgLossPips: avgLossPips === null ? null : r2(avgLossPips),

    pairStats,
    bestPair: pairStats.length ? pairStats[0].pair : null,
    worstPair: pairStats.length ? pairStats[pairStats.length - 1].pair : null,
    streaks: { maxWin, maxLoss },
    equityCurve,
    equityBasis: basis,

    /** Rows the page may use for non-financial views (rules, notes, table). */
    genuineRows,

    counts: part.counts,
    totalRows: part.totalRows,
    genuineExecutions: part.genuineExecutions,
    disclosure: describeScope(part.counts),
    excluded: {
      simulations: part.counts[POPULATION.SIMULATION],
      cancelled: part.counts[POPULATION.CANCELLED],
      open: part.counts[POPULATION.OPEN],
      accountingPending: part.counts[POPULATION.ACCOUNTING_PENDING],
      accountingError: part.counts[POPULATION.ACCOUNTING_ERROR],
    },
  }
}
