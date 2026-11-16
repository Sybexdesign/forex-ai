// tests/phase421-remediation.test.mjs
// ─────────────────────────────────────────────────────────────────────────────
// Phase 4.2.1 — consolidated remediation regression suite.
//
// One group per audited defect (C-1, C-2, H-1…H-4, M-1…M-6, L-1…L-4), per patch
// (P-A…P-J) and per additional finding (A-1…A-9). Every group states the DEFECT
// it freezes, so a future edit that reintroduces the behaviour fails here with
// the audit ID rather than with a mystery numeric diff.
//
// Two kinds of assertion, used deliberately:
//   * RUNTIME — the module under test is imported and executed. Preferred: the
//     test proves behaviour, not the presence of a string.
//   * STATIC  — the file is read and pattern-checked. Used only where the code
//     cannot run in Node (Next route handlers that construct a Supabase client,
//     React components, TS needing the Next compiler, SQL, MQL5). A static check
//     is weaker evidence, so each one is written to fail when the specific defect
//     returns, not when formatting changes.
//
// Run: npm run test:phase421
// ─────────────────────────────────────────────────────────────────────────────
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import {
  BROKER_TICKET_KIND,
  EXECUTION_POPULATIONS,
  POPULATION,
  brokerTicketKind,
  classifyTrade,
  closedExecutions,
  isGenuineExecution,
  isMt5TicketBacked,
  isUuidRef,
  partitionTrades,
  sumKnownPL,
} from '../lib/analytics-scope.mjs'
import { DEFAULT_LIMIT, MAX_LIMIT, describeWindow, parseLimit } from '../lib/api-query.mjs'
import {
  DEFAULT_RECON_WARN_HOURS,
  MAX_RECON_WARN_HOURS,
  MIN_RECON_WARN_HOURS,
  STRICT_RECON_WARN_HOURS,
  reconFailHours,
  reconStatus,
  reconWarnHours,
} from '../lib/integrity-thresholds.mjs'
import { authoriseCronRequest, timingSafeEqual } from '../lib/cron-auth.mjs'

const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8')

/** Source lines that are not comments — so a comment cannot fail a code check. */
const codeLines = (src) => src
  .split('\n')
  .filter((l) => {
    const t = l.trim()
    return t !== '' && !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*')
  })

/** A broker execution row carrying a numeric MT5 ticket. */
const mt5 = (over = {}) => ({
  broker_ticket: '3454451953',
  result: 'WIN',
  trade_status: 'CLOSED',
  closed_at: '2026-11-13T09:00:00Z',
  pl_usd: 12.5,
  ...over,
})

// ─────────────────────────────────────────────────────────────────────────────
// C-1 — "No net P&L has ever been produced."
// The accounting gate must be impossible to bypass: a row without broker costs
// can NEVER be NET_CONFIRMED, however favourable its gross number looks.
// ─────────────────────────────────────────────────────────────────────────────
{
  // A perfect winner with no commission and no swap is still gross-only. This is
  // the exact production shape (1,284/1,284 rows), so if it ever classified as
  // net the platform would report profitability it cannot prove.
  const noCosts = classifyTrade(mt5({ pl_usd: 500, accounting_complete: null }))
  assert.equal(noCosts.population, POPULATION.GROSS_ONLY, 'C-1: a win without broker costs is gross-only')
  assert.equal(noCosts.contributesToNet, false, 'C-1: and must never reach a net figure')
  assert.equal(noCosts.netPnl, null, 'C-1: no invented net')

  // accounting_complete alone is not enough — the net VALUE must exist.
  const flagOnly = classifyTrade(mt5({ accounting_complete: true, net_realised_pnl: null }))
  assert.equal(flagOnly.contributesToNet, false, 'C-1: complete flag without a net value cannot contribute to net')

  // Net requires BOTH the broker verdict and a finite net value.
  const netOk = classifyTrade(mt5({
    accounting_complete: true, net_realised_pnl: 11.9, commission: -0.5, swap: -0.1, other_fees: 0,
  }))
  assert.equal(netOk.population, POPULATION.NET_CONFIRMED, 'C-1: complete costs + finite net is confirmed')
  assert.equal(netOk.contributesToNet, true, 'C-1: and only then contributes to net')
  assert.equal(netOk.netPnl, 11.9, 'C-1: the stored net value is used verbatim, never recomputed')

  // A non-finite net never contributes, whatever the flag says.
  const broken = classifyTrade(mt5({ accounting_complete: true, net_realised_pnl: 'NaN' }))
  assert.equal(broken.contributesToNet, false, 'C-1: a non-finite net never contributes')

  // The production proof (one v2 close reconciled against the broker) cannot be
  // fabricated locally — asserted as a limitation in the report, not as a pass.
  console.log('PASS C-1: the net gate cannot be bypassed without broker-confirmed costs')
}

// ─────────────────────────────────────────────────────────────────────────────
// C-2 — "The 10-minute reconciliation scheduler is blocked by a missing secret."
// Only the code half is testable here; the environment half is an owner action.
// ─────────────────────────────────────────────────────────────────────────────
{
  const headers = (h) => ({ get: (n) => h[n.toLowerCase()] ?? null })

  // 1. No secret configured, in production → DENY. That is the exact production
  //    state (36 x "CRON_SECRET not set on the worker").
  const unconfigured = authoriseCronRequest({
    headers: headers({}), searchParams: new URLSearchParams(), env: { NODE_ENV: 'production' },
  })
  assert.equal(unconfigured.ok, false, 'C-2: unconfigured production must deny')
  assert.equal(unconfigured.authMode, 'cron_secret_not_configured', 'C-2: and must say why')

  // 2. A forged cron header must never be sufficient — that was the old fallback.
  const forged = authoriseCronRequest({
    headers: headers({ 'x-vercel-cron': '1' }),
    searchParams: new URLSearchParams(),
    env: { NODE_ENV: 'production' },
  })
  assert.equal(forged.ok, false, 'C-2: a forgeable x-vercel-cron header cannot authorise')

  // 3. A wrong secret is rejected; no prefix or case trickery passes.
  const env = { NODE_ENV: 'production', CRON_SECRET: 'super-secret-value' }
  for (const wrong of ['super-secret-valu', 'super-secret-value2', 'SUPER-SECRET-VALUE', 'super']) {
    const r = authoriseCronRequest({ headers: headers({ authorization: `Bearer ${wrong}` }), env })
    assert.equal(r.ok, false, `C-2: wrong secret rejected (${wrong})`)
  }

  // 4. The correct secret is accepted over each supported transport.
  assert.equal(authoriseCronRequest({ headers: headers({ authorization: `Bearer ${env.CRON_SECRET}` }), env }).ok,
    true, 'C-2: Authorization bearer accepted')
  assert.equal(authoriseCronRequest({ headers: headers({ 'x-cron-secret': env.CRON_SECRET }), env }).ok,
    true, 'C-2: x-cron-secret accepted')
  assert.equal(authoriseCronRequest({ searchParams: new URLSearchParams({ secret: env.CRON_SECRET }), env }).ok,
    true, 'C-2: query fallback still works for a hand-typed call')

  // 5. Local development without a secret stays open — shipped behaviour, so a
  //    developer is not locked out of their own machine.
  const dev = authoriseCronRequest({ env: { NODE_ENV: 'development' } })
  assert.equal(dev.ok, true, 'C-2: development without a secret remains usable')
  assert.equal(dev.authMode, 'development_open', 'C-2: and is labelled as such')

  // 6. A configured secret is required even in development (no silent downgrade).
  assert.equal(authoriseCronRequest({ env: { NODE_ENV: 'development', CRON_SECRET: 'x' } }).ok,
    false, 'C-2: a configured secret is never optional')

  // 7. Timing-safe comparison behaves like equality, including length mismatch.
  assert.equal(timingSafeEqual('abc', 'abc'), true, 'C-2: equal strings compare equal')
  assert.equal(timingSafeEqual('abc', 'abd'), false, 'C-2: differing strings differ')
  assert.equal(timingSafeEqual('abc', 'abcd'), false, 'C-2: length mismatch is false, not an exception')

  // 8. Idempotency: the refresh merge-upserts on setup_key, so repeating it can
  //    neither duplicate nor delete derived rows.
  const refresh = read('app/api/outcome-reconciliation/refresh/route.ts')
  assert.match(refresh, /onConflict:\s*'setup_key'/, 'C-2: refresh upserts on setup_key')
  assert.ok(!/\.delete\(\)/.test(refresh), 'C-2: refresh never deletes rows')
  console.log('PASS C-2: refresh auth denies unconfigured production and accepts only the exact secret')
}

// ─────────────────────────────────────────────────────────────────────────────
// H-1 / A-1 — "Genuine closed trades classified as OPEN."
// Hard close evidence must outrank the stale legacy status flag.
// ─────────────────────────────────────────────────────────────────────────────
{
  // The production shape: a real close whose legacy trade_status was never
  // flipped. 36 loss rows and 14 win rows were invisible because of this.
  const staleWin = classifyTrade(mt5({ result: 'WIN', trade_status: 'OPEN', pl_usd: 298.79 }))
  assert.notEqual(staleWin.population, POPULATION.OPEN, 'H-1: a WIN with closed_at is not OPEN')
  assert.equal(staleWin.contributesToGross, true, 'H-1: its money counts')

  const staleLoss = classifyTrade(mt5({ result: 'LOSS', trade_status: 'OPEN', pl_usd: -40 }))
  assert.notEqual(staleLoss.population, POPULATION.OPEN, 'H-1: a LOSS with closed_at is not OPEN')
  assert.equal(staleLoss.contributesToGross, true, 'H-1: the loss is counted, not hidden')

  // No close evidence at all → still OPEN. The fix must not invent closes.
  assert.equal(classifyTrade({ broker_ticket: '1', result: 'OPEN', closed_at: null }).population,
    POPULATION.OPEN, 'H-1: no close evidence stays OPEN')
  assert.equal(classifyTrade({ broker_ticket: '1', result: 'OPEN', trade_status: 'OPEN', closed_at: null }).population,
    POPULATION.OPEN, 'H-1: stale OPEN + no close stays OPEN')

  // CLOSED with no money is ACCOUNTING_PENDING — unknown, never zero.
  const pending = classifyTrade({
    broker_ticket: '2', result: 'CLOSED', trade_status: 'CLOSED', closed_at: '2026-11-13T09:00:00Z', pl_usd: null,
  })
  assert.equal(pending.population, POPULATION.ACCOUNTING_PENDING, 'H-1: closed without money is pending, not zero')
  assert.equal(pending.contributesToGross, false, 'H-1: and contributes no fabricated zero')

  // A cancelled row is never a loss, whatever money it carries.
  assert.equal(classifyTrade(mt5({ result: 'CANCELLED', pl_usd: -12 })).population,
    POPULATION.CANCELLED, 'H-1: cancelled is not a loss')
  console.log('PASS H-1: close evidence outranks the stale status; nothing is invented')
}

// ─────────────────────────────────────────────────────────────────────────────
// GATE-1 — P-B alone would ENABLE trading on unknown data.
// `null > -100` is `true` in JS (null coerces to 0), so a null daily P&L read as
// "well above the limit". P-C is what makes P-B safe: both must ship together.
// ─────────────────────────────────────────────────────────────────────────────
{
  // The hazard, stated as executable evidence rather than as a comment.
  assert.equal(null > -100, true, 'GATE-1: null compares as 0, i.e. a "safe" day')
  assert.equal(null <= -100, false, 'GATE-1: and never trips a loss limit')

  const shell = read('components/AppShell.tsx')
  const analysis = read('components/pages/AnalysisPage.tsx')
  const indicators = read('lib/indicators.ts')

  // P-B: the client total is unknown-aware, not `|| 0`.
  assert.match(shell, /todayPL\s*:\s*number\s*\|\s*null/, 'GATE-1/P-B: AppShell types todayPL as number|null')
  const codeLinesLocal = codeLines(shell)
  assert.ok(!codeLinesLocal.some((l) => /pl_usd\s*\|\|\s*0/.test(l)),
    'GATE-1/P-B: AppShell never coerces a missing pl_usd to 0')

  // P-C: every consumer must test for a NUMBER before comparing it.
  assert.match(indicators, /typeof options\.todayPL === 'number' && Number\.isFinite\(options\.todayPL\)/,
    'GATE-1/P-C: the checklist refuses a non-finite todayPL')
  assert.match(analysis, /typeof\s+[A-Za-z0-9_.]*todayPL\s*===\s*'number'[\s\S]{0,40}isFinite/,
    'GATE-1/P-C: the client checklist mirrors the server predicate')

  // P-C must FAIL (checklist item false), not pass, when the value is unknown.
  assert.match(indicators, /const dailyLossOk\s*=\s*todayPLKnown &&/,
    'GATE-1/P-C: dailyLossOk requires a known value')
  console.log('PASS GATE-1: P-B cannot enable trading on unknown data because P-C gates the predicate')
}



// ─────────────────────────────────────────────────────────────────────────────
// H-2 / D8 / P-A — "The order-gating loss limit consumes unscoped pl_usd data."
// Only a real broker execution may move a live risk limit. A simulation win or a
// cancelled row must never do so — and one shared definition must decide, or the
// guard, the dashboard and the prop-firm page will drift apart.
// ─────────────────────────────────────────────────────────────────────────────
{
  const simulation = { id: 'a', pl_usd: -963.5, result: 'LOSS', closed_at: '2026-11-13T09:00:00Z' }
  const cancelled = mt5({ result: 'CANCELLED', pl_usd: -50 })
  const openRow = mt5({ result: 'OPEN', trade_status: 'OPEN', closed_at: null, pl_usd: null })
  const execution = mt5({ pl_usd: -20 })

  const scoped = closedExecutions([simulation, cancelled, openRow, execution])
  assert.equal(scoped.length, 1, 'P-A: exactly one row of four is a closed execution')
  assert.equal(scoped[0], execution, 'P-A: and it is the broker execution')
  assert.ok(!closedExecutions([simulation]).length, 'P-A: a -963.50 simulation row cannot reach a risk limit')
  assert.ok(!closedExecutions([cancelled]).length, 'P-A: a cancelled row cannot reach a risk limit')
  assert.ok(!closedExecutions([openRow]).length, 'P-A: a still-open row cannot reach a risk limit')

  // The unknown-aware sum: a missing value makes the TOTAL unknown, never a zero.
  assert.deepEqual(sumKnownPL([execution]), { pl: -20, known: 1, unknown: 0, rows: 1 }, 'P-A: known sum')
  assert.equal(sumKnownPL([execution, mt5({ pl_usd: null })]).pl, null, 'P-A: one unknown row makes the total unknown')
  assert.equal(sumKnownPL([mt5({ pl_usd: null })]).pl, null, 'P-A: an all-unknown day is unknown, not 0')
  assert.equal(sumKnownPL([]).pl, 0, 'P-A: no rows at all is a genuine zero')

  // The order route must use that shared definition, not a private filter.
  const orders = read('app/api/orders/route.ts')
  assert.match(orders, /import \{[^}]*closedExecutions[^}]*\} from '@\/lib\/analytics-scope\.mjs'/,
    'P-A: the order guard imports the shared scope definition')
  assert.match(orders, /function scopeRiskRows/, 'P-A: the guard scopes rows through one helper')
  assert.match(orders, /const executed = closedExecutions\(rows\)/, 'P-A: and that helper delegates')
  assert.match(orders, /const todayScope\s+= scopeRiskRows\(todayRes\.data \|\| \[\]\)/,
    'P-A: today is scoped by the shared definition')
  assert.match(orders, /const allTimeScope = scopeRiskRows\(allTimeRes\.data \|\| \[\]\)/,
    'P-A: all-time is scoped by the same definition')
  assert.match(orders, /code: 'DAILY_PL_UNKNOWN'/, 'P-A: an unknown day produces an explicit refusal code')
  assert.match(orders, /DAILY_PL_UNKNOWN/, 'P-A: the refusal is machine-readable, not a stack trace')
  assert.match(orders, /riskScope:/, 'P-A: the response discloses which rows the limit was computed over')

  // The old, unsafe shape must be gone from the risk path.
  const ordersCode = codeLines(orders)
  assert.ok(!ordersCode.some((l) => /pl_usd\s*\|\|\s*0/.test(l)),
    'P-A: no `pl_usd || 0` remains in the guard')

  console.log('PASS P-A / H-2: only broker executions move a live limit, and unknown blocks')
}

// ─────────────────────────────────────────────────────────────────────────────
// P-D — "Fail closed in the risk and prop-firm evaluators."
// `null <= -maxLoss` is false, so an unknown day used to PASS every limit.
// ─────────────────────────────────────────────────────────────────────────────
{
  const risk = read('lib/risk.ts')
  const propfirm = read('lib/propfirm.ts')

  assert.match(risk, /todayRealizedPL:\s*number \| null/, 'P-D: risk takes a nullable daily P&L')
  assert.match(risk, /const dailyPL = typeof todayRealizedPL === 'number' && Number\.isFinite\(todayRealizedPL\)/,
    'P-D: risk narrows to a number before comparing')
  assert.match(risk, /if \(dailyPL === null\) \{[\s\S]{0,400}allowed: false/,
    'P-D: risk BLOCKS when the daily P&L is unknown')

  assert.match(propfirm, /todayPL:\s*number \| null/, 'P-D: prop-firm takes a nullable daily P&L')
  assert.match(propfirm, /const dailyPLKnown = typeof todayPL === 'number' && Number\.isFinite\(todayPL\)/,
    'P-D: prop-firm narrows to a number before comparing')
  assert.match(propfirm, /dailyPLEvaluated:\s*dailyPLKnown/, 'P-D: the result says whether the rule was evaluated')
  assert.match(propfirm, /if \(!dailyPLKnown\) \{[\s\S]{0,200}blockReasons\.push/,
    'P-D: an unevaluated day is a BLOCK, not a pass')

  // The unguarded coercion must not come back.
  assert.ok(!/Math\.min\(0,\s*todayPL\)/.test(propfirm), 'P-D: no raw Math.min(0, null) remains')
  console.log('PASS P-D: an unknown daily P&L blocks instead of passing')
}


// ─────────────────────────────────────────────────────────────────────────────
// P-B — "Client daily P&L scope-aware and unknown-aware."
// ─────────────────────────────────────────────────────────────────────────────
{
  const shell = read('components/AppShell.tsx')
  assert.match(shell, /sumKnownPL\(closedExecutions\(todayTrades\)\)/,
    'P-B: today is computed from scoped rows through the unknown-aware sum')
  assert.match(shell, /const todayPL: number \| null = todayScope\.pl/, 'P-B: todayPL carries unknown as null')
  assert.match(shell, /todayPL === null \? '—'/, 'P-B: unknown renders as an em dash, not +0.00')
  assert.match(shell, /todayScope\.unknown/, 'P-B: the render says how many rows are unknown')
  // Win rate must not divide by "everything in the window" any more.
  assert.ok(!codeLines(shell).some((l) => /wins \/ trades\.length/.test(l)),
    'P-B: win rate no longer divides by every row')
  assert.match(shell, /decisiveExecutions/, 'P-B: win rate uses decisive executions')
  // The render sites consume the derived strings, so no stale comparison survives.
  assert.ok(!/todayPL >= 0/.test(shell.replace(/const todayPLColor[^\n]*\n/, '')),
    'P-B: no raw `todayPL >= 0` outside the null-guarded colour helper')
  console.log('PASS P-B: the client daily P&L is scoped, unknown-aware and honest on screen')
}

// ─────────────────────────────────────────────────────────────────────────────
// P-E — "The prop-firm page showed 0 % of the daily limit used when the day was
// unknown." An unevaluated rule must read UNKNOWN, never a calm zero.
// ─────────────────────────────────────────────────────────────────────────────
{
  const page = read('components/pages/PropFirmPage.tsx')
  assert.match(page, /import \{ closedExecutions, sumKnownPL \} from '@\/lib\/analytics-scope\.mjs'/,
    'P-E: the prop-firm page uses the shared definition')
  assert.match(page, /const todayPL: number \| null = sumKnownPL\(todayExecutions\)\.pl/,
    'P-E: todayPL is null when unknown')
  assert.match(page, /unevaluated=\{!status\.dailyPLEvaluated\}/, 'P-E: the daily bar is marked unevaluated')
  assert.match(page, /unevaluated \? 'UNKNOWN'/, 'P-E: and prints UNKNOWN rather than 0.00')
  assert.match(page, /not evaluated — today/, 'P-E: with a caption explaining why')
  assert.ok(!/todayPL \?\? 0/.test(page), 'P-E: no `?? 0` coercion of an unknown day')
  console.log('PASS P-E: an unevaluated prop-firm rule reads UNKNOWN, never a calm zero')
}

// ─────────────────────────────────────────────────────────────────────────────
// P-F — "Dashboard showed a missing result as a green +$0.00."
// ─────────────────────────────────────────────────────────────────────────────
{
  const dash = read('components/pages/DashboardPage.tsx')
  const dashCode = codeLines(dash)
  assert.ok(!dashCode.some((l) => /pl_usd \?\? 0/.test(l)),
    'P-F: no `pl_usd ?? 0` in any render path')
  // Phase 4.2.1 moved per-row rendering into components/RecentTradesTable.tsx, so
  // the em-dash contract is asserted there. The INTENT is unchanged and is now
  // stronger: the number comes from describeTradeRow(), which refuses to emit a
  // P&L at all when the accounting does not support one.
  const table = read('components/RecentTradesTable.tsx')
  assert.match(table, /v === null \|\| v === undefined \? '—' : currencySigned\(v, currency\)/,
    'P-F: unknown renders as an em dash in the trade table')
  assert.match(table, /An em dash means the broker has not reported that value — it is never\s*\n?\s*treated as zero\./,
    'P-F: the em dash explains itself')
  assert.ok(!/pl_usd \?\? 0/.test(table), 'P-F: no `pl_usd ?? 0` in the table either')
  assert.match(dash, /describeTradeRow/, 'P-F: rows are described by the shared classifier')
  console.log('PASS P-F: an unknown result is an em dash, not a fake break-even')
}

// ─────────────────────────────────────────────────────────────────────────────
// P-G — "Loss diagnostics invented 0R from a missing P&L."
// ─────────────────────────────────────────────────────────────────────────────
{
  const diag = read('app/api/loss-diagnostics/route.ts')
  assert.match(diag, /typeof row\.pl_usd === 'number' && Number\.isFinite\(row\.pl_usd\)/,
    'P-G: R requires a finite P&L')
  assert.match(diag, /&& R_DENOMINATOR > 0\s*\n\s*\? row\.pl_usd \/ R_DENOMINATOR\s*\n\s*: null/,
    'P-G: R is null when there is nothing to divide')
  assert.ok(!codeLines(diag).some((l) => /row\.pl_usd \?\? 0/.test(l)),
    'P-G: no `?? 0` fabrication of a loss size')
  console.log('PASS P-G: an unaccounted loss reports unknown R, not 0R')
}

// ─────────────────────────────────────────────────────────────────────────────
// P-H — "Admin totals summed a mix of known and missing P&L as if complete."
// ─────────────────────────────────────────────────────────────────────────────
{
  const route = read('app/api/admin/users/route.ts')
  const page = read('components/pages/AdminPage.tsx')

  assert.match(route, /unknownPL/, 'P-H: the endpoint counts rows with no P&L')
  assert.match(route, /knownPL/, 'P-H: and reports the known subtotal separately')
  assert.match(route, /const knownTrades = s\.trades - s\.unknownPL/, 'P-H: win rate denominator is known rows only')
  assert.match(route, /winRate: knownTrades > 0 \?/, 'P-H: no win rate is claimed over unknown rows')
  assert.match(route, /totals/, 'P-H: the response carries fleet totals')

  assert.match(page, /u\.knownPL \?\? 0/, 'P-H: the UI total sums the known subtotal')
  assert.match(page, /unknownPLRows/, 'P-H: the UI surfaces the unknown row count')
  assert.match(page, /UNKNOWN P\/L ROWS/, 'P-H: as an explicit tile, not a footnote')
  assert.match(page, /row\(s\) with no recorded realised P&L are excluded/, 'P-H: per-row exclusion is explained')
  console.log('PASS P-H: admin totals are labelled known subtotals with a visible unknown count')
}


// ─────────────────────────────────────────────────────────────────────────────
// M-1 / A-2 — "141 genuine executions overstated MT5 evidence by ~4.7x."
// A UUID broker reference is still a real execution, but it is NEVER an MT5
// ticket. Nothing is deleted and no count silently changes population.
// ─────────────────────────────────────────────────────────────────────────────
{
  const uuid = '3f2504e0-4f89-11d3-9a0c-0305e82c3301'
  const cases = [
    // [label, trade, expected kind, genuine, mt5Ticket]
    // A ticket that simply repeats the row's own internal id carries NO broker
    // reference: it is an id masquerading as a ticket.
    ['internal row id (uuid)', { id: uuid, broker_ticket: uuid }, BROKER_TICKET_KIND.NONE, false, false],
    // A UUID in ANY of these columns is an internal identifier, so a UUID-shaped
    // ticket is a broker reference from another venue at best — never MT5.
    ['setup_id (uuid)', { setup_id: uuid, broker_ticket: uuid }, BROKER_TICKET_KIND.OTHER_BROKER_REF, true, false],
    ['signal_id_ref (uuid)', { signal_id_ref: uuid, broker_ticket: uuid }, BROKER_TICKET_KIND.OTHER_BROKER_REF, true, false],
    ['prediction_log_id (uuid)', { prediction_log_id: uuid, broker_ticket: uuid }, BROKER_TICKET_KIND.OTHER_BROKER_REF, true, false],
    // The production shape: broker_ticket holds oanda_trade_id. A genuine
    // execution on another venue — counted, never labelled MT5.
    ['oanda execution id (uuid)', { oanda_trade_id: uuid, broker_ticket: uuid }, BROKER_TICKET_KIND.OTHER_BROKER_REF, true, false],
    ['numeric MT5 position ticket', { broker_ticket: '3454451953' }, BROKER_TICKET_KIND.MT5_POSITION, true, true],
    ['numeric MT5 deal ticket', { broker_ticket: '98765432101' }, BROKER_TICKET_KIND.MT5_POSITION, true, true],
    ['20-digit numeric', { broker_ticket: '12345678901234567890' }, BROKER_TICKET_KIND.MT5_POSITION, true, true],
    ['short alphanumeric broker order id', { broker_ticket: 'XAU-8871A' }, BROKER_TICKET_KIND.OTHER_BROKER_REF, true, false],
    ['empty string', { broker_ticket: '' }, BROKER_TICKET_KIND.NONE, false, false],
    ['whitespace', { broker_ticket: '   ' }, BROKER_TICKET_KIND.NONE, false, false],
    ['null', { broker_ticket: null }, BROKER_TICKET_KIND.NONE, false, false],
    ['missing', {}, BROKER_TICKET_KIND.NONE, false, false],
  ]

  for (const [label, trade, kind, genuine, mt5Ticket] of cases) {
    assert.equal(brokerTicketKind(trade), kind, `M-1: kind for ${label}`)
    assert.equal(isGenuineExecution(trade), genuine, `M-1: genuine for ${label}`)
    assert.equal(isMt5TicketBacked(trade), mt5Ticket, `M-1: MT5 claim for ${label}`)
  }

  assert.equal(isUuidRef(uuid), true, 'M-1: a UUID is recognised as an internal id')
  assert.equal(isUuidRef('3454451953'), false, 'M-1: a numeric ticket is not a UUID')

  // The partition exposes both counts, and `genuineExecutions` is deliberately
  // NOT re-based — that would move 111 rows between populations everywhere.
  const p = partitionTrades([
    { broker_ticket: '3454451953', result: 'WIN', closed_at: '2026-11-13T09:00:00Z', pl_usd: 1 },
    { broker_ticket: uuid, oanda_trade_id: uuid, result: 'LOSS', closed_at: '2026-11-13T09:00:00Z', pl_usd: -1 },
    { result: 'WIN', closed_at: '2026-11-13T09:00:00Z', pl_usd: 5 },
  ])
  assert.equal(p.genuineExecutions, 2, 'M-1: both broker refs count as executions')
  assert.equal(p.mt5TicketExecutions, 1, 'M-1: only the numeric ticket is MT5-backed')
  assert.equal(p.otherBrokerExecutions, 1, 'M-1: the UUID row is labelled, not deleted')
  assert.equal(p.ticketKinds[BROKER_TICKET_KIND.NONE], 1, 'M-1: the ticket-less row is counted too')

  assert.ok(!isMt5TicketBacked({ broker_ticket: uuid }), 'M-1: a UUID never satisfies an MT5 test')
  console.log('PASS M-1 / A-2: ticket kinds are explicit; UUID executions count but are never MT5')
}


// ─────────────────────────────────────────────────────────────────────────────
// M-2 / A-4 / H-3 — "lineage and actual_risk structurally incomplete."
// The write path must persist lineage AS SUPPLIED and never synthesise it, and
// every order must record who submitted it and on what authority.
// ─────────────────────────────────────────────────────────────────────────────
{
  const orders = read('app/api/orders/route.ts')
  assert.match(orders, /prediction_log_id:\s+predictionLogId \?\? null/,
    'M-2: prediction lineage is persisted as supplied, or NULL')
  assert.match(orders, /setup_id:\s+setupId \?\? null/, 'M-2: setup lineage is persisted as supplied, or NULL')
  assert.ok(!/prediction_log_id:[^\n]*(randomUUID|generate|Math\.random)/i.test(orders),
    'M-2: lineage is never synthesised')
  assert.match(orders, /const UUID_RE = \/\^\[0-9a-f\]\{8\}/, 'M-2: the signals update is uuid-gated')
  assert.match(orders, /signal_id_ref:\s+signal_id_ref \?\? \(typeof signalId === 'string' \? signalId : null\)/,
    'M-2: a synthetic id lives in signal_id_ref, not in the uuid signals table')

  // H-3 / A-4: the order-authority contract, field by field.
  for (const field of [
    'submission_source', 'authority_decision', 'authority_reason',
    'authority_policy_version', 'request_id', 'submitted_at', 'submitted_by',
  ]) {
    assert.match(orders, new RegExp(`${field}:`), `H-3/A-4: the order writes ${field}`)
  }
  assert.match(orders, /requested_entry_price:/, 'H-3/A-4: the requested price is kept beside the fill')
  assert.match(orders, /evaluateOrderAuthority\(/, 'H-3/A-4: the decision comes from the shared policy module')
  // Recording the decision is unconditional; BLOCKING stays opt-in, so this
  // phase cannot change what a human is allowed to do.
  assert.match(orders, /authority\.blocking && process\.env\.ORDER_AUTHORITY_ENFORCE === 'true'/,
    'H-3/A-4: enforcement remains explicitly opt-in')

  const policy = read('lib/order-authority.mjs')
  assert.match(policy, /export const SUBMISSION_SOURCE = \{/, 'H-3/A-4: lanes are enumerated, not string literals')
  assert.match(policy, /UNKNOWN: 'UNKNOWN'/, 'H-3/A-4: an unspecified caller is labelled, not defaulted')
  console.log('PASS H-3 / A-4 / M-2: lineage is supplied-only and every order records its authority')
}

// ─────────────────────────────────────────────────────────────────────────────
// M-3 — "Dead error branch: trade.accounting_status does not exist."
// ─────────────────────────────────────────────────────────────────────────────
{
  const scope = read('lib/analytics-scope.mjs')
  const scopeCode = codeLines(scope).join('\n')
  assert.ok(!/trade\.accounting_status/.test(scopeCode), 'M-3: the classifier no longer reads a phantom column')
  assert.match(scopeCode, /trade\.accounting_missing/, 'M-3: error evidence comes from the real column')

  const withPhantom = classifyTrade(mt5({ accounting_status: 'ERROR', accounting_complete: false }))
  assert.equal(withPhantom.population, POPULATION.GROSS_ONLY, 'M-3: setting the phantom column changes nothing')
  const real = classifyTrade(mt5({ accounting_missing: ['error'], accounting_complete: false }))
  assert.equal(real.population, POPULATION.ACCOUNTING_ERROR, 'M-3: the real column still quarantines')
  console.log('PASS M-3: accounting_status is gone; accounting_missing carries the evidence')
}

// ─────────────────────────────────────────────────────────────────────────────
// M-4 / A-5 — "/api/trades silently truncated at 200 rows."
// ─────────────────────────────────────────────────────────────────────────────
{
  assert.equal(DEFAULT_LIMIT, 1000, 'M-4: the default window is explicit, not 200')
  assert.equal(MAX_LIMIT, 5000, 'M-4: there is a hard ceiling')
  assert.equal(parseLimit(null), 1000, 'M-4: no limit means the default')
  assert.equal(parseLimit(''), 1000, 'M-4: an empty value means the default')
  assert.equal(parseLimit('abc'), 1000, 'M-4: a non-numeric value means the default')
  assert.equal(parseLimit('250'), 250, 'M-4: a valid request is honoured')
  assert.equal(parseLimit('2.9'), 2, 'M-4: a row count is whole')
  assert.equal(parseLimit('0'), 1000, 'M-4: zero rows is a bug, not an intent')
  assert.equal(parseLimit('-5'), 1000, 'M-4: a negative window is refused')
  assert.equal(parseLimit('999999'), 5000, 'M-4: an oversized request is clamped to the cap')
  assert.equal(parseLimit('Infinity'), 1000, 'M-4: a non-finite request is refused')
  assert.equal(parseLimit('1e9'), 5000, 'M-4: an exponent is still clamped')

  // The response states what was withheld instead of losing rows in silence.
  assert.equal(describeWindow({ limit: 1000, rows: 42, requested: null }).truncated, false,
    'M-4: a short page is not truncated')
  assert.equal(describeWindow({ limit: 1000, rows: 1000, requested: null }).truncated, false,
    'M-4: exactly the window is not truncated')
  assert.equal(describeWindow({ limit: 1000, rows: 1001, requested: null }).truncated, true,
    'M-4: one extra row proves the window cut')
  assert.equal(describeWindow({ limit: 5000, rows: 10, requested: 99999 }).truncated, true,
    'M-4: asking above the cap is reported as truncated')

  const trades = read('app/api/trades/route.ts')
  assert.match(trades, /import \{ describeWindow, parseLimit \}/, 'M-4: the route uses the shared parser')
  assert.ok(!codeLines(trades).some((l) => /\.limit\(200\)/.test(l)),
    'M-4: the silent 200-row slice is gone')
  assert.match(trades, /\.limit\(limit \+ 1\)/, 'M-4: one extra row is read to detect the cut')
  assert.match(trades, /truncated/, 'M-4: the response reports truncation')
  console.log('PASS M-4 / A-5: the window is bounded, explicit and reported')
}


// ─────────────────────────────────────────────────────────────────────────────
// M-5 / A-5 (phase 1) — "/api/trades authorises on a client-supplied userId."
// A supplied token must match the requested user; an unverified id never widens
// scope. Unauthenticated behaviour is unchanged so shipped callers do not break.
// ─────────────────────────────────────────────────────────────────────────────
{
  const trades = read('app/api/trades/route.ts')
  assert.match(trades, /async function resolveBearerUser/, 'M-5: the route resolves a supplied token')
  assert.match(trades, /auth\.getUser\(token\)/, 'M-5: it verifies the token server-side, not the claim')
  assert.match(trades, /if \(auth\.supplied && auth\.userId !== userId\)/, 'M-5: a mismatch is refused')
  assert.match(trades, /status: 403/, 'M-5: with 403, not a silent success')
  assert.match(trades, /\.eq\('user_id', userId\)/, 'M-5: the query is always scoped to the requested id')
  assert.ok(!/auth\.userId \?\? userId\)/.test(trades), 'M-5: a token can never replace or widen the scope')

  // Failing closed on a malformed or expired token: every branch yields no user.
  assert.match(trades, /if \(error \|\| !data\?\.user\?\.id\) return \{ supplied: true as const, userId: null \}/,
    'M-5: an unverifiable token yields no user')
  assert.match(trades, /catch \{\s*\n\s*return \{ supplied: true as const, userId: null \}/,
    'M-5: a verification throw also yields no user')
  console.log('PASS M-5: a supplied token must match the requested user, and mismatches fail closed')
}

// ─────────────────────────────────────────────────────────────────────────────
// M-6 / A-6 — "reconciliation_refresh reported HEALTHY at 4.4 h."
// The threshold is env-gated with today's value as the default, because M-6 has a
// hard dependency on C-2: turning a monitor red before the scheduler works adds
// noise, not safety.
// ─────────────────────────────────────────────────────────────────────────────
{
  // 1. The default must be EXACTLY today's shipped behaviour (6 h warn).
  assert.equal(DEFAULT_RECON_WARN_HOURS, 6, 'M-6: the default preserves current behaviour')
  assert.equal(reconWarnHours({}), 6, 'M-6: unset env means the default')
  assert.equal(reconWarnHours({ RECON_STALE_WARN_HOURS: '' }), 6, 'M-6: empty means the default')
  assert.equal(reconWarnHours({ RECON_STALE_WARN_HOURS: 'abc' }), 6, 'M-6: garbage means the default')

  // 2. The configured override is honoured — including the strict value.
  assert.equal(reconWarnHours({ RECON_STALE_WARN_HOURS: '0.5' }), STRICT_RECON_WARN_HOURS,
    'M-6: the documented strict value is honoured')
  assert.equal(reconWarnHours({ RECON_STALE_WARN_HOURS: '2' }), 2, 'M-6: an intermediate value is honoured')

  // 3. An invalid value cannot make the check silently permissive.
  for (const bad of ['0', '-1', '0.0001', '999999', 'Infinity', 'NaN']) {
    assert.equal(reconWarnHours({ RECON_STALE_WARN_HOURS: bad }), DEFAULT_RECON_WARN_HOURS,
      `M-6: ${bad} falls back to the default rather than disabling the check`)
  }
  assert.ok(MAX_RECON_WARN_HOURS <= 168, 'M-6: the accepted ceiling is a week at most')
  assert.ok(MIN_RECON_WARN_HOURS > 0, 'M-6: a zero threshold is refused')

  // 4. FAILED stays a backstop that a bad override cannot remove.
  assert.equal(reconFailHours(6), 48, 'M-6: the shipped FAILED backstop is unchanged')
  assert.ok(reconFailHours(0.5) >= 48, 'M-6: a strict WARN cannot shorten the FAILED backstop below 48 h')

  // 5. Status mapping — the original defect, restated as behaviour.
  assert.equal(reconStatus(4.4, 6), 'HEALTHY', 'M-6: 4.4 h is healthy under the shipped threshold')
  assert.equal(reconStatus(4.4, STRICT_RECON_WARN_HOURS), 'WARNING',
    'M-6: and is flagged as soon as the owner opts in after C-2')
  assert.equal(reconStatus(null, 6), 'FAILED', 'M-6: an unevaluated monitor is never HEALTHY')
  assert.equal(reconStatus(200, 6), 'FAILED', 'M-6: a very stale refresh fails')

  // 6. The endpoint reads the env and reports the threshold it used.
  const integrity = read('app/api/production-integrity/route.ts')
  assert.match(integrity, /reconWarnHours\(process\.env\)/, 'M-6: the route reads the override')
  assert.match(integrity, /status: reconStatus\(ageH, warnH\)/, 'M-6: and delegates classification')
  assert.match(integrity, /warnHours: warnH/, 'M-6: the response discloses the threshold used')
  console.log('PASS M-6 / A-6: the threshold is opt-in, defaults to today, and cannot be disabled by typo')
}


// ─────────────────────────────────────────────────────────────────────────────
// L-1 — "other_fees is optional in the net formula." DOCUMENTED, frozen.
// ─────────────────────────────────────────────────────────────────────────────
{
  const sql = read('supabase/migrations/20261113_phase42_rpc_broker_deal_accounting.sql')
  assert.match(sql, /AND v_cp_commission IS NOT NULL\s*\n\s*AND v_cp_swap IS NOT NULL/,
    'L-1: net is gated on commission AND swap')
  assert.match(sql, /COALESCE\(v_cp_fee, 0\)/, 'L-1: only the fee is coalesced')
  assert.match(sql, /ELSE NULL\s*\n\s*END;/, 'L-1: an unknown term still yields NULL net')
  console.log('PASS L-1: the accepted fee limitation is frozen and cannot be tightened by accident')
}

// ─────────────────────────────────────────────────────────────────────────────
// L-2 — "result is WIN at exactly 0.00." DOCUMENTED, frozen.
// The label stays `>= 0`; the METRICS treat zero as a breakeven and exclude it
// from the win/loss rate, so the displayed rate is not inflated.
// ─────────────────────────────────────────────────────────────────────────────
{
  const sql = read('supabase/migrations/20261113_phase42_rpc_broker_deal_accounting.sql')
  assert.match(sql, /WHEN COALESCE\(v_cp_net, v_cp_profit\) >= 0 THEN 'WIN' ELSE 'LOSS' END/,
    'L-2: a zero close is labelled WIN, exactly as audited')

  const { computeStats } = await import('../lib/analytics-metrics.mjs')
  const stats = computeStats([0, 10, -10])
  assert.equal(stats.breakevens, 1, 'L-2: zero is counted as a breakeven')
  assert.equal(stats.wins, 1, 'L-2: one winner')
  assert.equal(stats.losses, 1, 'L-2: one loser')
  assert.equal(stats.winRate, 0.5, 'L-2: and the rate is 0.5, not 0.67')
  console.log('PASS L-2: the zero-profit label is documented and the metric is not inflated')
}

// ─────────────────────────────────────────────────────────────────────────────
// L-3 — "The EA computes netProfit and the server recomputes it." DOCUMENTED.
// The client figure is advisory and never trusted.
// ─────────────────────────────────────────────────────────────────────────────
{
  const sql = read('supabase/migrations/20261113_phase42_rpc_broker_deal_accounting.sql')
  assert.match(sql, /v_cp_net := CASE/, 'L-3: the RPC derives net itself')
  assert.ok(!/v_cp_net\s*:=\s*[^;]*netProfit/.test(sql), 'L-3: and never reads the client netProfit')

  const ea = read('public/SybexForexAI_EA_v9.5.mq5')
  assert.match(ea, /double netProfit = agg\.gross \+ agg\.commission \+ agg\.swap \+ agg\.fee;/,
    'L-3: the EA still sends its advisory value (a first-close cross-check)')
  console.log('PASS L-3: the client net is advisory; the server value is authoritative')
}

// ─────────────────────────────────────────────────────────────────────────────
// L-4 — "The Journal page is unmounted." DOCUMENTED, frozen.
// Re-enabling it would surface an unaudited page, which is out of scope here.
// ─────────────────────────────────────────────────────────────────────────────
{
  const shell = read('components/AppShell.tsx')
  const journalImport = shell.split('\n').find((l) => /import\s+JournalPage/.test(l)) || ''
  assert.match(journalImport.trim(), /^\/\//, 'L-4: the Journal import stays commented out')
  assert.ok(!/journalPageEnabled/.test(shell), 'L-4: no half-re-enable flag was invented instead')
  console.log('PASS L-4: the Journal page stays dormant, and its tests keep the module honest')
}


// ─────────────────────────────────────────────────────────────────────────────
// H-4 / P-J — "Restart recovery: a close that happens while the terminal is down
// is never reported." Static review of the EA source: there is no MQL5 compiler
// in this repository, so compilation and install remain owner actions.
// ─────────────────────────────────────────────────────────────────────────────
{
  const ea = read('public/SybexForexAI_EA_v9.5.mq5')

  // The recovery engine exists and is called from OnInit — not merely described.
  assert.match(ea, /void RecoverOfflineCloses\(\)/, 'P-J: the recovery function exists')
  assert.match(ea, /\n\s*LoadRecoveryWatermark\(\);\s*\n\s*RecoverOfflineCloses\(\);/, 'P-J: and runs at start-up')

  // The watermark is persisted and per account, so a restart cannot re-report or
  // leak another account's closes.
  assert.match(ea, /#define RECOVERY_GVAR_PREFIX "SYBEX_LASTCLOSE_"/, 'P-J: the watermark is a named global')
  assert.match(ea, /GlobalVariableSet\(RecoveryGvarName\(\)/, 'P-J: and is persisted')
  assert.match(ea, /AccountInfoInteger\(ACCOUNT_LOGIN\)/, 'P-J: keyed per account')
  assert.match(ea, /\+ IntegerToString\(\(long\)MagicNumber\)/, 'P-J: and per magic number')

  // Delivery discipline: the watermark moves ONLY after a successful push.
  const commit = ea.indexOf('CommitRecoveryWatermark();')
  const okBlock = ea.indexOf('else if(rc == 200)')
  assert.ok(okBlock > 0 && commit > okBlock, 'P-J: the watermark commits inside the success branch')
  assert.match(ea, /ArrayResize\(g_recoveredItems, 0\);\s*\n\s*g_recoveredCount\s+= 0;/,
    'P-J: the queue is cleared only after delivery')

  // A close with no deal history is NOT invented.
  assert.match(ea, /NOT reported \(no invented numbers\)/, 'P-J: missing history is logged, not guessed')

  // A recovered close is labelled, and never claims a measured excursion.
  assert.match(ea, /provenance\\":\\"ea_recovered/, 'P-J: recovered closes are labelled')
  assert.match(ea, /provenance\\":\\"ea_observed/, 'P-J: live closes are labelled differently')
  assert.match(ea, /mfeMaeMeasured\\":false/, 'P-J: an unmeasured excursion says so')

  // The empty-snapshot early return no longer loses the recovered queue.
  assert.ok(!/if\(g_prevPosCount == 0\) return "\[\]";/.test(ea),
    'P-J: an empty snapshot still delivers recovered closes')
  assert.match(ea, /return MergeClosedJSON\(out \+ "\]"\)/, 'P-J: live and recovered closes are merged')

  // A-7: the running build is identifiable from STORED state (inside the entries
  // the app actually persists), not only from a top-level field it drops.
  const openPosBuilder = ea.slice(ea.indexOf('string BuildOpenPositionsJSON()'))
  assert.match(openPosBuilder.slice(0, 2000), /eaVersion\\":\\"9.50/, 'A-7: open positions carry the build id')
  assert.match(ea, /#property version\s+"9\.50"/, 'A-7: the compiled EX5 reports version 9.50')

  // Nothing about order placement may have moved in this patch.
  assert.match(ea, /#property strict/, 'P-J: still strict')
  assert.match(ea, /input double MaxLots\s+= 10\.0;/, 'P-J: the lot ceiling input is unchanged')
  assert.match(ea, /input string WebhookToken/, 'P-J: the transport inputs are unchanged')
  console.log('PASS H-4 / P-J / A-7: restart recovery is labelled, idempotent and version-identifiable')
}


// ─────────────────────────────────────────────────────────────────────────────
// P-I — partial-close proof. PREPARED only: the migration must NOT be in the
// applied sequence, and it must be additive (no row, column or trigger dropped).
// ─────────────────────────────────────────────────────────────────────────────
{
  const sql = read('supabase/prepared/20261114_phase421_partial_close_proof.sql')

  assert.match(sql, /STATUS: \*\*PREPARED - NOT APPLIED\.\*\*/, 'P-I: the file declares itself unapplied')
  for (const col of ['deal_count', 'volume_closed', 'partial_close', 'deal_tickets', 'close_provenance']) {
    assert.match(sql, new RegExp(`ADD COLUMN IF NOT EXISTS ${col}`), `P-I: adds ${col}`)
  }
  assert.ok(!/DROP TABLE|TRUNCATE|DELETE FROM/i.test(sql), 'P-I: nothing is dropped, truncated or deleted')
  assert.ok(!/^\s*ALTER TABLE[^;]*DROP COLUMN/im.test(sql), 'P-I: no column is dropped outside the DOWN block')
  assert.match(sql, /CREATE OR REPLACE VIEW public\.v_partial_close_audit/, 'P-I: an audit view is provided')
  assert.match(sql, /No backfill/i, 'P-I: the absence of a backfill is stated')
  assert.match(sql, /No change to `trades_derive_accounting_trg`/i,
    'P-I: applying it cannot move a row between analytics populations')

  // The evidence it stores is exactly what the EA already transmits, so the
  // columns have a source rather than an intention.
  const ea = read('public/SybexForexAI_EA_v9.5.mq5')
  for (const field of ['dealCount', 'volumeClosed', 'partial']) {
    assert.match(ea, new RegExp(`\\\\"${field}\\\\"`), `P-I: the EA sends ${field}`)
  }
  const ingest = read('lib/broker-deal-ingest.mjs')
  assert.match(ingest, /dealCount/, 'P-I: the parser already reads dealCount')
  assert.match(ingest, /volumeClosed/, 'P-I: and volumeClosed')
  console.log('PASS P-I: the partial-close migration is prepared, additive and out of the applied path')
}

// ─────────────────────────────────────────────────────────────────────────────
// CROSS-SURFACE — the guard, the header and the prop-firm page must agree.
// The likeliest regression in this phase is drift: three files deciding
// independently what "counts". They now share one definition, and this group
// proves that definition yields the rows the live risk limit uses.
// ─────────────────────────────────────────────────────────────────────────────
{
  const orders = read('app/api/orders/route.ts')
  const shell = read('components/AppShell.tsx')
  const propfirm = read('components/pages/PropFirmPage.tsx')

  for (const [name, src] of [['orders', orders], ['AppShell', shell], ['PropFirmPage', propfirm]]) {
    assert.match(src, /closedExecutions/, `${name}: imports the shared row definition`)
    assert.match(src, /sumKnownPL/, `${name}: imports the shared unknown-aware sum`)
  }

  // A representative production mix must give every surface the same answer.
  const rows = [
    mt5({ pl_usd: 10 }),                                                                          // execution
    { broker_ticket: '9', result: 'LOSS', closed_at: '2026-11-13T09:00:00Z', pl_usd: -4 },        // stale-status loss
    { broker_ticket: '10', result: 'CLOSED', closed_at: '2026-11-13T09:00:00Z', pl_usd: null },   // unknown money
    { result: 'WIN', closed_at: '2026-11-13T09:00:00Z', pl_usd: 99 },                             // simulation
    { broker_ticket: '11', result: 'CANCELLED', pl_usd: -50 },                                    // cancelled
    { broker_ticket: '12', result: 'OPEN', trade_status: 'OPEN', closed_at: null, pl_usd: null }, // open
  ]

  const scoped = closedExecutions(rows)
  assert.equal(scoped.length, 3, 'AGREEMENT: three of six rows are closed executions')
  assert.equal(scoped.some((r) => r.pl_usd === 99), false, 'AGREEMENT: the simulation never enters')
  assert.equal(scoped.some((r) => r.result === 'CANCELLED'), false, 'AGREEMENT: the cancelled row never enters')

  const sum = sumKnownPL(scoped)
  assert.equal(sum.pl, null, 'AGREEMENT: the unknown row makes the day unknown for every surface')
  assert.equal(sum.unknown, 1, 'AGREEMENT: and exactly one row is named as unknown')
  assert.equal(sum.known, 2, 'AGREEMENT: two rows are known')
  assert.equal(EXECUTION_POPULATIONS.length, 4, 'AGREEMENT: four populations count as executions')

  // The orders route must derive its block decision from THIS sum, not its own.
  assert.match(orders, /todayUnknownPLRows\s+= todayScope\.unknown/,
    'AGREEMENT: the guard counts unknown rows from the shared sum')
  assert.match(orders, /if \(todayUnknownPLRows > 0\)/, 'AGREEMENT: and blocks on that count')
  console.log('PASS AGREEMENT: guard, header and prop-firm page share one definition of "rows that count"')
}

console.log('\nphase421-remediation: all groups passed')

