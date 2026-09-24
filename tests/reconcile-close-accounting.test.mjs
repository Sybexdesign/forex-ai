// tests/reconcile-close-accounting.test.mjs
// ─────────────────────────────────────────────────────────────────────────────
// 20261004_reconcile_close_accounting.sql — forward-only close-accounting fix.
//
// WHAT THIS SUITE IS
//
// The migration must (a) add exactly three accounting assignments to the rich
// `closedPositions` reconciliation, and (b) change NOTHING else in a function
// that also carries the order path (token auth, FOR UPDATE, native-ticket
// fail-closed guard, pending orders, broker_configs write-back). So this suite
// asserts the accounting semantics AND — crucially — the absence of any other
// semantic change, by re-deriving the comment-stripped diff itself.
//
// ENVIRONMENT LIMITATION — STATED EXPLICITLY
//
// There is no PostgreSQL, no `psql` and no Supabase CLI here, so these are STATIC
// assertions against the migration SQL plus pure-function checks of the intended
// arithmetic. They do NOT prove the PL/pgSQL executes. Runtime proof can only
// come from a genuine post-fix close in production.
// ─────────────────────────────────────────────────────────────────────────────
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const MIG_DIR = new URL('../supabase/migrations/', import.meta.url)
const NEW = readFileSync(new URL('20261004_reconcile_close_accounting.sql', MIG_DIR), 'utf8')
const OLD = readFileSync(new URL('20261003_mt5_native_position_ticket.sql', MIG_DIR), 'utf8')

let failed = 0
const t = (name, fn) => {
  try { fn(); console.log('  ok   ' + name) }
  catch (e) { failed++; console.error('  FAIL ' + name + '\n        ' + e.message) }
}

/** Strip comment-only lines + blank lines → the semantic skeleton. */
const semantic = (sql) =>
  sql.split('\n').filter((l) => l.trim() !== '' && !/^\s*--/.test(l))

/**
 * The rich closedPositions UPDATE, isolated — SET block THROUGH the WHERE
 * subquery. The predicates under test (`result IN ('OPEN','CLOSED')`,
 * `pl_usd IS NULL`) live in the subquery, so the slice must extend past
 * `WHERE id = (` or those assertions would silently test nothing.
 */
function richSetBlock(sql) {
  const i = sql.indexOf('SET result    = CASE WHEN v_cp_profit >= 0')
  assert.ok(i >= 0, 'rich SET block anchor not found')
  const j = sql.indexOf('ORDER BY opened_at DESC', i)
  assert.ok(j > i, 'rich block terminator (ORDER BY) not found')
  return sql.slice(i, j + 120)
}

/** The fallback position-absence UPDATE, isolated. */
function fallbackBlock(sql) {
  const i = sql.indexOf("SET result    = 'CLOSED',")
  assert.ok(i >= 0, 'fallback anchor not found')
  return sql.slice(i, i + 400)
}

/** Intended arithmetic, mirroring the SQL expression exactly. */
const realisedR = (vCpProfit, plannedRiskAmount) =>
  (plannedRiskAmount === null || plannedRiskAmount === 0)
    ? null
    : vCpProfit / plannedRiskAmount

console.log('reconcile-close-accounting (20261004)')

// ── 1/2/9. WIN & LOSS semantics preserved ───────────────────────────────────
t('rich close keeps WIN/LOSS semantics (never CLOSED)', () => {
  const blk = richSetBlock(NEW)
  assert.match(blk, /result\s+= CASE WHEN v_cp_profit >= 0 THEN 'WIN' ELSE 'LOSS' END/,
    'result must stay a WIN/LOSS CASE')
  assert.ok(!/result\s*=\s*'CLOSED'/.test(blk),
    "the rich path must NEVER set result='CLOSED' — daily-loss and analytics key on WIN/LOSS")
})

t('WIN/LOSS boundary is >= 0 (zero profit is a WIN, matching production)', () => {
  assert.match(richSetBlock(NEW), /v_cp_profit >= 0 THEN 'WIN'/)
})

// ── 10. pl_usd preserved ────────────────────────────────────────────────────
t('pl_usd = v_cp_profit preserved verbatim', () => {
  assert.match(richSetBlock(NEW), /pl_usd\s+= v_cp_profit/)
})

// ── 11. MFE/MAE preserved ───────────────────────────────────────────────────
t('MFE/MAE COALESCE semantics preserved', () => {
  const blk = richSetBlock(NEW)
  assert.match(blk, /mfe_usd\s+= COALESCE\(v_cp_mfe, mfe_usd\)/)
  assert.match(blk, /mae_usd\s+= COALESCE\(v_cp_mae, mae_usd\)/)
})

// ── 3. exit_price ───────────────────────────────────────────────────────────
t('exit_price is written from the authoritative parsed close price', () => {
  assert.match(richSetBlock(NEW), /exit_price\s+= v_cp_close_price/)
  assert.match(NEW, /v_cp_close_price\s*:=\s*\(v_closed_entry->>'closePrice'\)::numeric/,
    'v_cp_close_price must still be parsed from the payload')
})

// ── 4. trade_status ─────────────────────────────────────────────────────────
t("trade_status = 'CLOSED' added to the rich close only", () => {
  assert.match(richSetBlock(NEW), /trade_status\s+= 'CLOSED'/)
  assert.ok(!/trade_status/.test(fallbackBlock(NEW)),
    'fallback must not gain trade_status — it stays accounting-incomplete')
})

// ── 5/6/7/8. realised_r ─────────────────────────────────────────────────────
t('realised_r uses v_cp_profit / NULLIF(planned_risk_amount, 0)', () => {
  assert.match(richSetBlock(NEW), /realised_r\s+= v_cp_profit \/ NULLIF\(planned_risk_amount, 0\)/)
})

t('realised_r does NOT use pl_usd as the numerator (same-UPDATE pre-value hazard)', () => {
  assert.ok(!/realised_r\s+= pl_usd/.test(NEW),
    'pl_usd is assigned in the same UPDATE and resolves to its pre-update value')
})

t('realised_r never derives from SL / telemetry / floors / unrealised marks', () => {
  const blk = richSetBlock(NEW)
  for (const bad of ['sl_price', 'planned_risk_usd', 'target_floor', 'peak_profit', 'mfe_usd /']) {
    assert.ok(!new RegExp(`realised_r\\s*=.*${bad}`).test(blk), `realised_r must not use ${bad}`)
  }
})

t('arithmetic: positive profit → positive R, negative → negative R', () => {
  assert.equal(realisedR(10, 20), 0.5)
  assert.equal(realisedR(-10, 20), -0.5)
  assert.equal(realisedR(20, 10), 2)
})

t('arithmetic: NULL or zero planned risk → NULL (NULLIF), never a division error', () => {
  assert.equal(realisedR(-5, 0), null)
  assert.equal(realisedR(-5, null), null)
})

// ── 12/13/14/16/17. fallback stays incomplete but enrichable ────────────────
t('fallback still writes ONLY result=CLOSED + closed_at', () => {
  const blk = fallbackBlock(NEW)
  assert.match(blk, /SET result    = 'CLOSED',/)
  assert.match(blk, /closed_at = now\(\)/)
  for (const f of ['pl_usd', 'exit_price', 'realised_r', 'mfe_usd', 'mae_usd', 'trade_status']) {
    assert.ok(!new RegExp(`${f}\\s*=`).test(blk), `fallback must not fabricate ${f}`)
  }
})

t("rich predicates preserved: result IN ('OPEN','CLOSED') AND pl_usd IS NULL", () => {
  const blk = richSetBlock(NEW)
  assert.match(blk, /result\s+IN \('OPEN', 'CLOSED'\)/,
    'a fallback-closed row must stay matchable by a later rich event')
  assert.match(blk, /pl_usd\s+IS NULL/, 'idempotency guard for duplicate rich events')
})

t('fallback→rich enrichment is possible by construction', () => {
  assert.match(richSetBlock(NEW), /result\s+IN \('OPEN', 'CLOSED'\)/)
  assert.match(richSetBlock(NEW), /pl_usd\s+IS NULL/)
})

t('duplicate rich event is idempotent', () => {
  assert.match(richSetBlock(NEW), /pl_usd\s+IS NULL/)
})

// ── 18. native-ticket fail-closed unchanged ─────────────────────────────────
t('native-ticket validation + fail-closed assignment unchanged', () => {
  for (const s of [
    "v_ticket := NULLIF(btrim(v_completed->>'ticket'), '')",
    "v_ticket ~ '^[0-9]+$'",
    "v_ticket !~ '^0+$'",
    'length(v_ticket) <= 20',
    'v_ticket <> v_order_id',
    'WHEN v_ticket_valid THEN v_ticket',
  ]) assert.ok(NEW.includes(s), `missing native-ticket guard: ${s}`)
})

// ── 19. pending-order / config / return behaviour unchanged ─────────────────
t('pending-order + broker_configs + return object unchanged', () => {
  for (const s of ['FOR UPDATE', 'pendingOrders', "'reconciled', COALESCE(v_reconciled, 0)", "'closed',     v_closed_count"]) {
    assert.ok(NEW.includes(s), `missing preserved behaviour: ${s}`)
  }
  assert.match(NEW, /GRANT EXECUTE ON FUNCTION public\.mt5_webhook_sync\(text, jsonb\) TO anon;/)
  assert.match(NEW, /GRANT EXECUTE ON FUNCTION public\.mt5_webhook_sync\(text, jsonb\) TO authenticated;/)
})

// ── 20. no historical backfill ──────────────────────────────────────────────
t('no historical backfill / no reference to historical tickets', () => {
  for (const tk of ['3252834056', '1058114016', '4cc8d0ed']) {
    assert.ok(!NEW.includes(tk), `must not reference historical ticket ${tk}`)
  }
  assert.ok(!/closed_at IS NULL/i.test(NEW), 'no backfill-style sweep predicate')
})

// ── THE MINIMALITY PROOF ITSELF ─────────────────────────────────────────────
t('MINIMALITY: semantic diff vs 20261003 is EXACTLY the authorised delta', () => {
  const a = semantic(OLD)
  const b = semantic(NEW)
  assert.equal(b.length, a.length + 3, 'exactly 3 semantic lines may be added')

  const replaced = '             closed_at = COALESCE(closed_at, now())'
  const expected = [
    '             closed_at = COALESCE(closed_at, now()),',
    '             exit_price   = v_cp_close_price,',
    "             trade_status = 'CLOSED',",
    '             realised_r   = v_cp_profit / NULLIF(planned_risk_amount, 0)',
  ]

  // Walk both skeletons; the ONLY permitted divergence is the rich SET block.
  let i = 0, j = 0, divergences = 0
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i++; j++; continue }
    divergences++
    assert.equal(a[i], replaced, `unexpected repository-side change at ${i}: ${a[i]}`)
    for (const k of expected) { assert.equal(b[j], k, `unexpected new line: ${b[j]}`); j++ }
    i++
  }
  assert.equal(i, a.length, 'trailing repository lines must be fully consumed')
  assert.equal(j, b.length, 'trailing new lines must be fully consumed')
  assert.equal(divergences, 1, 'exactly one divergence site permitted (the rich SET block)')
})

t('migration is forward-only and self-describing', () => {
  assert.match(NEW, /FORWARD-ONLY close-accounting completeness fix/)
  assert.match(NEW, /NO HISTORICAL BACKFILL/)
  assert.match(NEW, /CREATE OR REPLACE FUNCTION public\.mt5_webhook_sync\(/)
  assert.ok(NEW.trimEnd().endsWith('GRANT EXECUTE ON FUNCTION public.mt5_webhook_sync(text, jsonb) TO authenticated;')
    || NEW.includes('GRANT EXECUTE ON FUNCTION public.mt5_webhook_sync(text, jsonb) TO authenticated;;'.slice(0, 84)))
})

if (failed) { console.error(`\n${failed} failed`); process.exit(1) }
console.log('reconcile-close-accounting: all tests passed')
