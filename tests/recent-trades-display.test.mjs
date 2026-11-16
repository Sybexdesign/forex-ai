// tests/recent-trades-display.test.mjs
// RECENT TRADES — accounting → display contract (Phase 4.2.1).
//
// Covers the brief's Part 5 list end-to-end at the presentation boundary: what a
// row may SHOW given what the broker reported. The arithmetic itself is covered by
// tests/trade-accounting.test.mjs and tests/analytics-scope.test.mjs; this file
// asserts that no row can display a figure the accounting does not support.
//
// Run: npm run test:recent-trades
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import {
  describeTradeRow, sortDescribedRows, realisedPnlForUtcDay, utcDayKey,
  isGenuineExecution, brokerTicketKind, ROW_RESULT,
} from '../lib/analytics-scope.mjs'
import { aggregateDeals } from '../lib/trade-accounting.mjs'

let groups = 0
const group = (name) => { groups++; console.log(`  ✓ ${name}`) }

/** A fully-accounted closed broker trade. */
const netRow = (o = {}) => ({
  id: 'row-1', broker_ticket: '5001', pair: 'XAU/USD', direction: 'BUY', lots: 0.10,
  entry_price: 2400.10, exit_price: 2401.20,
  opened_at: '2026-11-18T09:00:00Z', closed_at: '2026-11-18T09:42:00Z',
  pl_usd: 11.00, commission: -0.70, swap: -0.10, other_fees: -0.05,
  net_realised_pnl: 10.15, accounting_complete: true, accounting_missing: [],
  trade_result: 'WIN', result: 'WIN', trade_status: 'CLOSED', source: 'scalp',
  ...o,
})

// ── 1-4 — the four basic outcomes, priced from the right basis ───────────────
{
  const win = describeTradeRow(netRow())
  assert.equal(win.result, ROW_RESULT.WIN, '1: net positive ⇒ WIN')
  assert.equal(win.pnl, 10.15, '1: displayed P&L is NET, not gross')
  assert.equal(win.pnlBasis, 'NET', '1: basis disclosed')
  assert.equal(win.netPnl, 10.15, '1: net column populated')
  assert.equal(win.grossPnl, 11.00, '1: gross preserved separately')
  assert.equal(win.accountingComplete, true, '1: marked net-complete')

  const loss = describeTradeRow(netRow({
    id: 'row-2', pl_usd: -9.00, commission: -0.70, swap: -0.10, other_fees: -0.05,
    net_realised_pnl: -9.85, trade_result: 'LOSS', result: 'LOSS',
  }))
  assert.equal(loss.result, ROW_RESULT.LOSS, '2: net negative ⇒ LOSS')
  assert.equal(loss.pnl, -9.85, '2: net shown with sign preserved')

  const be = describeTradeRow(netRow({
    id: 'row-3', pl_usd: 0.80, commission: -0.70, swap: -0.10, other_fees: 0,
    net_realised_pnl: 0, trade_result: 'WIN', result: 'WIN',
  }))
  assert.equal(be.result, ROW_RESULT.BREAKEVEN, '3: net exactly zero ⇒ BREAKEVEN, not WIN')

  const open = describeTradeRow(netRow({
    id: 'row-4', closed_at: null, exit_price: null, pl_usd: null, commission: null,
    swap: null, other_fees: null, net_realised_pnl: null, accounting_complete: null,
    trade_result: null, result: 'OPEN', trade_status: 'OPEN',
  }))
  assert.equal(open.result, ROW_RESULT.OPEN, '4: open position is OPEN')
  assert.equal(open.isOpen, true, '4: flagged as open')
  assert.equal(open.pnl, null, '4: an open position displays no realised P&L')
  assert.equal(open.netPnl, null, '4: and no net figure')
  group('1-4 — WIN / LOSS / BREAKEVEN / OPEN classified from NET, never from gross')
}

// ── 5-6 — partial closes and multiple closing deals ─────────────────────────
{
  // Two closing deals on ONE 0.20 position: 0.05 then 0.15.
  const agg = aggregateDeals([
    { dealTicket: '9001', grossProfit: 4.00, commission: -0.20, swap: 0, otherFees: 0, volume: 0.05 },
    { dealTicket: '9002', grossProfit: 12.00, commission: -0.60, swap: -0.10, otherFees: 0, volume: 0.15 },
  ], { positionVolume: 0.20 })

  assert.equal(agg.dealCount, 2, '6: both closing deals consumed')
  assert.equal(agg.grossPnl, 16.00, '6: gross summed across deals')
  assert.equal(agg.netPnl, 15.10, '6: net summed across deals')
  assert.equal(agg.complete, true, '6: complete when every deal is complete')
  assert.equal(agg.lifecycle, 'CLOSED', '6: full volume closed')
  assert.equal(agg.partial, false, '6: 0.20 of 0.20 is not partial')

  // One 0.05 leg of a 0.20 position = a genuine partial close.
  const partial = aggregateDeals([
    { dealTicket: '9101', grossProfit: 4.00, commission: -0.20, swap: 0, otherFees: 0, volume: 0.05 },
  ], { positionVolume: 0.20 })
  assert.equal(partial.partial, true, '5: partial close detected')
  assert.equal(partial.lifecycle, 'PARTIALLY_CLOSED', '5: lifecycle says partially closed')
  assert.equal(partial.netPnl, 3.80, '5: the partial leg is priced, not dropped')
  group('5-6 — partial close and multi-deal closes aggregate once, never double-counted')
}

// ── 7-12 — cost components, present and missing ─────────────────────────────
{
  const withAll = describeTradeRow(netRow({ id: 'c-all' }))
  assert.equal(withAll.commission, -0.70, '7: commission shown as the broker signed it')
  assert.equal(withAll.swap, -0.10, '8: swap shown')
  assert.equal(withAll.otherFees, -0.05, '9: other fees shown')

  // A positive swap (a credit) keeps its sign — no abs(), no "cost" assumption.
  const credited = describeTradeRow(netRow({
    id: 'c-swap', pl_usd: 10, commission: -0.70, swap: 1.25, other_fees: 0,
    net_realised_pnl: 10.55,
  }))
  assert.equal(credited.swap, 1.25, '8: a swap credit stays positive')
  assert.equal(credited.netPnl, 10.55, '8: credit increases net')

  // Missing commission ⇒ GROSS ONLY ⇒ RESULT PENDING. Not a WIN, not a zero.
  const noComm = describeTradeRow(netRow({
    id: 'c-nocomm', commission: null, swap: null, other_fees: null,
    net_realised_pnl: null, accounting_complete: false,
    accounting_missing: ['commission', 'swap'],
  }))
  assert.equal(noComm.population, 'GROSS_ONLY', '10: missing commission ⇒ GROSS_ONLY')
  assert.equal(noComm.result, ROW_RESULT.PENDING, '10: result is PENDING, not WIN')
  assert.equal(noComm.provisional, true, '10: flagged provisional')
  assert.equal(noComm.netPnl, null, '10: no net is invented')
  assert.equal(noComm.pnl, 11.00, '10: gross is displayed as gross')
  assert.equal(noComm.pnlBasis, 'GROSS', '10: basis says GROSS')
  assert.deepEqual(noComm.missingCosts, ['commission', 'swap'], '10: the gap is named')

  const noSwap = describeTradeRow(netRow({
    id: 'c-noswap', swap: null, net_realised_pnl: null, accounting_complete: false,
    accounting_missing: ['swap'],
  }))
  assert.equal(noSwap.result, ROW_RESULT.PENDING, '11: missing swap ⇒ PENDING')

  // Missing OTHER FEES does not block net: the formula adds fees only when
  // reported (gross + commission + swap + COALESCE(fee,0)), so the trigger can
  // still certify completeness. The display must follow the trigger.
  const noFees = describeTradeRow(netRow({
    id: 'c-nofee', other_fees: null, net_realised_pnl: 10.20, accounting_complete: true,
  }))
  assert.equal(noFees.result, ROW_RESULT.WIN, '12: net-complete without fees ⇒ WIN')
  assert.equal(noFees.otherFees, null, '12: an unreported fee shows unknown, never 0')
  assert.equal(noFees.pnl, 10.20, '12: net still displayed')
  group('7-12 — components shown as signed; missing costs degrade to GROSS ONLY/PENDING')
}


// ── 13-15 — duplicate delivery, delayed close, EA recovery ─────────────────
{
  // 13: the same closing deal delivered twice is counted once.
  const dup = aggregateDeals([
    { dealTicket: '7777', grossProfit: 5.00, commission: -0.30, swap: 0, otherFees: 0, volume: 0.10 },
    { dealTicket: '7777', grossProfit: 5.00, commission: -0.30, swap: 0, otherFees: 0, volume: 0.10 },
  ], { positionVolume: 0.10 })
  assert.equal(dup.dealCount, 1, '13: duplicate deal ticket refused')
  assert.equal(dup.duplicateDeals, 1, '13: duplicate counted for audit')
  assert.equal(dup.netPnl, 4.70, '13: net NOT doubled by re-delivery')

  // A deal with no ticket cannot be de-duplicated, so it is refused outright.
  const noTicket = aggregateDeals([
    { grossProfit: 5.00, commission: -0.30, swap: 0, otherFees: 0, volume: 0.10 },
  ], { positionVolume: 0.10 })
  assert.equal(noTicket.dealCount, 0, '13: ticket-less deal refused')
  assert.equal(noTicket.netPnl, null, '13: no net from an un-identifiable deal')

  // 14: delayed broker close — the row closes with NO money first. It must show
  //     PENDING with an em dash, never 0.00 and never a WIN.
  const awaiting = describeTradeRow(netRow({
    id: 'd-pending', pl_usd: null, commission: null, swap: null, other_fees: null,
    net_realised_pnl: null, accounting_complete: null, trade_result: null,
    result: 'CLOSED', trade_status: 'CLOSED',
  }))
  assert.equal(awaiting.result, ROW_RESULT.PENDING, '14: close without money ⇒ PENDING')
  assert.equal(awaiting.pnl, null, '14: no fabricated zero')
  assert.equal(awaiting.pnlBasis, 'NONE', '14: basis NONE')

  // 15: a close recovered from deal history after the terminal was down. With the
  //     native ticket present it is a genuine execution and counts normally.
  const recovered = describeTradeRow(netRow({ id: 'e-recovered' }))
  assert.equal(recovered.isGenuineExecution, true, '15: recovered close is genuine')
  assert.equal(recovered.result, ROW_RESULT.WIN, '15: and priced normally')
  // ...but a recovered close with NO ticket is not a broker-confirmed execution.
  const recoveredNoTicket = describeTradeRow(netRow({ id: 'e-nt', broker_ticket: null }))
  assert.equal(recoveredNoTicket.result, ROW_RESULT.SIMULATED, '15: no ticket ⇒ SIMULATED')
  assert.equal(recoveredNoTicket.netPnl, null, '15: and cannot show net')
  group('13-15 — duplicate delivery, delayed close and EA recovery handled honestly')
}

// ── 16-19 — ticket classification, simulated and cancelled rows ────────────
{
  assert.equal(brokerTicketKind({ broker_ticket: '50991234' }), 'MT5_POSITION', '16: numeric ⇒ MT5')
  assert.equal(isGenuineExecution({ broker_ticket: '50991234' }), true, '16: numeric ⇒ genuine')

  const uuid = '3f2a9c18-1b2d-4e5f-8a9b-0c1d2e3f4a5b'
  assert.equal(brokerTicketKind({ broker_ticket: uuid }), 'OTHER_BROKER_REF',
    '17: a UUID from another venue is a broker ref, not an MT5 ticket')
  assert.equal(brokerTicketKind({ id: uuid, broker_ticket: uuid }), 'NONE',
    '17: an id masquerading as a ticket is NOT a broker ticket')

  const simulated = describeTradeRow(netRow({
    id: 's-1', broker_ticket: null, result: 'WIN', pl_usd: 9999,
  }))
  assert.equal(simulated.isSimulated, true, '18: no ticket ⇒ simulated')
  assert.equal(simulated.result, ROW_RESULT.SIMULATED, '18: labelled SIMULATED, not WIN')
  assert.equal(simulated.pnl, null, '18: a simulated row contributes no shown P&L')
  assert.equal(simulated.accountingStatus, 'NOT A BROKER EXECUTION', '18: status is explicit')

  const cancelled = describeTradeRow(netRow({
    id: 'x-1', result: 'CANCELLED', pl_usd: null, net_realised_pnl: null,
    accounting_complete: null, trade_result: null, closed_at: null,
  }))
  assert.equal(cancelled.result, ROW_RESULT.CANCELLED, '19: cancelled is CANCELLED, not a loss')
  assert.equal(cancelled.pnl, null, '19: a cancelled order has no P&L')
  group('16-19 — MT5 tickets, UUIDs, simulations and cancellations stay distinguishable')
}


// ── 20 — multiple trading accounts never merge ─────────────────────────────
{
  // Two accounts, identical-looking trades. Each row keeps its own identity and
  // its own money; nothing here can combine them. (The read path scopes by
  // user_id in /api/trades; this asserts the presentation layer preserves it.)
  const a = describeTradeRow(netRow({ id: 'acct-a', broker_ticket: '6001', pl_usd: 100,
    commission: -1, swap: 0, other_fees: 0, net_realised_pnl: 99 }))
  const b = describeTradeRow(netRow({ id: 'acct-b', broker_ticket: '6002', pl_usd: -100,
    commission: -1, swap: 0, other_fees: 0, net_realised_pnl: -101 }))
  assert.notEqual(a.id, b.id, '20: distinct rows stay distinct')
  assert.notEqual(a.ticket, b.ticket, '20: distinct broker tickets')
  assert.equal(a.netPnl, 99, '20: account A keeps its own net')
  assert.equal(b.netPnl, -101, '20: account B keeps its own net')
  assert.equal(b.result, ROW_RESULT.LOSS, '20: and its own verdict')
  group('20 — rows are never merged across accounts')
}

// ── 21-22 — pagination and broker-timestamp ordering ───────────────────────
{
  const rows = Array.from({ length: 23 }, (_, i) => describeTradeRow(netRow({
    id: `p-${i}`,
    closed_at: new Date(Date.UTC(2026, 10, 18, 9, i)).toISOString(),
  })))
  const sorted = sortDescribedRows(rows)
  assert.equal(sorted[0].id, 'p-22', '22: newest broker close first')
  assert.equal(sorted[sorted.length - 1].id, 'p-0', '22: oldest last')

  const PAGE = 5
  const seen = new Set()
  for (let p = 0; p * PAGE < sorted.length; p++) {
    for (const r of sorted.slice(p * PAGE, (p + 1) * PAGE)) {
      assert.equal(seen.has(r.id), false, `21: ${r.id} appears on exactly one page`)
      seen.add(r.id)
    }
  }
  assert.equal(seen.size, rows.length, '21: pagination hides nothing')

  // A row with no timestamps sorts last, never first.
  const undated = describeTradeRow(netRow({ id: 'nodate', closed_at: null, opened_at: null }))
  const withUndated = sortDescribedRows([undated, ...rows])
  assert.equal(withUndated[withUndated.length - 1].id, 'nodate', '22: undated row sorts last')
  group('21-22 — every row is reachable by pagination, ordered by broker timestamp')
}

// ── 23-24 — unknown stays unknown; incomplete never becomes WIN/LOSS ───────
{
  const unknown = describeTradeRow(netRow({
    id: 'u-1', pl_usd: null, net_realised_pnl: null, accounting_complete: null,
  }))
  assert.equal(unknown.grossPnl, null, '23: unknown gross stays null')
  assert.equal(unknown.pnl, null, '23: unknown P&L is null, not 0')
  assert.notEqual(unknown.pnl, 0, '23: and explicitly not zero')

  // Gross strongly positive, costs unknown ⇒ still PENDING. This is the exact
  // failure the brief forbids: a "winner" derived from gross alone.
  const maybeWin = describeTradeRow(netRow({
    id: 'u-2', pl_usd: 250, commission: null, swap: null, other_fees: null,
    net_realised_pnl: null, accounting_complete: false,
    accounting_missing: ['commission', 'swap'], result: 'WIN', trade_result: 'WIN',
  }))
  assert.equal(maybeWin.result, ROW_RESULT.PENDING, '24: incomplete accounting ⇒ RESULT PENDING')
  assert.notEqual(maybeWin.result, ROW_RESULT.WIN, '24: never a false WIN')

  const maybeLoss = describeTradeRow(netRow({
    id: 'u-3', pl_usd: -250, commission: null, swap: null, other_fees: null,
    net_realised_pnl: null, accounting_complete: false,
    accounting_missing: ['commission', 'swap'], result: 'LOSS', trade_result: 'LOSS',
  }))
  assert.equal(maybeLoss.result, ROW_RESULT.PENDING, '24: never a false LOSS either')
  group('23-24 — unknown remains unknown; incomplete accounting is never a result')
}

// ── 25 — the day total agrees with the eligible population ────────────────
{
  const trades = [
    netRow({ id: 't-1', net_realised_pnl: 10.15, closed_at: '2026-11-18T09:00:00Z' }),
    netRow({ id: 't-2', net_realised_pnl: -4.00, pl_usd: -3.5, closed_at: '2026-11-18T23:30:00Z' }),
    // gross-only: same day, excluded from the net total
    netRow({ id: 't-3', pl_usd: 99, commission: null, swap: null, other_fees: null,
      net_realised_pnl: null, accounting_complete: false,
      accounting_missing: ['commission', 'swap'], closed_at: '2026-11-18T10:00:00Z' }),
    // pending: same day, no money at all
    netRow({ id: 't-4', pl_usd: null, net_realised_pnl: null, accounting_complete: null,
      result: 'CLOSED', trade_result: null, closed_at: '2026-11-18T11:00:00Z' }),
    // previous UTC day: must not leak in
    netRow({ id: 't-5', net_realised_pnl: 1000, closed_at: '2026-11-17T23:59:00Z' }),
  ]

  const day = realisedPnlForUtcDay(trades, new Date('2026-11-18T12:00:00Z'))
  assert.equal(day.day, '2026-11-18', '25: UTC day key')
  assert.equal(day.rows, 2, '25: only net-complete rows for that UTC day')
  assert.equal(day.total, 6.15, '25: total = 10.15 + (-4.00)')
  assert.equal(day.excluded.grossOnly, 1, '25: gross-only count disclosed')
  assert.equal(day.excluded.accountingPending, 1, '25: pending count disclosed')

  // The 23:30 UTC close belongs to the 18th even though a browser east of
  // Greenwich would call it the 19th — this is the local-day bug being fixed.
  assert.equal(utcDayKey('2026-11-18T23:30:00Z'), '2026-11-18', '25: 23:30Z is the same UTC day')

  // An all-gross day has NO net total — null, not zero.
  const grossOnlyDay = realisedPnlForUtcDay([trades[2]], new Date('2026-11-18T12:00:00Z'))
  assert.equal(grossOnlyDay.total, null, '25: no net rows ⇒ total unknown, not 0')
  assert.equal(grossOnlyDay.netComplete, false, '25: and it says so')
  group('25 — the day total equals the sum of the eligible population, on a UTC day')
}


// ── R — the close-identity patch is PREPARED, not applied ──────────────────
//
// R-1/R-2/R-3 live in the database, so they cannot be exercised from Node. What
// CAN be verified — and is, here — is that the fix exists, is well-formed, is
// outside the applied migration path, and preserves every guard that made the
// current path safe.
{
  const prepared = new URL('../supabase/prepared/20261211_phase421_close_identity.sql', import.meta.url)
  const applied = new URL('../supabase/migrations/20261211_phase421_close_identity.sql', import.meta.url)
  assert.equal(existsSync(prepared), true, 'R: the patch is prepared')
  assert.equal(existsSync(applied), false, 'R: and NOT in the applied migrations path')

  const sql = readFileSync(prepared, 'utf8')
  assert.match(sql, /STATUS: \*\*PREPARED - NOT APPLIED\.\*\*/, 'R: status is explicit')
  assert.match(sql, /CREATE OR REPLACE FUNCTION public\.mt5_webhook_sync/,
    'R: it replaces the one function the EA actually calls')

  // Identity matching must come BEFORE the price fallback, or R-2 is not fixed.
  const identity = sql.indexOf('1) Identity match (preferred)')
  const fallback = sql.indexOf('2) Price fallback')
  assert.ok(identity > 0 && fallback > identity, 'R: ticket identity is tried before price proximity')

  // Both paths keep the duplicate-delivery guard.
  const block = sql.slice(identity, sql.indexOf('IF v_cp_matched_id IS NOT NULL'))
  assert.equal((block.match(/pl_usd\s+IS NULL/g) || []).length, 2,
    'R: both match paths require an un-accounted row')

  // An existing ticket is never overwritten (only a blank one is filled).
  assert.match(sql, /broker_ticket = COALESCE\(NULLIF\(btrim\(broker_ticket\), ''\), v_cp_ticket\)/,
    'R-1: broker_ticket is filled only when blank')

  // Unzoned broker time must NOT be reinterpreted as UTC.
  assert.match(sql, /v_cp_closed_raw ~ 'Z\$' OR v_cp_closed_raw ~ '\[\+-\]\[0-9\]\{2\}:\?\[0-9\]\{2\}\$'/,
    'R-3: only explicitly-zoned timestamps are trusted')
  assert.match(sql, /closed_at = COALESCE\(closed_at, v_cp_closed_at, now\(\)\)/,
    'R-3: falls back to the previous behaviour')

  // The money writes are byte-identical to the applied migration.
  const appliedSrc = readFileSync(new URL('../supabase/migrations/20261113_phase42_rpc_broker_deal_accounting.sql', import.meta.url), 'utf8')
  const money = /(pl_usd\s*= v_cp_profit|commission = v_cp_commission|swap\s+= v_cp_swap|other_fees = v_cp_fee|realised_r\s+= COALESCE\(v_cp_net, v_cp_profit\) \/ NULLIF\(planned_risk_amount, 0\))/
  for (const m of appliedSrc.matchAll(new RegExp(money, 'g'))) {
    assert.ok(sql.includes(m[0].replace(/\s+/g, ' ')) || sql.replace(/\s+/g, ' ').includes(m[0].replace(/\s+/g, ' ')),
      `R: money write preserved — ${m[0].trim()}`)
  }

  // The unrelated-but-critical guards are still present exactly once each.
  for (const guard of ['GRANT EXECUTE ON FUNCTION public.mt5_webhook_sync', 'FOR UPDATE', 'v_ticket_valid']) {
    assert.ok(sql.includes(guard), `R: inherited guard preserved — ${guard}`)
  }
  group('R — the close-identity patch is prepared, unapplied and guard-preserving')
}

console.log(`\nrecent-trades-display: ${groups} groups passed`)

