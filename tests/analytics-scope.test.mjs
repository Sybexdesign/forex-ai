// tests/analytics-scope.test.mjs
// Phase 4.2C — population scoping for financial analytics.
//
// Covers: net vs gross separation, missing money never coerced to zero,
// simulation exclusion, cancelled/open exclusion, pending/error populations,
// profit factor with no losses, expectancy, drawdown, denominator disclosure.
// Run: npm run test:analytics-scope
import assert from 'node:assert/strict'
import {
  POPULATION, classifyTrade, partitionTrades, describeScope, isGenuineExecution,
} from '../lib/analytics-scope.mjs'
import { computeStats, buildScopedAnalytics } from '../lib/analytics-metrics.mjs'

const netRow = (o = {}) => ({
  broker_ticket: '5001', pl_usd: 100, commission: -3, swap: -1,
  net_realised_pnl: 96, accounting_complete: true, trade_result: 'WIN',
  result: 'WIN', closed_at: '2026-11-01T10:00:00Z', ...o,
})
const grossRow = (o = {}) => ({
  broker_ticket: '5002', pl_usd: 50, commission: null, swap: null,
  net_realised_pnl: null, accounting_complete: false, accounting_missing: ['commission', 'swap'],
  trade_result: 'WIN', result: 'WIN', closed_at: '2026-11-01T11:00:00Z', ...o,
})

// ── A — the exact production failure this replaces ──────────────────────────
{
  // Provenance: DashboardPage used `t.pl_usd || 0`, so a CLOSED row with no
  // money contributed 0 and a ticket-less simulation row contributed its
  // pretend P&L. Neither is a trading result.
  const trades = [
    netRow(),
    grossRow(),
    { id: 'sim1', pl_usd: 9999, result: 'WIN', trade_status: 'CLOSED' }, // no ticket
    { id: 'cl1', pl_usd: null, result: 'CLOSED', trade_status: 'CLOSED', broker_ticket: '5003' },
    { id: 'cn1', pl_usd: null, result: 'CANCELLED', broker_ticket: '5004' },
    { id: 'op1', pl_usd: null, result: 'OPEN', broker_ticket: '5005' },
  ]
  const a = buildScopedAnalytics(trades)

  assert.equal(a.scope.totalRows, 6, 'A: every row is classified, none dropped')
  assert.equal(a.scope.counts[POPULATION.NET_CONFIRMED], 1, 'A: one net-complete')
  assert.equal(a.scope.counts[POPULATION.GROSS_ONLY], 1, 'A: one gross-only')
  assert.equal(a.scope.counts[POPULATION.SIMULATION], 1, 'A: ticket-less row is SIMULATION')
  assert.equal(a.scope.counts[POPULATION.ACCOUNTING_PENDING], 1, 'A: CLOSED with no money is PENDING, not a loss')
  assert.equal(a.scope.counts[POPULATION.CANCELLED], 1, 'A: cancelled is not a loss')
  assert.equal(a.scope.counts[POPULATION.OPEN], 1, 'A: open is not a result')

  // The 9,999 "profit" from a simulated row must not appear anywhere.
  assert.equal(a.net.net, 96, 'A: NET uses net_realised_pnl of the single net-complete row')
  assert.equal(a.gross.net, 50, 'A: GROSS uses pl_usd of the single gross-only row')
  // netComplete is "EVERY genuine execution is net-complete". Here 1 of 3 is
  // (1 net + 1 gross + 1 pending), so the platform must not claim net yet.
  assert.equal(a.netComplete, false, 'A: netComplete is false while any execution is not net-complete')
  console.log('PASS A: net, gross, simulation, pending, cancelled and open are separated')
}

// ── B — a gross-only row can never reach a net metric ───────────────────────
{
  const a = buildScopedAnalytics([grossRow(), grossRow({ broker_ticket: '5003' })])
  assert.equal(a.net.n, 0, 'B: no net-complete rows means an EMPTY net population')
  assert.equal(a.net.winRate, null, 'B: net win rate is null, not 100%')
  assert.equal(a.netComplete, false, 'B: netComplete is false')
  assert.equal(a.gross.n, 2, 'B: both rows are still reported, as gross')
  assert.equal(a.gross.basis, 'GROSS', 'B: gross population is stamped GROSS')
  assert.match(a.scope.disclosure, /gross-only/, 'B: disclosure names the gross population')
  console.log('PASS B: gross-only rows never become net figures')
}

// ── C — missing money is NULL, never 0 ──────────────────────────────────────
{
  const v = classifyTrade({ broker_ticket: '9', pl_usd: null, result: 'CLOSED' })
  assert.equal(v.population, POPULATION.ACCOUNTING_PENDING, 'C: no money -> PENDING')
  assert.equal(v.grossPnl, null, 'C: gross is null, not 0')
  assert.equal(v.contributesToNet, false, 'C: contributes to nothing')
  assert.equal(v.contributesToGross, false, 'C: a missing number is not a zero')

  const s = computeStats([null, undefined, ''], 'NET')
  assert.equal(s.n, 0, 'C: null/undefined/blank entries are not counted as breakevens')
  console.log('PASS C: missing financial values are never coerced to zero')
}

// ── D — profit factor is undefined without losses, not Infinity or 0 ────────
{
  const onlyWins = computeStats([10, 20, 30], 'NET')
  assert.equal(onlyWins.winRate, 1, 'D: win rate 100%')
  assert.equal(onlyWins.profitFactor, null, 'D: PF undefined with no losses')

  const mixed = computeStats([100, -50, -25], 'NET')
  assert.equal(mixed.profitFactor, 1.3333, 'D: PF = 100 / 75')
  assert.equal(mixed.expectancy, 8.33, 'D: expectancy = (1/3*100) - (2/3*75) rounded')
  assert.equal(mixed.net, 25, 'D: net sums signed values')
  assert.equal(mixed.largestLoss, -50, 'D: largest loss keeps its sign')
  assert.equal(mixed.maxDrawdown, 75, 'D: drawdown from the peak after the first win')
  console.log('PASS D: profit factor, expectancy and drawdown behave on small samples')
}

// ── E — breakeven is not silently a win ─────────────────────────────────────
{
  const s = computeStats([0.0, 10, -10], 'NET')
  assert.equal(s.breakevens, 1, 'E: zero-P&L row counted as breakeven')
  assert.equal(s.wins, 1, 'E: wins exclude breakeven')
  assert.equal(s.losses, 1, 'E: losses exclude breakeven')
  assert.equal(s.winRate, 0.5, 'E: win rate is over DECIDED trades only')
  console.log('PASS E: breakeven trades are excluded from the win/loss rate')
}

// ── F — disclosure is human readable and always states the denominator ─────
{
  const part = partitionTrades([netRow(), grossRow(), { id: 's', pl_usd: 1, result: 'WIN' }])
  const d = describeScope(part.counts)
  assert.match(d, /2 broker executions/, 'F: executions counted, simulations excluded')
  assert.match(d, /1 net-complete/, 'F: net-complete count')
  assert.match(d, /1 gross-only/, 'F: gross-only count')
  assert.match(d, /1 simulated/, 'F: simulation count surfaced')
  console.log('PASS F: describeScope states broker executions, net, gross and simulated')
}

// ── G — a ticket-less row is never a genuine execution ─────────────────────
{
  assert.equal(isGenuineExecution({ broker_ticket: '' }), false, 'G: empty ticket is not genuine')
  assert.equal(isGenuineExecution({ broker_ticket: '  ' }), false, 'G: whitespace ticket is not genuine')
  assert.equal(isGenuineExecution({ broker_ticket: '123' }), true, 'G: real ticket is genuine')
  console.log('PASS G: broker ticket is the sole test of a genuine execution')
}

// ── H — an accounting error is quarantined, not averaged ───────────────────
// Phase 4.2.1 (M-3): this group used to assert the population via
// `accounting_status: 'ERROR'` — a column that does not exist in `trades`
// (selecting it returns HTTP 400), so the assertion was proving dead code. The
// contract is now `accounting_missing`, the column Phase 4.1's derivation trigger
// actually writes.
{
  const v = classifyTrade({
    broker_ticket: '77', pl_usd: 10, accounting_complete: false,
    accounting_missing: ['error'], result: 'WIN',
  })
  assert.equal(v.population, POPULATION.ACCOUNTING_ERROR, 'H: broker-flagged error is its own population')
  assert.equal(v.contributesToNet, false, 'H: never contributes to net')
  assert.equal(v.contributesToGross, false, 'H: and not to gross either')

  const invalid = classifyTrade({
    broker_ticket: '78', pl_usd: 10, accounting_complete: false,
    accounting_missing: ['invalid_broker_value'], result: 'WIN',
  })
  assert.equal(invalid.population, POPULATION.ACCOUNTING_ERROR, 'H: invalid broker value is an accounting error')

  // The phantom column must have NO effect. If it did, the classifier would be
  // reading a field that cannot exist in the row.
  const phantom = classifyTrade({
    broker_ticket: '79', pl_usd: 10, accounting_complete: false,
    accounting_status: 'ERROR', result: 'WIN',
  })
  assert.equal(phantom.population, POPULATION.GROSS_ONLY, 'H: accounting_status is not read — costs are merely unconfirmed')
  console.log('PASS H: accounting errors are quarantined out of every P&L figure')
}

console.log('\nanalytics-scope: all groups passed')

