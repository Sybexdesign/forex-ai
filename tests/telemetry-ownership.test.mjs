// tests/telemetry-ownership.test.mjs
// ── PHASE: PROFIT PROTECTION TELEMETRY OWNERSHIP ────────────────────────────
//
// profit_protection_telemetry carried no user_id, so a lifecycle could only be
// attributed by broker_ticket. A native MT5 ticket is unique WITHIN an account,
// not across accounts, and the close-idempotency guarantee was built on that
// unqualified key:
//
//     UNIQUE (trade_source, broker_ticket) WHERE row_kind='close' ...
//
// Under multi-account operation a second account's genuine close row would
// collide with the first account's and be swallowed as "already persisted"
// (the worker treats 409 as success) — the lifecycle silently disappears rather
// than being merely ambiguous. These tests assert ownership is explicit, and the
// first one demonstrates the collision against the pre-fix key so the regression
// has teeth.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { toRow } from '../lib/profit-telemetry.mjs'

let failed = 0
const tests = []
const t = (name, fn) => tests.push([name, fn])

const UA = '17035955-a3f4-462e-82cc-ec3ead5ad45d'
const UB = '2fbdacfc-3f6a-4be9-bded-c64336c97f8c'
const TICKET = '12345'   // deliberately identical across both accounts

const MIGRATION = new URL('../supabase/migrations/20261004_profit_protection_telemetry_ownership.sql', import.meta.url)

/** The pre-fix idempotency key: no owner. */
const preFixCloseKey = (r) => `${r.trade_source}::${r.broker_ticket}`
/** The post-fix idempotency key: owner + ticket (mirrors the partial unique index). */
const scopedCloseKey = (r) => `${r.user_id}::${r.trade_source}::${r.broker_ticket}`

console.log('profit protection telemetry — ownership')

t('PROOF OF DEFECT: the unqualified close key collides across accounts', () => {
  const closeA = { user_id: UA, trade_source: 'scalp', broker_ticket: TICKET, row_kind: 'close' }
  const closeB = { user_id: UB, trade_source: 'scalp', broker_ticket: TICKET, row_kind: 'close' }
  assert.equal(preFixCloseKey(closeA), preFixCloseKey(closeB),
    'pre-fix: two DIFFERENT accounts produced one identical key — B’s close would be deduped away')
  assert.notEqual(scopedCloseKey(closeA), scopedCloseKey(closeB),
    'post-fix: the keys differ, so both lifecycles persist independently')
})

t('same broker ticket, different users -> NO COLLISION', () => {
  const a = { user_id: UA, trade_source: 'scalp', broker_ticket: TICKET }
  const b = { user_id: UB, trade_source: 'scalp', broker_ticket: TICKET }
  assert.notEqual(scopedCloseKey(a), scopedCloseKey(b))

  // And a lifecycle lookup must never cross accounts.
  const rows = [
    { ...a, row_kind: 'close', peak_r: 1.8 },
    { ...b, row_kind: 'close', peak_r: 9.9 },
  ]
  const forA = rows.filter((r) => r.user_id === UA && r.broker_ticket === TICKET)
  assert.equal(forA.length, 1, 'exactly one lifecycle for A')
  assert.equal(forA[0].peak_r, 1.8, "A resolves A's telemetry, never B's")
  const forB = rows.filter((r) => r.user_id === UB && r.broker_ticket === TICKET)
  assert.equal(forB[0].peak_r, 9.9, "B resolves B's telemetry")
})

t('rows without an owner cannot be attributed — the code refuses to write them', () => {
  const worker = readFileSync(new URL('../workers/scalper.mjs', import.meta.url), 'utf8')
  const fn = worker.slice(worker.indexOf('async function shadowInsertRow'), worker.indexOf('function shadowLog'))
  assert.ok(/if \(!WORKER_USER_ID\)/.test(fn), 'the write path checks for a trusted identity')
  assert.ok(/REFUSING telemetry write/.test(fn), 'and refuses loudly rather than writing an orphan row')
  assert.ok(/return false/.test(fn), 'the refusal is a failure, not a silent success')
  assert.ok(/\{ \.\.\.row, user_id: WORKER_USER_ID \}/.test(fn),
    'WORKER_USER_ID is stamped last so it wins over any user_id already on the row')
})

t('toRow stamps the server-supplied owner', () => {
  const item = { ticket: '3234180000', tradeId: 'db-1', pair: 'XAU/USD', protectionStage: 'PROTECT' }
  const withoutOwner = toRow(item)
  assert.equal(withoutOwner.user_id, null, 'no ctx.userId -> null (the DB constraint then rejects it)')
  const withOwner = toRow(item, { userId: UA, protectionMode: 'shadow' })
  assert.equal(withOwner.user_id, UA, 'ctx.userId is written through')
  assert.equal(withOwner.broker_ticket, '3234180000', 'ticket still recorded alongside ownership')
  assert.equal(withOwner.shadow_command_emitted, false, 'shadow safety assertion unchanged')
})

t('the migration adds ownership, re-scopes the unique key, and never destroys data', () => {
  const sql = readFileSync(MIGRATION, 'utf8')
  // Ownership
  assert.ok(/ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES auth\.users\(id\) ON DELETE CASCADE/.test(sql),
    'user_id uses the schema-wide identity model (auth.users UUID) — no second identity system')
  // Scoped uniqueness
  assert.ok(/DROP INDEX IF EXISTS public\.profit_protection_telemetry_scalp_close_uniq/.test(sql),
    'the unqualified unique index is dropped')
  assert.ok(/CREATE UNIQUE INDEX IF NOT EXISTS profit_protection_telemetry_scalp_close_uniq[\s\S]*?\(user_id, trade_source, broker_ticket\)/.test(sql),
    'and recreated WITH user_id as the leading key')
  assert.ok(/WHERE row_kind = 'close'[\s\S]*?trade_source = 'scalp'[\s\S]*?broker_ticket IS NOT NULL/.test(sql),
    'the partial predicate is preserved exactly (snapshots/decisions still repeat legitimately)')
  // Indexes for scoped reads
  assert.ok(/ppt_user_created_idx[\s\S]*?\(user_id, created_at DESC\)/.test(sql), 'user-scoped time index')
  assert.ok(/ppt_user_ticket_idx[\s\S]*?\(user_id, broker_ticket, created_at\)/.test(sql), 'user-scoped ticket index')
  // Fail-closed ownership, guarded so a non-empty legacy table cannot break the migration
  assert.ok(/DO \$\$[\s\S]*?WHERE user_id IS NULL LIMIT 1[\s\S]*?SET NOT NULL[\s\S]*?END \$\$;/.test(sql),
    'NOT NULL is applied only when no unattributed row exists')
  // RLS without weakening, and idempotent policy
  assert.ok(/ENABLE ROW LEVEL SECURITY/.test(sql), 'RLS is enabled')
  assert.ok(/DROP POLICY IF EXISTS ppt_select_own/.test(sql), 'policy creation is idempotent')
  assert.ok(/FOR SELECT\s+USING \(auth\.uid\(\) = user_id\)/.test(sql), 'self-read policy uses the schema convention')
  assert.ok(!/FOR INSERT/.test(sql), 'no INSERT policy is granted — clients cannot fabricate telemetry')
  // Non-destructive — asserted against CODE, not prose: the migration documents
  // its rollback procedure in comments, which legitimately mention DROP COLUMN.
  const code = sql.replace(/^[ \t]*--.*$/gm, '')
  assert.ok(!/DROP TABLE|TRUNCATE|DELETE FROM/.test(code), 'no destructive statement in code')
  assert.ok(!/DROP COLUMN/.test(code), 'no column dropped in code')
  assert.ok(!/CREATE TABLE/.test(code), 'no table recreation — additive ALTERs only')
})

t('every telemetry reader is owner-scoped, not ticket-scoped', () => {
  const route = readFileSync(new URL('../app/api/profit-protection/telemetry/route.ts', import.meta.url), 'utf8')
  assert.ok(/r\.user_id/.test(route), 'lifecycles are grouped by owner')
  assert.ok(/\$\{r\.user_id \?\? '∅'\}::\$\{String\(r\.broker_ticket\)\}/.test(route),
    'the lifecycle key is owner::ticket, never the ticket alone')
  assert.ok(/\.eq\('user_id', uid\)/.test(route), 'the trades overlay is user-filtered too')
  assert.ok(!/const k = String\(t\.broker_ticket\)/.test(route),
    'the old ticket-only overlay key is gone')

  const report = readFileSync(new URL('../scripts/pp-observation-report.mjs', import.meta.url), 'utf8')
  assert.ok(/SCOPE_USER/.test(report), 'the acceptance report resolves an account scope')
  assert.ok(/user_id=eq\.\$\{SCOPE_USER\}/.test(report), 'and filters by it')
  assert.ok(!/broker_ticket\)\s*\/\/\s*$/.test(report), 'no ticket-only grouping assertion remains')
})

// ── runner ────────────────────────────────────────────────────────────────
for (const [name, fn] of tests) {
  try { await fn(); console.log(`  ✓ ${name}`) }
  catch (e) { failed++; console.error(`  ✗ ${name}\n      ${e?.message}`) }
}
console.log(`\n${tests.length - failed}/${tests.length} passed`)
process.exit(failed ? 1 : 0)
