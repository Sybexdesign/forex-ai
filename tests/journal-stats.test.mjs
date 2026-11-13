// tests/journal-stats.test.mjs
// Phase 4.2D — Journal statistics must use the same scoped populations as the
// Dashboard, so two adjacent screens cannot report different P&L.
//
// Covers: simulation/cancelled exclusion from Journal figures, missing money
// never coerced to zero, NET only when every execution is net-complete,
// provisional gross basis when it is not, profit factor with no losses,
// equity-curve anchoring, pair/streak scoping, denominator disclosure.
// Run: npm run test:journal-stats
import assert from 'node:assert/strict'
import { buildJournalStats, realisedValue, JOURNAL_STATS_VERSION } from '../lib/journal-stats.mjs'
import { POPULATION } from '../lib/analytics-scope.mjs'

const netRow = (o = {}) => ({
  broker_ticket: '5001', pair: 'XAUUSD', pl_usd: 100, commission: -3, swap: -1,
  net_realised_pnl: 96, accounting_complete: true, trade_result: 'WIN',
  result: 'WIN', pips: 20, closed_at: '2026-11-01T10:00:00Z', ...o,
})
const grossRow = (o = {}) => ({
  broker_ticket: '5002', pair: 'XAUUSD', pl_usd: 50, commission: null, swap: null,
  net_realised_pnl: null, accounting_complete: false,
  accounting_missing: ['commission', 'swap'], trade_result: 'WIN', result: 'WIN',
  pips: 10, closed_at: '2026-11-01T11:00:00Z', ...o,
})
const simRow = (o = {}) => ({
  id: 'sim1', pair: 'EURUSD', pl_usd: 9999, result: 'WIN', trade_status: 'CLOSED',
  closed_at: '2026-11-01T12:00:00Z', ...o,
})

// ── A — the exact JournalPage failure this replaces ─────────────────────────
{
  // Provenance: JournalPage computed
  //   closedTrades = trades.filter(t => t.result && t.result !== 'OPEN')
  // and then summed `(t.pl_usd || 0)` over them. A ticket-less simulation row
  // with a 9,999 "profit" was counted as a real win. Reproduce the old maths
  // first, so the regression is pinned to observed behaviour, not to opinion.
  const trades = [
    netRow(),
    grossRow(),
    simRow(),
    { id: 'cn1', broker_ticket: '5004', pair: 'XAUUSD', pl_usd: null, result: 'CANCELLED', closed_at: '2026-11-01T13:00:00Z' },
  ]
  const oldClosed = trades.filter((t) => t.result && t.result !== 'OPEN')
  const oldWins = oldClosed.filter((t) => t.result === 'WIN')
  const oldWinRate = oldWins.length / oldClosed.length
  const oldGrossProfit = oldWins.reduce((s, t) => s + Math.max(0, t.pl_usd || 0), 0)

  assert.equal(oldGrossProfit, 10149, 'A: old formula counted the 9,999 simulation as profit')
  assert.equal(oldWinRate, 0.75, 'A: old denominator included the cancelled row')

  const j = buildJournalStats(trades, { startingBalance: 10000 })
  assert.equal(j.n, 2, 'A: only the two broker executions are counted')
  assert.equal(j.net, 146, 'A: 96 net-confirmed + 50 gross-only, simulation excluded')
  assert.equal(j.winRate, 100, 'A: simulation and cancelled rows leave the denominator')
  assert.equal(j.counts[POPULATION.SIMULATION], 1, 'A: the simulation is still counted, not silently deleted')
  assert.equal(j.counts[POPULATION.CANCELLED], 1, 'A: cancelled is disclosed')
  assert.ok(!JSON.stringify(j).includes('9999'), 'A: the simulation value appears in no reported figure')
  console.log('PASS A: Journal figures exclude simulation/cancelled rows (was 10,149 gross / 75% win rate)')
}

// ── B — a missing result is unknown, not a breakeven ────────────────────────
{
  // `pl_usd || 0` would turn this row into a 0 P&L breakeven and halve the win
  // rate. It must leave the money figures entirely instead.
  const pending = {
    id: 'p1', broker_ticket: '5003', pair: 'XAUUSD', pl_usd: null,
    net_realised_pnl: null, accounting_complete: null, result: 'CLOSED',
    closed_at: '2026-11-02T10:00:00Z',
  }
  const j = buildJournalStats([netRow(), pending], { startingBalance: 10000 })

  assert.equal(j.counts[POPULATION.ACCOUNTING_PENDING], 1, 'B: closed-with-no-money is PENDING')
  assert.equal(j.n, 1, 'B: pending row contributes no P&L observation')
  assert.equal(j.net, 96, 'B: total is 96, not 96+0')
  assert.equal(j.winRate, 100, 'B: win rate is not 50% from averaging a missing value as 0')
  assert.equal(j.basis, 'GROSS', 'B: one non-net execution makes the whole set provisional')
  assert.equal(j.netComplete, false, 'B: and it may not be called net')
  console.log('PASS B: a missing P&L is excluded, never averaged in as a breakeven')
}


// ── C — NET only when every genuine execution is net-complete ───────────────
{
  const trades = [
    netRow(),
    netRow({ broker_ticket: '5006', pl_usd: -50, commission: -2, swap: 0, net_realised_pnl: -52, trade_result: 'LOSS', result: 'LOSS', closed_at: '2026-11-01T12:00:00Z' }),
  ]
  const j = buildJournalStats(trades, { startingBalance: 10000 })

  assert.equal(j.basis, 'NET', 'C: every execution is net-derived')
  assert.equal(j.netComplete, true, 'C: so the figures may be labelled net')
  assert.equal(j.n, 2, 'C: two executions')
  assert.equal(j.net, 44, 'C: uses net_realised_pnl (96 + -52), not gross pl_usd (100 + -50)')
  assert.equal(j.winRate, 50, 'C: one win, one loss')
  assert.equal(j.profitFactor, 1.8462, 'C: gross win 96 / gross loss 52')
  console.log('PASS C: net figures come from net_realised_pnl, and gross is never relabelled')
}

// ── D — profit factor with no losses is undefined, not infinite ─────────────
{
  const j = buildJournalStats(
    [netRow(), netRow({ broker_ticket: '5007', closed_at: '2026-11-01T11:30:00Z' })],
    { startingBalance: 10000 },
  )
  assert.equal(j.losses, 0, 'D: no losing executions')
  assert.equal(j.profitFactor, null, 'D: profit factor is null, not Infinity and not 0')
  assert.equal(j.streaks.maxWin, 2, 'D: two consecutive winning executions')
  console.log('PASS D: profit factor is undefined without losses')
}

// ── E — the equity curve contains only executions ──────────────────────────
{
  const trades = [
    grossRow({ closed_at: '2026-11-03T10:00:00Z' }),
    netRow({ closed_at: '2026-11-01T10:00:00Z' }),
    simRow({ closed_at: '2026-11-02T10:00:00Z' }),
  ]
  const j = buildJournalStats(trades, { startingBalance: 10000 })

  assert.equal(j.equityCurve.length, 2, 'E: the simulation contributes no curve point')
  assert.equal(j.equityCurve[j.equityCurve.length - 1].balance, 10000, 'E: curve is anchored to the supplied balance')
  assert.equal(j.equityBasis, 'GROSS', 'E: the curve is labelled with its basis')
  assert.deepEqual(j.equityCurve.map((p) => p.trade), [1, 2], 'E: points are numbered contiguously')
  console.log('PASS E: equity curve holds broker executions only and is anchored')
}

// ── F — pair, streak and disclosure scoping ────────────────────────────────
{
  const trades = [
    netRow({ pair: 'XAUUSD' }),
    grossRow({ pair: 'XAUUSD' }),
    simRow({ pair: 'EURUSD', pl_usd: 9999 }),
    netRow({ broker_ticket: '5008', pair: 'GBPUSD', pl_usd: -80, net_realised_pnl: -84, trade_result: 'LOSS', result: 'LOSS', closed_at: '2026-11-01T15:00:00Z' }),
  ]
  const j = buildJournalStats(trades, { startingBalance: 10000 })

  assert.equal(j.pairStats.length, 2, 'F: the simulated EURUSD row creates no pair entry')
  assert.equal(j.bestPair, 'XAUUSD', 'F: best pair by realised P&L')
  assert.equal(j.worstPair, 'GBPUSD', 'F: worst pair by realised P&L')
  assert.equal(j.streaks.maxLoss, 1, 'F: streak counts only executions')
  assert.match(j.disclosure, /3 broker executions/, 'F: disclosure states the execution count')
  assert.match(j.disclosure, /1 simulated/, 'F: disclosure states what was excluded')
  assert.equal(j.version, JOURNAL_STATS_VERSION, 'F: version is stamped for traceability')
  console.log('PASS F: per-pair, streak and disclosure figures are scoped')
}

// ── G — realisedValue is the single definition of "the P&L of this row" ─────
{
  assert.equal(realisedValue({ net_realised_pnl: 96, pl_usd: 100 }), 96, 'G: net wins when available')
  assert.equal(realisedValue({ net_realised_pnl: null, pl_usd: 50 }), 50, 'G: gross is the fallback')
  assert.equal(realisedValue({ net_realised_pnl: null, pl_usd: null }), null, 'G: null stays null')
  assert.equal(realisedValue({ net_realised_pnl: '', pl_usd: '' }), null, 'G: empty string is not zero')
  assert.equal(realisedValue({ net_realised_pnl: '96.5', pl_usd: 100 }), 96.5, 'G: numeric strings are accepted')
  assert.equal(realisedValue({}), null, 'G: an empty row has no value')
  console.log('PASS G: net-preferred, gross-fallback, never zero-filled')
}

console.log('\njournal-stats: all groups passed')
