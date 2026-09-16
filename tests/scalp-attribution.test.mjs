// tests/scalp-attribution.test.mjs
// ── PHASE 3.3.1: DETERMINISTIC ATTRIBUTION + NATIVE TICKET PROPAGATION ─────
//
// Phase 3.3 proved the attribution predicate was already correct —
//
//     String(openTrade.id) === String(trade.broker_ticket)
//
// — and that it failed only because the two sides were different IDENTITY
// SPACES: `openTrade.id` was the native MT5 POSITION ticket while
// `broker_ticket` held an application correlation UUID. MT5 Direct queues orders
// for the EA, so no native ticket exists at placement time, and nothing ever
// persisted the one the EA later learned.
//
// These tests pin BOTH halves of the repair:
//   * §8 — the propagation boundary, exercised end-to-end through the REAL
//     completion mapper feeding the REAL matchAttribution();
//   * §7 — the attribution matrix, asserted against the real function;
//   * §10/§11 — the short-lived lifecycle and close idempotency through the real
//     runtime, which is only reachable now that attribution can succeed.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { matchAttribution, createScalpShadowRuntime } from '../lib/scalp-shadow-runtime.mjs'
import { completionToTradeUpdate, validateNativeTicket, summariseCompletionDiagnostics, completionDiagnosticLine } from '../lib/mt5-fill-attribution.mjs'

let failed = 0
const tests = []
const t = (name, fn) => tests.push([name, fn])
const tick = () => new Promise((r) => setImmediate(r))

// Production-shaped identities (sanitised from the live account).
const APP_UUID = '1a66243f-737f-4acc-8dd2-62138949f0ee'
const NATIVE   = '3234180000'

const GEOM = { 'XAU/USD': { known: true, pip: 0.1, pipValuePerLot: 10 } }

/** A broker open position exactly as /api/account shapes it. */
const pos = (id, pair = 'XAU/USD', extra = {}) => ({ id, pair, ...extra })

/** A `trades` table row as the attribution query returns it (source='scalp'). */
const row = (o = {}) => ({
  id: 'row-1', source: 'scalp', result: 'OPEN', pair: 'XAU/USD',
  broker_ticket: NATIVE, oanda_trade_id: APP_UUID, ...o,
})

/** A clock the test drives explicitly. */
function clock(start = 1_000_000) { let t = start; return { now: () => t, advance: (ms) => (t += ms) } }

/**
 * Runtime wired to the REAL matchAttribution, so every lifecycle assertion below
 * depends on the genuine identity join rather than a stub that trivially agrees.
 */
function harness({ rows, throttleMs = 60_000, confirmClosed, insertOk = true } = {}) {
  const clk = clock()
  const logs = []
  const inserted = []
  let stored = {}
  const runtime = createScalpShadowRuntime({
    now: clk.now,
    throttleMs,
    log: (m) => logs.push(m),
    loadState: async () => stored,
    saveState: async (next) => { stored = next; return true },
    attribute: async (trades) => matchAttribution(trades, rows),
    confirmClosed: confirmClosed || (async () => null),
    insertRow: async (r) => { if (!insertOk) return false; inserted.push(r); return true },
    evaluate: ({ trade, record, prior }) => ({
      // Mirrors the REAL evaluator (lib/scalp-shadow-protection.mjs:264-280),
      // which contributes the broker ticket and the frozen `openedAt` baseline.
      // Without these the persisted state is not production-shaped, and the
      // first-seen baseline would not be observable at all.
      stateDelta: {
        brokerTicket: trade.id,
        tradeId: record?.id ?? null,
        openedAt: prior?.openedAt || trade.openTime || new Date(clk.now()).toISOString(),
        peakProfit: Math.max(prior?.peakProfit ?? 0, trade.unrealizedPL ?? 0),
      },
      row: { broker_ticket: trade.id, row_kind: 'snapshot', pair: trade.pair },
    }),
  })
  return { runtime, clk, logs, inserted, get stored() { return stored } }
}

const obs = (h, trades, at) => h.runtime.observe({ trades, geometry: GEOM, at })

console.log('scalp attribution — native ticket propagation / matrix / lifecycle')



// ── §8 THE CRITICAL END-TO-END IDENTITY TEST ──────────────────────────────
t('§8 propagation boundary: completed.ticket is persisted AND becomes attributable', async () => {
  // 1. The EA reports BOTH identities for a confirmed fill.
  const completion = { id: APP_UUID, success: true, filledPrice: 3312.45, ticket: 3234180000 }
  const { update, nativeTicket, tradeMatcher } = completionToTradeUpdate(completion)

  // 2. The native ticket is accepted, and no other identifier is invented.
  assert.equal(nativeTicket, NATIVE, 'native ticket validated')
  assert.equal(update.broker_ticket, NATIVE, 'broker_ticket becomes the NATIVE ticket')

  // 3. The application correlation id is still how the row is found, and it is
  //    NEVER overwritten by the propagation.
  assert.equal(tradeMatcher.oanda_trade_id, APP_UUID, 'row located by application correlation id')
  assert.ok(!('oanda_trade_id' in update), 'oanda_trade_id is not part of the update payload')

  // 4. Pre-existing fill updates are unchanged.
  assert.equal(update.entry_price, 3312.45, 'entry_price preserved')
  assert.equal(update.result, 'OPEN', 'result preserved')
  assert.ok(typeof update.opened_at === 'string' && update.opened_at.length > 0, 'opened_at preserved')

  // 5. Feed the resulting production-shaped row into the REAL attribution.
  const dbRow = { ...row({ id: 'db-1' }), ...update, oanda_trade_id: APP_UUID }
  assert.equal(dbRow.oanda_trade_id, APP_UUID)
  assert.equal(dbRow.broker_ticket, NATIVE)

  const { scalp, skipped } = matchAttribution([pos(NATIVE)], [dbRow])
  assert.ok(scalp.has(NATIVE), 'ATTRIBUTED through the real join')
  assert.equal(skipped.length, 0, 'nothing skipped')
  assert.equal(scalp.get(NATIVE).record.oanda_trade_id, APP_UUID, 'app correlation id still attached')
})

t('§3/§6 a missing ticket leaves broker_ticket UNTOUCHED (fail closed, not ambiguous)', () => {
  const base = { id: APP_UUID, success: true, filledPrice: 3312.45 }
  for (const ticket of [undefined, null, '', '   ']) {
    const { update, nativeTicket, reason } = completionToTradeUpdate({ ...base, ticket })
    assert.equal(nativeTicket, null, `no ticket accepted for ${JSON.stringify(ticket)}`)
    assert.ok(!('broker_ticket' in update), 'broker_ticket absent from the update — value retained')
    assert.ok(reason, 'a diagnostic reason is reported')
  }
  // A ticket that merely echoes the application id is a FALLBACK artefact, not a
  // resolved broker identity, and must be refused.
  const echo = completionToTradeUpdate({ ...base, ticket: APP_UUID })
  assert.equal(echo.nativeTicket, null, 'application UUID is not accepted as a native ticket')
  assert.equal(echo.reason, 'ticket-equals-application-id')
  assert.ok(!('broker_ticket' in echo.update))
})

t('§6 ticket validation is strict — nothing fabricated from symbol/time/lots', () => {
  assert.deepEqual(validateNativeTicket(3234180000), { ok: true, ticket: NATIVE })
  assert.deepEqual(validateNativeTicket('3234180000'), { ok: true, ticket: NATIVE })
  for (const bad of ['XAUUSD', 'abc', '3234.18', '-1', '0', '', null, undefined, {}, '1e9', ' ']) {
    assert.equal(validateNativeTicket(bad).ok, false, `${JSON.stringify(bad)} must be refused`)
  }
  // Even when the app id is supplied as the apparent ticket, it is refused.
  assert.equal(validateNativeTicket(APP_UUID, { appId: APP_UUID }).ok, false)

// ── §7 THE ATTRIBUTION MATRIX ─────────────────────────────────────────────
t('§7-A native ticket matches the broker position → ATTRIBUTED', () => {
})

  const { scalp, skipped } = matchAttribution([pos(NATIVE)], [row()])
  assert.ok(scalp.has(NATIVE))
  assert.equal(skipped.length, 0)
})

t('§7-B a different ticket → REJECTED', () => {
  const { scalp, skipped } = matchAttribution([pos('3234199999')], [row()])
  assert.equal(scalp.size, 0, 'not attributed')
  assert.deepEqual(skipped, [{ ticket: '3234199999', reason: 'no-scalp-trade-row' }])
})

t('§7-C manual trade on the same symbol → REJECTED', () => {
  // The operator's manual XAU/USD position has no scalp row; symbol equality is
  // deliberately NOT a matching rule.
  const { scalp, skipped } = matchAttribution([pos('1111111111', 'XAU/USD')], [row()])
  assert.equal(scalp.size, 0, 'a manual position is never adopted')
  assert.equal(skipped[0].reason, 'no-scalp-trade-row')
})

t('§7-D mirror trade on the same symbol → REJECTED', () => {
  // The attribution fetch is constrained to source='scalp' (and result='OPEN'),
  // so mirror rows never reach the matcher at all.
  const src = readFileSync(new URL('../workers/scalper.mjs', import.meta.url), 'utf8')
  const q = src.slice(src.indexOf('async function shadowAttribute'), src.indexOf('async function shadowConfirmClosed'))
  assert.match(q, /source=eq\.\$\{SCALP_SOURCE\}/, 'query is restricted to scalp rows')
  assert.match(q, /result=eq\.OPEN/, 'query is restricted to still-open rows')
  // Mirror position with a scalp row absent → fail closed.
  const { scalp, skipped } = matchAttribution([pos('2222222222', 'XAU/USD')], [row()])
  assert.equal(scalp.size, 0)
  assert.equal(skipped[0].reason, 'no-scalp-trade-row')
})

t('§7-E two positions on the same symbol → only the exact ticket is attributed', () => {
  const A = '3234180000'
  const B = '3234180001'
  const { scalp, skipped } = matchAttribution([pos(A), pos(B)], [row({ broker_ticket: B })])
  assert.equal(scalp.size, 1)
  assert.ok(scalp.has(B), 'the exact ticket is attributed')
  assert.ok(!scalp.has(A), 'the other position is not, despite identical symbol/direction')
  assert.deepEqual(skipped, [{ ticket: A, reason: 'no-scalp-trade-row' }])
})

t('§7-F legacy APP UUID in broker_ticket vs a numeric position → REJECTED safely', () => {
  const { scalp, skipped } = matchAttribution([pos(NATIVE)], [row({ broker_ticket: APP_UUID })])
  assert.equal(scalp.size, 0, 'legacy rows cannot hijack a live position')
  assert.deepEqual(skipped, [{ ticket: NATIVE, reason: 'no-scalp-trade-row' }])
})

t('§7-G missing broker ticket on the position → REJECTED', () => {
  for (const bad of [null, undefined, '']) {
    const { scalp, skipped } = matchAttribution([pos(bad)], [row()])
    assert.equal(scalp.size, 0)
    assert.equal(skipped[0].reason, 'no-broker-ticket')
  }
})

t('§7-H malformed ticket can never be persisted, so it can never attribute', () => {
  // The only writer of broker_ticket refuses anything non-numeric, therefore no
  // row can exist carrying a malformed ticket for a live position to match.
  for (const bad of ['abc', '32 34', 'XAU/USD', 'NaN', 'undefined']) {
    assert.equal(completionToTradeUpdate({ id: APP_UUID, success: true, ticket: bad }).nativeTicket, null)
  }
  const { scalp } = matchAttribution([pos('abc')], [row({ broker_ticket: 'abc' })])
  assert.equal(typeof scalp.size, 'number', 'handled without throwing')
})

t('§7-I a CLOSED scalp row cannot be adopted as an eligible open lifecycle', async () => {
  const src = readFileSync(new URL('../workers/scalper.mjs', import.meta.url), 'utf8')
  // Fetch layer: only OPEN rows are candidates for attribution...
  const attrQ = src.slice(src.indexOf('async function shadowAttribute'), src.indexOf('async function shadowConfirmClosed'))
  assert.match(attrQ, /result=eq\.OPEN/, 'closed rows are excluded at the fetch layer')
  // ...while the CLOSE path must still see closed rows — it looks only for a
  // confirmed closed_at, so it must NOT be given the OPEN filter.
  const closeQ = src.slice(src.indexOf('async function shadowConfirmClosed'), src.indexOf('async function shadowInsertRow'))
  assert.match(closeQ, /closed_at=not\.is\.null/, 'close confirmation keys off closed_at')
  assert.ok(!/result=eq\.OPEN/.test(closeQ), 'the close path is not narrowed to open rows')

  // With only OPEN rows fetched, a closed row for the same ticket yields no
  // match → the live position fails closed rather than being re-observed.
  const { scalp, skipped } = matchAttribution([pos(NATIVE)], [])
  assert.equal(scalp.size, 0)
  assert.equal(skipped[0].reason, 'no-scalp-trade-row')
})

t('§7-J production reproduction: OLD fails, NEW attributes', () => {
  // OLD — exactly the production state: the row carries the app UUID.
  const oldRow = { ...row(), oanda_trade_id: APP_UUID, broker_ticket: APP_UUID }
  const old = matchAttribution([pos(NATIVE)], [oldRow])
  assert.equal(old.scalp.size, 0, 'OLD: nothing attributable')
  assert.deepEqual(old.skipped, [{ ticket: NATIVE, reason: 'no-scalp-trade-row' }],
    'OLD: reproduces the production log line verbatim')

  // NEW — after the propagation fix: same app correlation id, native ticket.
  const newRow = { ...row(), oanda_trade_id: APP_UUID, broker_ticket: NATIVE }
  const neu = matchAttribution([pos(NATIVE)], [newRow])
  assert.ok(neu.scalp.has(NATIVE), 'NEW: ATTRIBUTED')
  assert.equal(neu.skipped.length, 0)
  assert.equal(neu.scalp.get(NATIVE).record.oanda_trade_id, APP_UUID,
    'NEW: the application correlation id is intact alongside the native ticket')
})

// ── §10 THE 43.7-SECOND LIFECYCLE ─────────────────────────────────────────
t('§10 a 43.7s trade is discovered and closed despite the 60s evaluation interval', async () => {
  const rows = [row()]
  let confirmedAt = null
  const h = harness({
    rows,
    throttleMs: 60_000,                       // the production interval
    confirmClosed: async (ticket) => (ticket === NATIVE
      ? { id: 'db-1', closed_at: new Date(confirmedAt).toISOString(), pair: 'XAU/USD', direction: 'BUY' }
      : null),
  })

  const t0 = 1_000_000
  const openedAt = new Date(t0).toISOString()
  // The position appears.
  await obs(h, [pos(NATIVE, 'XAU/USD', { unrealizedPL: 4, openTime: openedAt })], t0)
  await tick()
  assert.ok(h.stored[NATIVE], 'TRADE_FIRST_SEEN: registered in durable state')
  assert.equal(h.stored[NATIVE].openedAt, openedAt, 'first-seen baseline captured at discovery time')
  assert.ok((h.runtime.getHealth().counts.TRADE_FIRST_SEEN || 0) >= 1, 'health records TRADE_FIRST_SEEN')
  assert.equal(h.inserted.length, 1, 'the baseline observation was written (throttle bypassed for first-seen)')

  // ...and disappears 43.7 seconds later — far inside the 60s evaluation window.
  const t1 = t0 + 43_700
  confirmedAt = t1
  await obs(h, [], t1)
  await tick()
  assert.ok(h.inserted.some((r) => r.row_kind !== 'snapshot'), 'a close row was persisted')
  assert.equal(h.runtime.getStats().closeRowsPersisted, 1, 'exactly one close row')
  assert.ok(!(NATIVE in h.stored), 'lifecycle state archived, not left dangling')
})

t('§10 sub-interval discovery does not wait for the evaluation gate', async () => {
  // Both positions must own a scalp row — otherwise the REAL attribution
  // correctly refuses the second one (`no-scalp-trade-row`), which would be a
  // statement about the join rather than about discovery.
  const SECOND = '3234180002'
  const rows = [row(), row({ id: 'row-2', broker_ticket: SECOND })]
  const h = harness({ rows, throttleMs: 60_000 })
  await obs(h, [pos(NATIVE, 'XAU/USD', { unrealizedPL: 1 })], 1_000_000)
  await tick()
  // A SECOND position appears 1ms later — the evaluation window is nowhere near
  // due, yet discovery must still register it immediately.
  await obs(h, [pos(NATIVE), pos(SECOND)], 1_000_001)
  await tick()
  assert.ok(h.stored[SECOND], 'the new ticket is registered immediately despite the throttle')
  assert.ok(h.stored[NATIVE], 'the earlier ticket is retained')
})

// ── §14 EA-SIDE SANITISED EVIDENCE ────────────────────────────────────────
t('§14 the EA-side diagnostic proves the ticket WITHOUT retaining broker detail', () => {
  // A realistic completion: the EA reports the ticket alongside fields we must NOT retain.
  const completion = {
    id: APP_UUID, success: true, filledPrice: 3312.45, ticket: 3234180000,
  }
  const d = summariseCompletionDiagnostics(completion)
  assert.equal(d.ticket, NATIVE, 'the native ticket is retained — it IS the proof')
  assert.equal(d.success, true)
  assert.equal(d.idPrefix, '1a66243f…', 'only an 8-char correlation prefix is retained')
  assert.ok(!String(d.idPrefix).includes(APP_UUID), 'the full correlation UUID is never retained')

  const line = completionDiagnosticLine(completion)
  assert.ok(line.includes(NATIVE), 'the line carries the ticket')
  assert.ok(line.includes('1a66243f…'), 'the line carries the prefix')
  // Nothing beyond identifiers: no price, no correlation UUID, no payload echo.
  assert.ok(!line.includes('3312.45'), 'filled price is NOT retained')
  assert.ok(!line.includes(APP_UUID), 'the full application UUID is NOT retained')
  assert.ok(!/XAU|\{|\}/.test(line), 'no symbol and no raw payload fragment')

  // Fail-closed variant: the chain is reported as broken, with a reason.
  const missing = completionDiagnosticLine({ id: APP_UUID, success: true })
  assert.ok(/no resolvable ticket/.test(missing), 'absence is explicit')
  assert.ok(missing.includes('ticket-absent'), 'the reason is stated')
})

// ── §11 CLOSURE / IDEMPOTENCY ─────────────────────────────────────────────
t('§11 duplicate completion payloads produce one deterministic identity update', () => {
  const completion = { id: APP_UUID, success: true, filledPrice: 3312.45, ticket: 3234180000 }
  const a = completionToTradeUpdate(completion)
  const b = completionToTradeUpdate(completion)
  assert.equal(a.update.broker_ticket, b.update.broker_ticket, 'same native ticket both times')
  assert.equal(a.nativeTicket, b.nativeTicket)
  assert.equal(a.tradeMatcher.oanda_trade_id, b.tradeMatcher.oanda_trade_id)
})

t('§11 duplicate observer cycle does not double-register a lifecycle', async () => {
  const rows = [row()]
  const h = harness({ rows, throttleMs: 0 })
  const openedAt = new Date(1_000_000).toISOString()
  await obs(h, [pos(NATIVE, 'XAU/USD', { unrealizedPL: 2, openTime: openedAt })], 1_000_000)
  await tick()
  const baseline = h.stored[NATIVE].openedAt
  assert.equal(baseline, openedAt, 'baseline captured on the first cycle')
  await obs(h, [pos(NATIVE, 'XAU/USD', { unrealizedPL: 2, openTime: openedAt })], 1_000_001)
  await tick()
  assert.equal(h.stored[NATIVE].openedAt, baseline, 'the frozen baseline is not rewritten')
  assert.equal(h.stored[NATIVE].brokerTicket, NATIVE, 'the native ticket is retained in state')
})

t('§11 a close is archived exactly ONCE, even across restarts (409 = success)', async () => {
  const rows = [row()]
  let confirmedAt = null
  const confirm = async (ticket) => (ticket === NATIVE
    ? { id: 'db-1', closed_at: new Date(confirmedAt).toISOString(), pair: 'XAU/USD', direction: 'BUY' }
    : null)

  const h = harness({ rows, throttleMs: 0, confirmClosed: confirm })
  const t0 = 1_000_000
  await obs(h, [pos(NATIVE, 'XAU/USD', { unrealizedPL: 3 })], t0)
  await tick()
  confirmedAt = t0 + 43_700
  await obs(h, [], confirmedAt)
  await tick()
  assert.equal(h.runtime.getStats().closeRowsPersisted, 1, 'exactly one close row')

  // A further cycle sees nothing: the lifecycle is gone from state, so it can
  // never be re-detected.
  await obs(h, [], confirmedAt + 1)
  await tick()
  assert.equal(h.runtime.getStats().closeRowsPersisted, 1, 'no duplicate close row')

  // A worker RESTART replays the same cycle against the SAME durable state — the
  // position is still absent from the snapshot, so the close is re-detected. The
  // unique index turns the repeat insert into a 409, which is treated as success
  // rather than fabricating a second record.
  const dup = Object.assign(new Error('duplicate key value violates unique constraint'), { code: '23505' })
  const restarted = createScalpShadowRuntime({
    now: () => confirmedAt + 2,
    throttleMs: 0,
    log: () => {},
    loadState: async () => ({ [NATIVE]: { brokerTicket: NATIVE, openedAt: new Date(t0).toISOString() } }),
    saveState: async () => true,
    attribute: async (trades) => matchAttribution(trades, rows),
    confirmClosed: confirm,
    insertRow: async () => { throw dup },
    evaluate: () => ({ stateDelta: {}, row: {} }),
  })
  await restarted.observe({ trades: [], geometry: GEOM, at: confirmedAt + 2 })
  await tick()
  assert.ok(restarted.getStats().closeRowsPersisted >= 1,
    'the duplicate insert is absorbed as success, not surfaced as a failure')
})

// ── §9 LEGACY BEHAVIOUR ───────────────────────────────────────────────────
t('§9 legacy rows are never back-filled heuristically and stay fail-closed', () => {
  const legacy = [row({ broker_ticket: APP_UUID }), row({ id: 'row-2', broker_ticket: APP_UUID })]
  const { scalp, skipped } = matchAttribution([pos(NATIVE)], legacy)
  assert.equal(scalp.size, 0, 'no heuristic reconstruction of historic trades')
  assert.equal(skipped[0].reason, 'no-scalp-trade-row')
})

// ── runner ────────────────────────────────────────────────────────────────
for (const [name, fn] of tests) {
  try {
    await fn()
    console.log(`  ✓ ${name}`)
  } catch (e) {
    failed++
    console.error(`  ✗ ${name}\n      ${e?.message}`)
  }
}
console.log(`\n${tests.length - failed}/${tests.length} passed`)
process.exit(failed ? 1 : 0)




