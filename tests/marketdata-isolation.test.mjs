// tests/marketdata-isolation.test.mjs
// ── PHASE: MT5 MARKET-DATA ACCOUNT ISOLATION ────────────────────────────────
//
// The server-level MT5 fallback used to pick its account by TIMESTAMP:
//
//     .in('broker_type', ['mt5direct','exness']).order('updated_at', {ascending:false}).limit(1)
//
// With more than one EA pushing, the account that synced most recently supplied
// ANOTHER user's prices and candles. Observed live: an unauthenticated
// /api/scalper/tick call returned the FusionMarkets account's bar close while the
// funded Exness account was the one under observation.
//
// These tests assert the invariant, and they FAIL against the pre-fix selection
// (the first test reconstructs it explicitly). "Most recently updated" is not an
// identity; absence of an identity must fail closed rather than fall back to
// somebody else's account.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { pickServerConfig, resolveServerMt5UserId } from '../lib/marketdata.ts'

let failed = 0
const tests = []
const t = (name, fn) => tests.push([name, fn])

const A = '17035955-a3f4-462e-82cc-ec3ead5ad45d'   // funded Exness 476906137
const B = '2fbdacfc-3f6a-4be9-bded-c64336c97f8c'   // FusionMarkets 489537

const cfgA = { login: '476906137', latestPrices: { XAUUSD: { bid: 4325.892 } } }
const cfgB = { login: '489537',    latestPrices: { XAUUSD: { bid: 4325.120 } } }

// Rows as the query returns them: B pushed most recently.
const rows = [
  { user_id: A, config: cfgA, updated_at: '2026-09-16T08:12:03.530Z' },
  { user_id: B, config: cfgB, updated_at: '2026-09-16T08:12:06.384Z' },
]

/** The pre-fix selection, reproduced so the regression has teeth. */
const preFixSelect = (r) =>
  [...(r || [])].sort((x, y) => (x.updated_at < y.updated_at ? 1 : -1))[0]?.config ?? null

console.log('mt5 market-data — account isolation')

t('PROOF OF DEFECT: the old timestamp selection returns the WRONG account', () => {
  assert.equal(preFixSelect(rows).login, '489537',
    'pre-fix behaviour really did hand back the newest pusher (B) — this is the defect')
  assert.notEqual(preFixSelect(rows).login, '476906137',
    'and it is NOT the account the authenticated caller asked for')
})

t('ISOLATION: an account always resolves ITS OWN data, regardless of push order', () => {
  assert.equal(pickServerConfig(rows, A).login, '476906137', 'A gets A even though B pushed last')
  assert.equal(pickServerConfig(rows, B).login, '489537',    'B gets B')
  // Reverse the push order — the answer must not change.
  const reversed = [...rows].reverse()
  assert.equal(pickServerConfig(reversed, A).login, '476906137', 'push order is irrelevant to ownership')
  assert.equal(pickServerConfig(reversed, B).login, '489537')
})

t('FAIL CLOSED: no configured identity -> no account, never somebody else’s', () => {
  assert.equal(pickServerConfig(rows, null), null, 'no owner -> no config')
  assert.equal(pickServerConfig(rows, ''), null, 'empty owner -> no config')
  assert.equal(pickServerConfig(rows, 'user-with-no-row'), null, 'unknown owner -> no config')
  assert.equal(pickServerConfig([], A), null, 'no rows -> no config')
  assert.equal(pickServerConfig(null, A), null, 'null rows -> no config')
})

t('FAIL CLOSED: an ambiguous owner is never guessed', () => {
  const twoForA = [
    { user_id: A, config: cfgA, updated_at: '2026-09-16T08:12:03Z' },
    { user_id: A, config: { login: 'duplicate' }, updated_at: '2026-09-16T08:12:06Z' },
  ]
  assert.equal(pickServerConfig(twoForA, A), null,
    'two active rows for one owner is an unexpected state — refuse, do not pick one')
})

t('identity resolution: explicit MT5_SERVER_USER_ID wins, WORKER_USER_ID is the convention', () => {
  assert.equal(resolveServerMt5UserId({ MT5_SERVER_USER_ID: A, WORKER_USER_ID: B }), A, 'purpose-built var wins')
  assert.equal(resolveServerMt5UserId({ WORKER_USER_ID: B }), B, 'existing convention still honoured')
  assert.equal(resolveServerMt5UserId({ MT5_SERVER_USER_ID: '  ' + A + '  ' }), A, 'trimmed')
  assert.equal(resolveServerMt5UserId({}), null, 'nothing configured -> null -> fail closed')
  assert.equal(resolveServerMt5UserId({ MT5_SERVER_USER_ID: '', WORKER_USER_ID: '   ' }), null, 'blank -> null')
})

t('the timestamp-ordered selection is GONE from the code', () => {
  const raw = readFileSync(new URL('../lib/marketdata.ts', import.meta.url), 'utf8')
  // Strip comments first: the rationale for removing timestamp ownership is
  // documented in prose and must not satisfy (or fail) a code assertion.
  const code = raw
    .replace(/\/\*[\s\S]*?\*\//g, '')   // block + JSDoc
    .replace(/^[ \t]*\/\/.*$/gm, '')    // line comments
  assert.ok(!/updated_at/.test(code),
    'broker_configs.updated_at must not be selected or ordered on in market-data CODE')
  const fallback = raw.slice(raw.indexOf('loadServerMt5Config'), raw.indexOf('tryMt5ServerCandles'))
  assert.ok(/resolveServerMt5UserId/.test(fallback), 'the fallback resolves an explicit identity')
  assert.ok(/pickServerConfig/.test(fallback), 'and delegates the choice to the fail-closed picker')
  assert.ok(/\.limit\(2\)/.test(fallback), 'limit(2) so ambiguity is detectable, not truncated')
  assert.ok(/\.eq\('user_id', userId\)/.test(fallback), 'the query itself is user-filtered')
})

t('the signal route no longer drops the caller identity for HTF bias', () => {
  const src = readFileSync(new URL('../app/api/scalper/signal/route.ts', import.meta.url), 'utf8')
  assert.ok(!/getMarketCandles\(undefined/.test(src),
    'getMarketCandles must never be called with an explicitly discarded token')
  assert.ok(/fetchHtfBias\(pair, '15m', authToken\)/.test(src), '15m bias forwards the token')
  assert.ok(/fetchHtfBias\(pair, '1H', authToken\)/.test(src), '1H bias forwards the token')
  assert.ok(/const authToken = req\.headers\.get\('Authorization'\)/.test(src), 'the route reads the caller token')
  assert.ok(/\$\{who\}:\$\{pair\}:\$\{timeframe\}/.test(src),
    'the HTF cache key is identity-scoped — it must not serve one account the bias of another')
})

// ── runner ────────────────────────────────────────────────────────────────
for (const [name, fn] of tests) {
  try { await fn(); console.log(`  ✓ ${name}`) }
  catch (e) { failed++; console.error(`  ✗ ${name}\n      ${e?.message}`) }
}
console.log(`\n${tests.length - failed}/${tests.length} passed`)
process.exit(failed ? 1 : 0)
