// tests/broker-deal-ingest.test.mjs
// Phase 4.2B — EA deal-level accounting ingestion.
//
// Covers: payload version negotiation, signed commission/swap/fee, legacy
// payloads, partial closes, duplicate deal tickets, invalid and implausible
// values, net cross-check disagreement, and the exact DB patch produced.
// Run: npm run test:broker-deal-ingest
import assert from 'node:assert/strict'
import {
  PAYLOAD_VERSION, resolvePayloadVersion, parseClosedPositionAccounting,
  buildCloseAccountingPatch, accountingVerdict,
} from '../lib/broker-deal-ingest.mjs'

// A realistic Exness XAUUSD close: commission and swap are NEGATIVE charges.
const v2cp = (o = {}) => ({
  ticket: '3454451953', symbol: 'XAUUSD', type: 'SELL',
  openPrice: 2412.35, closePrice: 2401.10, lots: 0.05,
  grossProfit: 56.25, commission: -1.75, swap: -0.90, fee: 0,
  netProfit: 53.60, dealCount: 2, dealTickets: '900001,900002',
  volumeClosed: 0.05, partial: false,
  ...o,
})

// ── A — v2 payload carries the components through untouched ────────────────
{
  const pv = resolvePayloadVersion({ executionPayloadVersion: 2, eaVersion: '9.40' })
  assert.equal(pv.legacy, false, 'A: v2 is not legacy')
  assert.equal(pv.eaVersion, '9.40', 'A: eaVersion is echoed for the integrity panel')

  const p = parseClosedPositionAccounting(v2cp(), { payloadVersion: 2 })
  assert.equal(p.gross, 56.25, 'A: gross is DEAL_PROFIT, not the net lump')
  assert.equal(p.commission, -1.75, 'A: signed commission preserved')
  assert.equal(p.swap, -0.90, 'A: signed swap preserved')
  assert.equal(p.fee, 0, 'A: an explicit zero fee stays zero')
  assert.equal(p.tradeable, true, 'A: close is tradeable')
  assert.deepEqual(p.problems, [], 'A: a clean v2 payload yields no problems')

  const v = accountingVerdict(p)
  assert.equal(v.complete, true, 'A: every cost term known -> complete')
  assert.equal(v.net, 53.6, 'A: net = 56.25 - 1.75 - 0.90 + 0')
  console.log('PASS A: v2 gross/commission/swap/fee parsed signed and net is reproducible')
}

// ── B — a legacy (v9.3.1) payload invents nothing ──────────────────────────
{
  const legacyCp = {
    ticket: '3454458505', symbol: 'XAUUSD', type: 'SELL',
    openPrice: 2412.0, closePrice: 2401.0, lots: 0.05,
    profit: 51.00, mfe: 12.0, mae: -4.0,
  }
  const pv = resolvePayloadVersion({})
  assert.equal(pv.legacy, true, 'B: missing version is treated as legacy')

  const p = parseClosedPositionAccounting(legacyCp, { payloadVersion: pv.version })
  assert.equal(p.gross, 51.0, 'B: `profit` is still used as the gross evidence')
  assert.equal(p.commission, null, 'B: commission is NULL, never 0')
  assert.equal(p.swap, null, 'B: swap is NULL, never 0')
  assert.ok(p.problems.includes('legacy_payload_no_components'), 'B: the reason is recorded')

  const v = accountingVerdict(p)
  assert.equal(v.complete, false, 'B: a legacy payload can never be net-complete')
  assert.deepEqual(v.missing, ['commission', 'swap'], 'B: the missing terms are named')

  // The patch must OMIT the cost keys entirely. Writing null would be
  // indistinguishable from "the broker says zero" and would fire the trigger.
  const patch = buildCloseAccountingPatch(p, { payloadVersion: pv.version })
  assert.equal('commission' in patch, false, 'B: commission key omitted')
  assert.equal('swap' in patch, false, 'B: swap key omitted')
  assert.equal('other_fees' in patch, false, 'B: other_fees key omitted')
  assert.equal(patch.pl_usd, 51.0, 'B: gross is still stored')
  console.log('PASS B: legacy payloads stay gross-only; no zero is invented')
}

// ── C — partial closes: multiple deals, volume short of the position ───────
{
  const p = parseClosedPositionAccounting(v2cp({
    dealCount: 3, dealTickets: '900010,900011,900012',
    volumeClosed: 0.03, partial: true,
    grossProfit: 20.0, commission: -1.05, swap: -0.30, fee: 0, netProfit: 18.65,
  }), { payloadVersion: 2 })
  assert.equal(p.dealCount, 3, 'C: every deal is counted')
  assert.equal(p.dealTickets.length, 3, 'C: every deal ticket is retained as evidence')
  assert.equal(p.partial, true, 'C: partial close is flagged')
  assert.equal(p.volumeClosed, 0.03, 'C: closed volume below the position volume')
  assert.deepEqual(p.problems, [], 'C: consistent partial close yields no problems')
  console.log('PASS C: partial closes retain all deals, tickets and volume')
}

// ── D — duplicate / inconsistent deal ticket evidence is flagged ──────────
{
  const p = parseClosedPositionAccounting(v2cp({
    dealCount: 3, dealTickets: '900001,900002',
  }), { payloadVersion: 2 })
  assert.ok(p.problems.includes('deal_ticket_count_mismatch'), 'D: count/ticket mismatch flagged')

  const missingTickets = parseClosedPositionAccounting(v2cp({
    dealCount: 0, dealTickets: '',
  }), { payloadVersion: 2 })
  assert.ok(missingTickets.problems.includes('missing_deal_tickets'), 'D: absent tickets flagged')

  // Money is still usable, so the close is not dropped - it is recorded and
  // flagged, which is the difference between quarantine and data loss.
  assert.equal(missingTickets.tradeable, true, 'D: flagged but still tradeable')
  console.log('PASS D: inconsistent deal evidence is flagged, not silently dropped')
}

// ── E — invalid and implausible values become NULL, never a number ────────
{
  const bad = parseClosedPositionAccounting(v2cp({ commission: 'abc' }), { payloadVersion: 2 })
  assert.equal(bad.commission, null, 'E: unparseable commission is null')
  assert.ok(bad.problems.includes('invalid_commission'), 'E: invalid commission named')

  const huge = parseClosedPositionAccounting(v2cp({ swap: -99999 }), { payloadVersion: 2 })
  assert.equal(huge.swap, null, 'E: implausible swap is discarded')
  assert.ok(huge.problems.includes('implausible_swap'), 'E: implausible swap named')

  const absent = parseClosedPositionAccounting(v2cp({ fee: undefined }), { payloadVersion: 2 })
  assert.equal(absent.fee, null, 'E: absent fee is null')
  assert.ok(absent.problems.includes('missing_fee'), 'E: absent fee named')
  console.log('PASS E: invalid, implausible and absent costs are never turned into numbers')
}

// ── F — the EA's own arithmetic is cross-checked ──────────────────────────
{
  const p = parseClosedPositionAccounting(v2cp({ netProfit: 40.00 }), { payloadVersion: 2 })
  assert.ok(p.problems.includes('net_disagrees_with_components'),
    'F: net that does not equal gross+costs is flagged for review')
  assert.equal(p.commission, -1.75, 'F: broker terms are still kept as source of truth')
  console.log('PASS F: a net figure inconsistent with its components is flagged')
}

// ── G — no gross at all is not a tradeable close ──────────────────────────
{
  const p = parseClosedPositionAccounting({ symbol: 'XAUUSD', dealCount: 1 }, { payloadVersion: 2 })
  assert.equal(p.gross, null, 'G: gross missing')
  assert.equal(p.tradeable, false, 'G: row is not tradeable')
  assert.ok(p.problems.includes('missing_gross'), 'G: reason recorded')
  console.log('PASS G: a close with no financial value is refused, not guessed')
}

// ── H — the patch writes exactly the columns the trigger reads ────────────
{
  const p = parseClosedPositionAccounting(v2cp(), { payloadVersion: 2 })
  const patch = buildCloseAccountingPatch(p, { payloadVersion: 2 })
  assert.equal(patch.pl_usd, 56.25, 'H: pl_usd is gross')
  assert.equal(patch.commission, -1.75, 'H: commission written through')
  assert.equal(patch.swap, -0.90, 'H: swap written through')
  assert.equal(patch.other_fees, 0, 'H: fee written to other_fees')
  assert.equal(PAYLOAD_VERSION, 2, 'H: contract version is 2')
  console.log('PASS H: patch targets exactly pl_usd/commission/swap/other_fees')
}

console.log('\nbroker-deal-ingest: all groups passed')

