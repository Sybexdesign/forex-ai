// tests/mt5-native-ticket-migration.test.mjs
// ── PHASE 3.3.3: THE RPC CONSUMES completedOrders[].ticket ──────────────────
//
// Phase 3.3.2 proved the EA never calls app/api/mt5-sync/route.ts — it posts to
// the Supabase RPC public.mt5_webhook_sync, which read only id/success/filledPrice
// and discarded the native ticket. So no live path could ever satisfy:
//
//     String(openTrade.id) === String(trade.broker_ticket)
//
// superseded by: 20261003_mt5_native_position_ticket.sql, which adds exactly one
// behaviour: on a successful completion, persist a VALIDATED native MT5 position
// ticket into trades.broker_ticket.
//
// ── HOW THIS IS TESTED WITHOUT A DATABASE ──────────────────────────────────
//
// No Postgres server is available in this environment, so the SQL cannot be
// executed here. Two things are therefore done instead, and neither is a
// source-text formality:
//
//   1. THE SQL's OWN PREDICATES ARE PARSED OUT OF THE FILE and used to build the
//      validator under test. If a later edit changes, weakens or deletes a guard,
//      the parse changes and the expectations below break — the test cannot
//      silently drift from the migration.
//   2. The RPC's success branch is MODELLED faithfully in JS (locate by
//      oanda_trade_id + user + result='OPEN'; COALESCE the fill fields; CASE the
//      ticket) and the row transitions are asserted for every case.
//
// The app-side validator (lib/mt5-fill-attribution.mjs) is cross-checked against
// the SQL's rules on the same matrix so the two implementations cannot disagree
// on any input that matters. Where the SQL is deliberately STRICTER, that is
// asserted explicitly rather than glossed over.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { validateNativeTicket } from '../lib/mt5-fill-attribution.mjs'
import { matchAttribution } from '../lib/scalp-shadow-runtime.mjs'

let failed = 0
const tests = []
const t = (name, fn) => tests.push([name, fn])

const SQL = readFileSync(
  new URL('../supabase/migrations/20261003_mt5_native_position_ticket.sql', import.meta.url), 'utf8')

// ── 1. Bind to the SQL's actual predicates ────────────────────────────────
const digitsPat = SQL.match(/v_ticket\s*~\s*'([^']+)'/)?.[1]
const zeroPat   = SQL.match(/v_ticket\s*!~\s*'([^']+)'/)?.[1]
const maxLen    = Number(SQL.match(/length\(v_ticket\)\s*<=\s*(\d+)/)?.[1])
const usesBtrim = /NULLIF\(btrim\(v_completed->>'ticket'\), ''\)/.test(SQL)
const guardsAppId = /v_ticket\s*<>\s*v_order_id/.test(SQL)

/** The native-ticket rule exactly as the migration expresses it. */
function sqlTicketValid(raw, appId) {
  const trimmed = raw === null || raw === undefined ? '' : String(raw).trim()
  const v = trimmed === '' ? null : trimmed          // NULLIF(btrim(x), '')
  return v !== null
    && new RegExp(digitsPat).test(v)                 // ~ '^[0-9]+$'
    && !new RegExp(zeroPat).test(v)                  // !~ '^0+$'
    && v.length <= maxLen                            // length(v_ticket) <= N
    && v !== String(appId)                           // <> v_order_id
}

// ── 2. A faithful model of the RPC's completedOrders success branch ───────
const APP_UUID = '1a66243f-737f-4acc-8dd2-62138949f0ee'
const NATIVE   = '3234260579'
const NOW      = '2026-10-03T00:00:00.000Z'

const rowOf = (o = {}) => ({
  user_id: 'u-1', oanda_trade_id: APP_UUID, broker_ticket: APP_UUID,
  result: 'OPEN', entry_price: null, opened_at: null, pair: 'XAU/USD', ...o,
})

/**
 * Model of the migration's success branch:
 *
 *   v_ticket := NULLIF(btrim(completed->>'ticket'), '');
 *   v_ticket_valid := v_ticket IS NOT NULL AND ... ;
 *   UPDATE trades SET entry_price = COALESCE(v_filled_price, entry_price),
 *                     opened_at   = COALESCE(opened_at, now()),
 *                     result      = 'OPEN',
 *                     broker_ticket = CASE WHEN v_ticket_valid THEN v_ticket
 *                                          ELSE broker_ticket END
 *    WHERE user_id = v_user_id AND oanda_trade_id = v_order_id AND result = 'OPEN';
 */
function applyCompletions(rows, userId, completed) {
  const v_order_id = completed?.id === null || completed?.id === undefined ? null : String(completed.id)
  const v_success  = completed?.success === true
  const v_price    = completed?.filledPrice === null || completed?.filledPrice === undefined
    ? null : Number(completed.filledPrice)
  const v_ticket   = completed?.ticket === null || completed?.ticket === undefined
    ? null : (String(completed.ticket).trim() || null)
  const valid      = sqlTicketValid(completed?.ticket, completed?.id ?? null)

  // The failure branch (result='CANCELLED') is untouched by this migration; it
  // is modelled only to prove the success branch is not entered.
  if (!(v_success && v_order_id !== null && userId != null)) {
    return rows.map((r) => {
      if (r.user_id !== userId || r.oanda_trade_id !== v_order_id || r.result !== 'OPEN') return r
      return { ...r, result: 'CANCELLED' }
    })
  }

  return rows.map((r) => {
    if (r.user_id !== userId || r.oanda_trade_id !== v_order_id || r.result !== 'OPEN') return r
    return {
      ...r,
      entry_price:   v_price ?? r.entry_price ?? null,
      opened_at:     r.opened_at ?? NOW,
      result:        'OPEN',
      broker_ticket: valid ? v_ticket : r.broker_ticket,
    }
  })
}
const one = (rows) => rows[0]

console.log('mt5 native position ticket — webhook sync contract')

// ── §8-A valid ticket -> broker_ticket becomes the NATIVE ticket ──────────
t('§8-A valid ticket: broker_ticket becomes native, oanda_trade_id preserved', () => {
  const rows = applyCompletions([rowOf()], 'u-1',
    { id: APP_UUID, success: true, filledPrice: 3312.45, ticket: 3234260579 })
  const r = one(rows)
  assert.equal(r.broker_ticket, NATIVE, 'native ticket persisted')
  assert.equal(r.oanda_trade_id, APP_UUID, 'application correlation id UNCHANGED')
  assert.equal(r.entry_price, 3312.45, 'fill price still recorded')
  assert.equal(r.opened_at, NOW, 'opened_at set when previously null')
  assert.equal(r.result, 'OPEN', 'result unchanged')
})

// ── §8-B missing ticket -> fill still succeeds, ticket untouched ──────────
t('§8-B missing ticket: the fill still succeeds and broker_ticket is untouched', () => {
  const rows = applyCompletions([rowOf()], 'u-1', { id: APP_UUID, success: true, filledPrice: 3312.45 })
  const r = one(rows)
  assert.equal(r.broker_ticket, APP_UUID, 'broker_ticket unchanged — fail closed')
  assert.equal(r.entry_price, 3312.45, 'the fill was NOT failed by the missing ticket')
  assert.equal(r.result, 'OPEN')
})

// ── §8-C empty / whitespace ticket -> no overwrite ────────────────────────
t('§8-C empty or whitespace ticket: no overwrite', () => {
  for (const tk of ['', '   ', '\t', '\n']) {
    const r = one(applyCompletions([rowOf()], 'u-1', { id: APP_UUID, success: true, ticket: tk }))
    assert.equal(r.broker_ticket, APP_UUID, `no overwrite for ${JSON.stringify(tk)}`)
    assert.equal(r.result, 'OPEN', 'fill still succeeded')
  }
})

// ── §8-D malformed ticket -> no overwrite ─────────────────────────────────
t('§8-D malformed ticket: no overwrite, nothing coerced or fabricated', () => {
  for (const tk of ['abc', '123abc', 'NaN', 'null', 'undefined', 'true', '12.5', '-1', '+1',
                    '1e9', '0x10', '0', '00', '000000']) {
    const r = one(applyCompletions([rowOf()], 'u-1', { id: APP_UUID, success: true, ticket: tk }))
    assert.equal(r.broker_ticket, APP_UUID, `no overwrite for ${JSON.stringify(tk)}`)
  }
})

// ── §8-E an application UUID supplied as the ticket -> no overwrite ───────
t('§8-E UUID supplied as ticket: never written into broker_ticket', () => {
  for (const tk of [APP_UUID, '1A66243F-737F-4ACC-8DD2-62138949F0EE', 'not-a-number']) {
    const r = one(applyCompletions([rowOf()], 'u-1', { id: APP_UUID, success: true, ticket: tk }))
    assert.equal(r.broker_ticket, APP_UUID, `UUID must never overwrite broker_ticket: ${tk}`)
  }
  // The anti-fallback guards must exist in the SQL itself, not just in this model.
  assert.ok(guardsAppId, 'the migration compares v_ticket <> v_order_id')
  assert.ok(usesBtrim, 'the migration normalises the ticket with NULLIF(btrim(...))')
})

// ── §8-F wrong completed.id -> another trade is never modified ────────────
t('§8-F wrong completed.id: no other trade is touched', () => {
  const target = rowOf()
  const other  = rowOf({ oanda_trade_id: 'ffffffff-0000-0000-0000-000000000000' })
  const rows = applyCompletions([target, other], 'u-1',
    { id: APP_UUID, success: true, filledPrice: 1, ticket: 3234260579 })
  assert.equal(rows[0].broker_ticket, NATIVE, 'the matching row updated')
  assert.equal(rows[1].broker_ticket, other.broker_ticket, 'the non-matching row untouched')
  assert.equal(rows[1].entry_price, null, 'no fill leaked onto another trade')
})

// ── §8-G wrong user -> another user's trade is never modified ─────────────
t('§8-G wrong user: no cross-user modification', () => {
  const mine   = rowOf({ user_id: 'u-1' })
  const theirs = rowOf({ user_id: 'u-2' })
  const rows = applyCompletions([mine, theirs], 'u-1',
    { id: APP_UUID, success: true, filledPrice: 1, ticket: 3234260579 })
  assert.equal(rows[0].broker_ticket, NATIVE)
  assert.equal(rows[1].broker_ticket, APP_UUID, "another user's row is untouched")
})

// ── §8-H duplicate completion -> idempotent ───────────────────────────────
t('§8-H duplicate completion payload is idempotent', () => {
  const completion = { id: APP_UUID, success: true, filledPrice: 3312.45, ticket: 3234260579 }
  const once  = applyCompletions([rowOf()], 'u-1', completion)
  const twice = applyCompletions(once, 'u-1', completion)
  assert.deepEqual(twice, once, 'replaying the same completion changes nothing')
  assert.equal(twice[0].broker_ticket, NATIVE)
  assert.equal(twice[0].oanda_trade_id, APP_UUID)
})

// ── §8-I a valid native ticket is never destroyed by a later bad one ──────
t('§8-I an existing native ticket survives a subsequent malformed completion', () => {
  const good = applyCompletions([rowOf()], 'u-1', { id: APP_UUID, success: true, ticket: 3234260579 })
  assert.equal(good[0].broker_ticket, NATIVE)
  for (const bad of [undefined, '', '  ', 'abc', APP_UUID, '0', null]) {
    const after = applyCompletions(good, 'u-1', { id: APP_UUID, success: true, ticket: bad })
    assert.equal(after[0].broker_ticket, NATIVE, `valid ticket preserved against ${JSON.stringify(bad)}`)
  }
})

// ── §8-J identity preservation, stated explicitly ────────────────────────
t('§8-J oanda_trade_id stays the APP UUID; broker_ticket becomes the native ticket', () => {
  const r = one(applyCompletions([rowOf()], 'u-1',
    { id: APP_UUID, success: true, filledPrice: 3312.45, ticket: 3234260579 }))
  assert.equal(r.oanda_trade_id, APP_UUID, 'APP UUID -> oanda_trade_id')
  assert.equal(r.broker_ticket, NATIVE, 'POSITION_TICKET -> broker_ticket')
  assert.notEqual(r.oanda_trade_id, r.broker_ticket, 'the two identities remain distinct')
  // The migration must never ASSIGN oanda_trade_id. Every occurrence must be the
  // comparison `oanda_trade_id = v_order_id` (i.e. the correlation lookup), so if
  // anyone ever sets it to v_ticket this fails.
  const rhs = [...SQL.matchAll(/oanda_trade_id\s*=\s*([A-Za-z_][A-Za-z0-9_]*)/g)].map((m) => m[1])
  assert.ok(rhs.length > 0, 'oanda_trade_id is referenced')
  assert.ok(rhs.every((x) => x === 'v_order_id'),
    `oanda_trade_id is only ever compared to v_order_id, found: ${JSON.stringify(rhs)}`)
  assert.ok(/AND oanda_trade_id = v_order_id/.test(SQL), 'the row is still located by oanda_trade_id')
})

// ── §8-K production-shaped attribution through the REAL matchAttribution ──
t('§8-K production chain: OLD rejects, NEW attributes (real matchAttribution)', () => {
  const openTrade = { id: '3234180000', pair: 'XAU/USD' }

  // OLD: the row still holds the application UUID.
  const oldRow = rowOf({ broker_ticket: APP_UUID, oanda_trade_id: APP_UUID })
  const oldRes = matchAttribution([openTrade], [oldRow])
  assert.equal(oldRes.scalp.size, 0, 'OLD: not attributable')
  assert.deepEqual(oldRes.skipped, [{ ticket: '3234180000', reason: 'no-scalp-trade-row' }],
    'OLD: reproduces the production log line exactly')

  // NEW: the RPC persisted the native ticket for the SAME app correlation id.
  const newRow = one(applyCompletions([rowOf({ broker_ticket: APP_UUID })], 'u-1',
    { id: APP_UUID, success: true, filledPrice: 3312.45, ticket: 3234180000 }))
  assert.equal(newRow.oanda_trade_id, APP_UUID)
  assert.equal(newRow.broker_ticket, '3234180000')

  const newRes = matchAttribution([openTrade], [newRow])
  assert.ok(newRes.scalp.has('3234180000'), 'NEW: ATTRIBUTED')
  assert.equal(newRes.skipped.length, 0, 'NEW: nothing skipped')
  assert.equal(newRes.scalp.get('3234180000').record.oanda_trade_id, APP_UUID,
    'the application correlation id is still attached to the attributed record')
})

// ── §6 no heuristic backfill, no symbol/time/lots reconstruction ──────────
t('§6 the migration contains no heuristic backfill', () => {
  // A backfill would have to UPDATE trades outside the completion loop, or match
  // on symbol/price/time. Neither may appear.
  assert.equal((SQL.match(/broker_ticket\s*=/g) || []).length, 1,
    'broker_ticket is assigned in exactly ONE place')
  const block = SQL.slice(SQL.indexOf('Process completed orders'), SQL.indexOf('Process closedPositions'))
  const code  = block.replace(/--.*$/gm, '')
  assert.ok(!/ABS\s*\(/.test(code), 'no price-proximity matching')
  assert.ok(!/symbol/i.test(code), 'no symbol matching')
  assert.ok(!/interval|direction/i.test(code), 'no time/direction heuristic')
})

// ── §2 every preserved semantic is still present verbatim ────────────────
t('§2 authentication, locking, reconciliation and response shape are preserved', () => {
  const mustPreserve = [
    [/FOR UPDATE/, 'config row lock (pending-order serialisation)'],
    [/WHERE \(config->>'webhookToken'\) = p_token/, 'token authentication'],
    [/broker_type IN \('mt5direct', 'exness'\)/, 'broker lookup'],
    [/'Invalid token'/, 'invalid-token response'],
    [/jsonb_typeof\(p_payload->'balance'\) != 'number'/, 'balance validation'],
    [/o->>'expiresAt'/, 'pending-order expiry'],
    [/jsonb_build_object\(\s*'ok',\s*true,\s*'pendingOrders'/, 'PULL response shape'],
    [/'profitTargetUsd'/, 'PULL profit fields'],
    [/MT5 rejected:/, 'failure-branch notes'],
    [/result = 'CANCELLED'/, 'failure handling'],
    [/SET result    = CASE WHEN v_cp_profit >= 0 THEN 'WIN' ELSE 'LOSS' END/, 'closedPositions handling'],
    [/row_number\(\) OVER/, 'open-position reconciliation'],
    [/'reconciled', COALESCE\(v_reconciled, 0\)/, 'response reconciled field'],
    [/'closed',     v_closed_count/, 'response closed field'],
    [/GRANT EXECUTE ON FUNCTION public\.mt5_webhook_sync\(text, jsonb\) TO anon;/, 'anon grant'],
    [/GRANT EXECUTE ON FUNCTION public\.mt5_webhook_sync\(text, jsonb\) TO authenticated;/, 'authenticated grant'],
    [/SECURITY DEFINER/, 'SECURITY DEFINER'],
    [/SET search_path = public/, 'search_path pinning'],
    [/count\(\*\)::int\s+AS cnt/, 'open-position counting'],
    [/jsonb_array_length\(p_payload->'completedOrders'\) > 0/, 'completedOrders guard'],
  ]
  for (const [re, what] of mustPreserve) assert.ok(re.test(SQL), `preserved: ${what}`)
})

// ── the SQL rule and the app-side validator agree ────────────────────────
t('the SQL rule and lib/mt5-fill-attribution.mjs agree on every input that matters', () => {
  const matrix = [
    null, undefined, '', ' ', '  ', '\t',
    '3234260579', 3234260579, '3234180000', 3234180000, '1', '99999999999999999999',
    '0', '00', '000000', '00000000000000000001',
    'abc', '123abc', 'NaN', 'Infinity', '12.5', '-1', '+1', '1e9', '0x10',
    APP_UUID, '1A66243F-737F-4ACC-8DD2-62138949F0EE', 'not-a-number',
    ' 3234260579 ', '323426057900000000000000000000000',
  ]
  for (const tk of matrix) {
    const jsAccepts  = validateNativeTicket(tk, { appId: APP_UUID }).ok
    const sqlAccepts = sqlTicketValid(tk, APP_UUID)
    // The SQL may be STRICTER (documented, safe) but must never be more permissive
    // than the app-side validator: anything SQL accepts must be app-accepted too.
    if (sqlAccepts) {
      assert.ok(jsAccepts,
        `SQL accepted ${JSON.stringify(tk)} but the app-side validator rejected it — SQL is more permissive`)
    }
    // Both must reject every non-digit / empty / app-id input.
    const s = tk === null || tk === undefined ? '' : String(tk).trim()
    const dangerous = s === '' || s === APP_UUID || !/^[0-9]+$/.test(s)
    if (dangerous) {
      assert.equal(sqlAccepts, false, `SQL must reject ${JSON.stringify(tk)}`)
      assert.equal(jsAccepts, false, `JS must reject ${JSON.stringify(tk)}`)
    }
  }
  // Document the two known extra-strictness points rather than hiding them.
  assert.equal(validateNativeTicket('00', { appId: APP_UUID }).ok, true,
    'JS: "00" passes the not-zero check')
  assert.equal(sqlTicketValid('00', APP_UUID), false,
    'SQL: "00" is rejected by the ^0+$ guard — stricter, safe')
  assert.equal(validateNativeTicket('323426057900000000000000000000000', { appId: APP_UUID }).ok, true,
    'JS: no length bound')
  assert.equal(sqlTicketValid('323426057900000000000000000000000', APP_UUID), false,
    `SQL: longer than ${maxLen} digits rejected — stricter, safe`)
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



