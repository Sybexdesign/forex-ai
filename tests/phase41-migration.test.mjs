// tests/phase41-migration.test.mjs
// ── PHASE 4.1: THE MIGRATION AND THE ACCOUNTING MODULE MUST AGREE ───────────
//
// No Postgres server is available in this environment, so the SQL cannot be
// executed. Instead — following the same discipline as
// tests/mt5-native-ticket-migration.test.mjs — this test:
//
//   1. PARSES the migration's own statements and predicates, so a later edit
//      that weakens a guarantee breaks the test instead of drifting silently.
//   2. MODELS the trigger's plpgsql logic faithfully in JS, and
//   3. CROSS-CHECKS that model against lib/trade-accounting.mjs over the same
//      input matrix, so the database and the application cannot disagree about
//      what a "net realised P&L" is.
//
// Run: npm run test:phase41-migration
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { computeNetPnl } from '../lib/trade-accounting.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const sql = readFileSync(
  path.join(root, 'supabase/migrations/20261112_phase41_order_authority_and_accounting.sql'), 'utf8')

// Strip SQL comments so a "commented-out" statement cannot satisfy an assertion.
const uncommented = sql
  .split('\n')
  .map((l) => (l.trimStart().startsWith('--') ? '' : l))
  .join('\n')

const triggerBody = sql
  .split('CREATE OR REPLACE FUNCTION public.trades_derive_accounting()')[1]
  .split('$$;')[0]

// ── A — the migration is additive ───────────────────────────────────────────
{
  const expected = [
    'submission_source', 'submitted_by', 'request_id', 'authority_decision',
    'authority_reason', 'authority_policy_version', 'submitted_at',
    'net_realised_pnl', 'other_fees', 'accounting_complete', 'accounting_missing',
    'initial_entry_price', 'initial_sl_price', 'requested_entry_price',
    'requested_sl_price', 'risk_calc_version', 'instrument_spec',
  ]
  for (const col of expected) {
    assert.ok(
      new RegExp(`ADD COLUMN IF NOT EXISTS ${col}\\b`).test(sql),
      `A: ${col} is added with ADD COLUMN IF NOT EXISTS (idempotent)`)
  }
  assert.equal(/DROP COLUMN/i.test(uncommented), false, 'A: no column is dropped by executable SQL')
  assert.equal(/ALTER COLUMN/i.test(uncommented), false, 'A: no column type is altered')
  assert.equal(/DROP CONSTRAINT/i.test(uncommented), false, 'A: no constraint is dropped')
  console.log(`A: ${expected.length} additive columns, nothing dropped or retyped`)
}

// ── B — no historical backfill is executed ─────────────────────────────────
{
  const tableUpdates = uncommented.match(/UPDATE\s+public\.trades/gi) ?? []
  assert.equal(tableUpdates.length, 0, 'B: the migration performs NO table update / backfill')
  assert.match(sql, /--\s+UPDATE public\.trades/, 'B: the optional backfill is present but disabled')
  assert.match(sql, /trade_result is deliberately NOT backfilled/, 'B: and the reason is recorded')
  console.log('B: no historical row is rewritten; optional backfill stays commented out')
}

// ── C — transactions are balanced ──────────────────────────────────────────
{
  const begins = (uncommented.match(/^BEGIN;/gm) ?? []).length
  const commits = (uncommented.match(/^COMMIT;/gm) ?? []).length
  assert.equal(begins, commits, 'C: BEGIN/COMMIT balanced')
  assert.ok(begins >= 3, 'C: columns / indexes / trigger each in their own transaction')
  console.log(`C: ${begins} BEGIN / ${commits} COMMIT — balanced`)
}

// ── D — the trigger covers every close path and is re-runnable ─────────────
{
  assert.match(uncommented, /CREATE OR REPLACE FUNCTION public\.trades_derive_accounting\(\)/)
  assert.match(uncommented, /BEFORE INSERT OR UPDATE OF pl_usd, commission, swap, other_fees/)
  assert.match(uncommented, /DROP TRIGGER IF EXISTS trades_derive_accounting_trg/)
  assert.match(uncommented, /EXECUTE FUNCTION public\.trades_derive_accounting\(\)/)
  console.log('D: one shared trigger on the financial columns, safely re-runnable')
}

// ── E — idempotency and lookup indexes ─────────────────────────────────────
{
  assert.match(uncommented, /CREATE UNIQUE INDEX IF NOT EXISTS trades_request_id_uidx/)
  assert.match(uncommented, /ON public\.trades \(user_id, request_id\)/)
  assert.match(uncommented, /WHERE request_id IS NOT NULL/)
  assert.match(uncommented, /trades_authority_idx/)
  assert.match(uncommented, /trades_accounting_incomplete_idx/)
  console.log('E: request_id uniqueness plus authority/accounting lookup indexes')
}

// ── F — 'CLOSED' is never produced as a profitability by the trigger ───────
{
  assert.equal(/NEW\.trade_result\s*:=\s*'CLOSED'/.test(triggerBody), false,
    "F: the trigger never writes trade_result='CLOSED'")
  assert.equal(/'CLOSED'/.test(triggerBody), false, 'F: the word CLOSED does not appear in the trigger at all')
  assert.match(triggerBody, /WHEN ABS\(v_net\) <= 0\.01 THEN 'BREAKEVEN'/, 'F: epsilon band on net')
  // With incomplete costs the verdict is gross-based but accounting_complete is
  // FALSE — the gross branch must exist and must be flagged.
  assert.match(triggerBody, /WHEN ABS\(v_gross\) <= 0\.01 THEN 'BREAKEVEN'/, 'F: gross-based provisional band')
  assert.match(triggerBody, /NEW\.accounting_complete := false/, 'F: gross-only verdict flagged incomplete')
  console.log("F: trigger derives trade_result only; never 'CLOSED', never fabricates a net")
}

// ── G — missing commission/swap is NEVER coalesced to zero ─────────────────
{
  assert.match(triggerBody, /v_gross \+ v_comm \+ v_swap \+ COALESCE\(v_fees, 0\)/,
    'G: only other_fees is optional in the net formula')
  assert.equal(/COALESCE\(v_comm/.test(triggerBody), false, 'G: commission is never defaulted to 0')
  assert.equal(/COALESCE\(v_swap/.test(triggerBody), false, 'G: swap is never defaulted to 0')
  assert.match(triggerBody, /v_missing := v_missing \|\| 'commission'/, 'G: named as missing')
  assert.match(triggerBody, /v_missing := v_missing \|\| 'swap'/, 'G: named as missing')
  console.log('G: an absent cost yields NULL + accounting_missing, never a free trade')
}

// ── H — the trigger never touches financial evidence or risk controls ──────
{
  // Only NEW assignments of the three derived fields are permitted, plus the
  // deliberate NULL-for-OPEN initialisation. Anything else would let accounting
  // rewrite broker evidence.
  const assigned = [...triggerBody.matchAll(/NEW\.([a-z_]+)\s*:=/g)].map((m) => m[1])
  const allowed = new Set(['net_realised_pnl', 'accounting_complete', 'accounting_missing', 'trade_result'])
  for (const field of assigned) {
    assert.ok(allowed.has(field), `H: trigger must not assign NEW.${field}`)
  }
  for (const forbidden of ['result', 'pl_usd', 'lots', 'sl_price', 'tp_price', 'entry_price', 'realised_r', 'planned_risk_amount']) {
    assert.equal(assigned.includes(forbidden), false, `H: NEW.${forbidden} is left untouched`)
  }
  console.log(`H: trigger only assigns ${[...allowed].length} derived fields — no evidence, no risk, no authority`)
}

// ── I — MODEL the trigger locally and cross-check it against the JS module ──
// This is the substantive check: the SQL semantics and lib/trade-accounting.mjs
// must agree on every input, or the DB and the app would disagree about money.
function modelTrigger(row) {
  const gross = row.pl_usd
  if (gross === null || gross === undefined) {
    return { net_realised_pnl: null, accounting_complete: null, trade_result: undefined, accounting_missing: null }
  }
  const missing = []
  if (row.commission === null || row.commission === undefined) missing.push('commission')
  if (row.swap === null || row.swap === undefined) missing.push('swap')

  if (missing.length === 0) {
    const fees = row.other_fees ?? 0
    const net = Math.round((gross + row.commission + row.swap + fees) * 100) / 100
    const trade_result = Math.abs(net) <= 0.01 ? 'BREAKEVEN' : (net > 0 ? 'WIN' : 'LOSS')
    return { net_realised_pnl: net, accounting_complete: true, trade_result, accounting_missing: [] }
  }
  // Gross-only provisional verdict (costs unknown) — never a fabricated net.
  const grossOnly = Math.abs(gross) <= 0.01 ? 'BREAKEVEN' : (gross > 0 ? 'WIN' : 'LOSS')
  return { net_realised_pnl: null, accounting_complete: false, trade_result: grossOnly, accounting_missing: missing }
}

{
  const matrix = [
    { pl_usd: 100, commission: -7, swap: -2 },
    { pl_usd: 3368.5, commission: -35, swap: 0 },
    { pl_usd: 3, commission: -5, swap: 0 },
    { pl_usd: 100, commission: 0, swap: 0 },
    { pl_usd: 10, commission: -2, swap: 5 },
    { pl_usd: 100, commission: -1, swap: 0, other_fees: -3 },
    { pl_usd: 0, commission: 0, swap: 0 },
    { pl_usd: 0.005, commission: 0, swap: 0 },
    { pl_usd: 100, commission: null, swap: 0 },
    { pl_usd: 100, commission: -1, swap: null },
    { pl_usd: 100 },
    { pl_usd: null, commission: -1, swap: 0 },
  ]
  for (const row of matrix) {
    const sqlModel = modelTrigger(row)
    const jsModel = computeNetPnl({
      grossProfit: row.pl_usd, commission: row.commission, swap: row.swap, otherFees: row.other_fees,
    })
    assert.equal(sqlModel.net_realised_pnl, jsModel.netPnl,
      `I: net P&L agrees for ${JSON.stringify(row)}`)
    assert.equal(sqlModel.accounting_complete, jsModel.complete === true || (row.pl_usd === null ? null : jsModel.complete),
      `I: completeness agrees for ${JSON.stringify(row)}`)
    if (sqlModel.trade_result !== undefined) {
      assert.equal(sqlModel.trade_result, jsModel.result, `I: result agrees for ${JSON.stringify(row)}`)
    }
  }
  console.log(`I: SQL trigger model and lib/trade-accounting agree on all ${matrix.length} cases`)
}

console.log('\nphase41-migration: 9/9 groups passed')
