// tests/trade-accounting.test.mjs
// Phase 4.1B — canonical execution accounting.
// Covers: profitable / losing / breakeven close, missing P&L, commission, swap,
// other fees, partial close, multiple closing deals, duplicate broker deal,
// legacy result='CLOSED'.
// Run: npm run test:trade-accounting
import assert from 'node:assert/strict'
import {
  ACCOUNTING_VERSION, RESULT, RESULT_BASIS, SIGN_CONVENTION,
  accountingCompleteness, aggregateDeals, classifyNet, computeNetPnl, resolveOutcome,
} from '../lib/trade-accounting.mjs'

// ── A — net P&L uses the broker formula, signed as supplied ─────────────────
{
  const a = computeNetPnl({ grossProfit: 100, commission: -7, swap: -2 })
  assert.equal(a.netPnl, 91, 'A: net = gross + commission + swap')
  assert.equal(a.result, RESULT.WIN, 'A')
  assert.equal(a.complete, true, 'A')
  assert.equal(a.version, ACCOUNTING_VERSION, 'A: version recorded')
  console.log('PASS A: net realised P&L = gross + commission + swap')
}

// ── B — commission alone can flip a gross win into a net loss ───────────────
{
  const b = computeNetPnl({ grossProfit: 3, commission: -5, swap: 0 })
  assert.equal(b.netPnl, -2, 'B')
  assert.equal(b.result, RESULT.LOSS, 'B: profitability is decided on NET, not gross')
  assert.notEqual(b.result, classifyNet(3), 'B: gross-only classification would have said WIN')
  console.log('PASS B: a small gross win becomes a net loss once commission is applied')
}

// ── C — missing commission/swap is NEVER treated as zero ────────────────────
{
  const c = computeNetPnl({ grossProfit: 100 })
  assert.equal(c.netPnl, null, 'C: net is unknown, not "gross"')
  assert.equal(c.complete, false, 'C')
  assert.deepEqual(c.missing.sort(), ['commission', 'swap'], 'C: the missing terms are named')
  // The broker gross IS real money, so a provisional verdict is honest — but it
  // must be labelled GROSS_ONLY so nobody reports it as a net result.
  assert.equal(c.resultBasis, RESULT_BASIS.GROSS_ONLY, 'C: verdict basis is explicit')
  assert.equal(c.result, RESULT.WIN, 'C: gross-based provisional verdict')
  assert.equal(c.components.commission, null, 'C: the cost is reported as unknown, not 0')
  console.log('PASS C: missing costs ⇒ netPnl null + GROSS_ONLY basis (never a fabricated net)')
}

// ── C2 — nothing known at all really is UNKNOWN ────────────────────────────
{
  const c = computeNetPnl({})
  assert.equal(c.result, RESULT.UNKNOWN, 'C2')
  assert.equal(c.resultBasis, RESULT_BASIS.NONE, 'C2')
  assert.equal(c.netPnl, null, 'C2')
  console.log('PASS C2: no financial evidence at all ⇒ UNKNOWN / basis NONE')
}

// ── D — an all-zero cost set is genuinely known, and completes ──────────────
{
  const d = computeNetPnl({ grossProfit: 100, commission: 0, swap: 0 })
  assert.equal(d.netPnl, 100, 'D')
  assert.equal(d.complete, true, 'D: explicit zeros are data, not absence')
  console.log('PASS D: explicit zero costs are accepted as complete accounting')
}

// ── E — positive-credit swap keeps its sign ─────────────────────────────────
{
  const e = computeNetPnl({ grossProfit: 10, commission: -2, swap: 5 })
  assert.equal(e.netPnl, 13, 'E: a positive swap is a credit, not a cost')
  console.log('PASS E: sign conventions preserved (positive swap credits the account)')
}

// ── F — cost_positive convention inverts costs correctly ────────────────────
{
  const f = computeNetPnl({ grossProfit: 100, commission: 7, swap: 2, signConvention: SIGN_CONVENTION.COST_POSITIVE })
  assert.equal(f.netPnl, 91, 'F: magnitude-style payloads are negated')
  console.log('PASS F: cost_positive payloads are normalised, and the convention is recorded')
}

// ── G — other broker fees participate in the formula ────────────────────────
{
  const g = computeNetPnl({ grossProfit: 100, commission: -1, swap: 0, otherFees: -3 })
  assert.equal(g.netPnl, 96, 'G')
  assert.equal(g.components.otherFees, -3, 'G')
  console.log('PASS G: other broker fees are part of net P&L')
}

// ── H — breakeven within epsilon ────────────────────────────────────────────
{
  assert.equal(classifyNet(0), RESULT.BREAKEVEN, 'H')
  assert.equal(classifyNet(0.005), RESULT.BREAKEVEN, 'H: within epsilon')
  assert.equal(classifyNet(0.02), RESULT.WIN, 'H')
  assert.equal(classifyNet(-0.02), RESULT.LOSS, 'H')
  console.log('PASS H: WIN / LOSS / BREAKEVEN thresholds')
}

// ── I — legacy result='CLOSED' is a STATUS, never a loss ────────────────────
{
  const legacy = resolveOutcome({ result: 'CLOSED', closed_at: '2026-09-06T10:00:00Z', pl_usd: null })
  assert.equal(legacy.tradeStatus, 'CLOSED', 'I: lifecycle is CLOSED')
  assert.equal(legacy.tradeResult, RESULT.UNKNOWN, 'I: profitability is UNKNOWN, not LOSS')
  assert.equal(legacy.source, 'legacy_closed_no_financials', 'I: the reason is recorded')
  assert.equal(legacy.accountingComplete, false, 'I')

  // Production reality: 487 rows look exactly like this.
  const many = Array.from({ length: 5 }, () => resolveOutcome({ result: 'CLOSED', closed_at: '2026-09-06T10:00:00Z' }))
  assert.equal(many.filter((r) => r.tradeResult === RESULT.LOSS).length, 0, 'I: zero legacy rows become losses')
  console.log("PASS I: result='CLOSED' never becomes WIN or LOSS")
}

// ── J — a closed trade WITH complete financials gets a canonical result ─────
{
  const j = resolveOutcome({ result: 'CLOSED', closed_at: '2026-11-12T02:36:05Z', pl_usd: 3368.5, commission: -35, swap: 0 })
  assert.equal(j.tradeStatus, 'CLOSED', 'J')
  assert.equal(j.tradeResult, RESULT.WIN, 'J: derived from net P&L')
  assert.equal(j.source, 'net_realised_pnl', 'J')
  assert.equal(j.accountingComplete, true, 'J')
  console.log('PASS J: a closed trade with complete financials receives a canonical result')
}

// ── K — an existing canonical trade_result is never second-guessed ──────────
{
  const k = resolveOutcome({ result: 'WIN', trade_result: 'BREAKEVEN', pl_usd: 50 })
  assert.equal(k.tradeResult, 'BREAKEVEN', 'K: explicit canonical value wins')
  assert.equal(k.source, 'explicit_trade_result', 'K')
  console.log('PASS K: explicit trade_result is authoritative')
}

// ── L — partial closes aggregate, and lifecycle reflects partiality ─────────
{
  const l = aggregateDeals([
    { dealTicket: 'D1', grossProfit: 100, commission: -5, swap: 0, volume: 2 },
    { dealTicket: 'D2', grossProfit: -40, commission: -5, swap: 0, volume: 1 },
  ], { positionVolume: 5 })
  assert.equal(l.dealCount, 2, 'L')
  assert.equal(l.netPnl, 50, 'L: nets summed')
  assert.equal(l.closedVolume, 3, 'L')
  assert.equal(l.partial, true, 'L: 3 of 5 lots closed')
  assert.equal(l.lifecycle, 'PARTIALLY_CLOSED', 'L')
  assert.equal(l.result, RESULT.WIN, 'L')
  console.log('PASS L: partial close aggregates and reports PARTIALLY_CLOSED')
}

// ── M — a final close is CLOSED ─────────────────────────────────────────────
{
  const m = aggregateDeals([
    { dealTicket: 'D1', grossProfit: 10, commission: 0, swap: 0, volume: 3 },
    { dealTicket: 'D2', grossProfit: 20, commission: 0, swap: 0, volume: 2 },
  ], { positionVolume: 5 })
  assert.equal(m.partial, false, 'M')
  assert.equal(m.lifecycle, 'CLOSED', 'M')
  assert.equal(m.netPnl, 30, 'M')
  console.log('PASS M: full closure reports CLOSED')
}

// ── N — duplicate broker deals are idempotent, never double counted ────────
{
  const deal = { dealTicket: 'DUP', grossProfit: 100, commission: -5, swap: 0, volume: 5 }
  const n = aggregateDeals([deal, deal, deal], { positionVolume: 5 })
  assert.equal(n.dealCount, 1, 'N: a re-delivered deal is counted once')
  assert.equal(n.duplicateDeals, 2, 'N: duplicates are surfaced, not hidden')
  assert.equal(n.netPnl, 95, 'N: P&L is not inflated by redelivery')
  console.log('PASS N: duplicate broker deals are idempotent')
}

// ── O — a deal with no ticket is refused rather than summed ────────────────
{
  const o = aggregateDeals([
    { grossProfit: 100, commission: 0, swap: 0, volume: 1 },
    { dealTicket: 'OK1', grossProfit: 10, commission: 0, swap: 0, volume: 1 },
  ])
  assert.equal(o.dealCount, 1, 'O')
  assert.equal(o.rejected.length, 1, 'O: the unticketed deal is rejected, not guessed')
  assert.equal(o.rejected[0].reason, 'missing_deal_ticket', 'O')
  assert.equal(o.netPnl, 10, 'O')
  console.log('PASS O: unticketed deals cannot be de-duplicated and are refused')
}

// ── P — one incomplete deal makes the whole aggregate incomplete ───────────
{
  const p = aggregateDeals([
    { dealTicket: 'A', grossProfit: 100, commission: -5, swap: 0, volume: 5 },
    { dealTicket: 'B', grossProfit: 50, volume: 1 },
  ])
  assert.equal(p.complete, false, 'P')
  assert.equal(p.netPnl, null, 'P: no partial-sum "net" is published')
  assert.equal(p.result, RESULT.UNKNOWN, 'P')
  console.log('PASS P: an incomplete deal makes the position incomplete, not optimistically summed')
}

// ── Q — accounting completeness diagnostics ────────────────────────────────
{
  const full = accountingCompleteness({
    pl_usd: 10, commission: -1, swap: 0, broker_ticket: '123', trade_result: 'WIN', net_realised_pnl: 9,
  })
  assert.equal(full.complete, true, 'Q')
  assert.equal(full.status, 'HEALTHY', 'Q')

  // The production shape: P&L and ticket present, costs missing.
  const partial = accountingCompleteness({
    pl_usd: 3368.5, commission: null, swap: null, broker_ticket: '3454458505', trade_result: null,
  })
  assert.equal(partial.complete, false, 'Q')
  assert.equal(partial.status, 'WARNING', 'Q')
  assert.deepEqual(partial.missing.sort(), ['commission', 'swap', 'trade_result'], 'Q')

  const empty = accountingCompleteness({ result: 'CLOSED' })
  assert.equal(empty.status, 'INCOMPLETE', 'Q: no money at all')
  console.log('PASS Q: completeness diagnostics name exactly what is missing')
}

console.log('\ntrade-accounting: 17/17 groups passed')

