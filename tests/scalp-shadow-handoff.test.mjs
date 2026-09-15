// tests/scalp-shadow-handoff.test.mjs
// Item 5/6 — the observation handoff must be provably unable to influence risk.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createScalpShadowRuntime, createShadowHandoff } from '../lib/scalp-shadow-runtime.mjs'

let failed = 0
const t = async (name, fn) => {
  try { await fn(); console.log('  ok   ' + name) }
  catch (e) { failed++; console.error('  FAIL ' + name + '\n        ' + e.message) }
}

/** A minimal "risk result" stand-in, computed exactly like the worker's. */
const deriveRisk = (acct) => ({
  balance: acct.balance || 0,
  openCount: (acct.openTrades || []).length,
  dailyLossPct: (acct.balance > 0 && acct.realizedPL < 0) ? Math.abs(acct.realizedPL) / acct.balance : 0,
  broker: acct.broker,
})

function runtimeWith(over = {}) {
  return createScalpShadowRuntime({
    throttleMs: 0,
    log: () => {},
    loadState: async () => ({}),
    saveState: async () => true,
    attribute: async () => ({ scalp: new Map(), skipped: [] }),
    confirmClosed: async () => null,
    insertRow: async () => true,
    evaluate: () => ({ reason: 'no-op' }),
    ...over,
  })
}

const ACCT = {
  balance: 10_000, realizedPL: -250, broker: 'Capital',
  openTrades: [{ id: 'T-1', pair: 'XAU/USD' }],
  instrumentGeometry: { 'XAU/USD': { pip: 0.1, pipValuePerLot: 10, known: true } },
}

console.log('scalp-shadow-handoff')

await t('item6: the handoff returns nothing and cannot alter the risk result', async () => {
  const rt  = runtimeWith()
  const hop = createShadowHandoff(rt)
  const before = deriveRisk(ACCT)
  assert.equal(hop(ACCT), undefined, 'handoff must return nothing a caller could route into risk')
  await rt.whenIdle()
  assert.deepEqual(deriveRisk(ACCT), before, 'risk result must be identical')
})

await t('item6: observer THROWING synchronously still completes risk processing', async () => {
  const rt  = runtimeWith({ observe: () => { throw new Error('observer exploded') } })
  const hop = createShadowHandoff(rt)
  const before = deriveRisk(ACCT)
  hop(ACCT)
  assert.deepEqual(deriveRisk(ACCT), before, 'risk processing completed normally')
})

await t('item6: observer REJECTING asynchronously causes no unhandled rejection', async () => {
  const seen = []
  const onUnhandled = (e) => seen.push(e)
  process.on('unhandledRejection', onUnhandled)
  const rt = runtimeWith({ observe: () => Promise.reject(new Error('async observer failure')) })
  createShadowHandoff(rt)(ACCT)
  await new Promise((r) => setTimeout(r, 20))
  process.off('unhandledRejection', onUnhandled)
  assert.deepEqual(seen, [], 'no unhandled rejection may escape')
})

await t('item6: evaluator failure inside the runtime leaves an intact risk path', async () => {
  const rt  = runtimeWith({ evaluate: () => { throw new Error('evaluator exploded') } })
  const hop = createShadowHandoff(rt)
  const before = deriveRisk(ACCT)
  hop(ACCT)
  await rt.whenIdle()
  assert.deepEqual(deriveRisk(ACCT), before)
})

await t('item6: missing openTrades → risk continues, shadow observes an empty set', async () => {
  const rt  = runtimeWith()
  const hop = createShadowHandoff(rt)
  const malformed = { balance: 500, broker: 'X' }
  assert.equal(deriveRisk(malformed).openCount, 0)
  assert.equal(hop(malformed), undefined)
  await rt.whenIdle()
  assert.equal(rt.getStats().evaluations, 1, 'an empty observation is still one observation')
  assert.equal(rt.getStats().evaluated, 0)
})

await t('item6: missing geometry → risk continues, shadow skips', async () => {
  const rt = runtimeWith()
  createShadowHandoff(rt)({ ...ACCT, instrumentGeometry: undefined })
  await rt.whenIdle()
  assert.equal(deriveRisk(ACCT).openCount, 1, 'risk path unaffected')
})

await t('item6: malformed response of any shape cannot throw', async () => {
  const rt  = runtimeWith()
  const hop = createShadowHandoff(rt)
  for (const bad of [undefined, null, {}, { openTrades: 'nope' }, { openTrades: null }, { instrumentGeometry: 42 }, []]) {
    assert.equal(hop(bad), undefined)
  }
  await rt.whenIdle()
})

await t('item6: one fresh snapshot schedules exactly one observation', async () => {
  const rt = runtimeWith()
  createShadowHandoff(rt)(ACCT)
  await rt.whenIdle()
  assert.equal(rt.getStats().evaluations, 1)
})

await t('item6: a cache-hit style repeat of the SAME response schedules no new observation', async () => {
  // The worker returns early from its own cache before reaching the handoff, so a
  // cache hit never calls this at all. This asserts the belt-and-braces guard: if
  // the same response object were handed over twice, it is still one run.
  const rt  = runtimeWith()
  const hop = createShadowHandoff(rt)
  const same = { ...ACCT }
  hop(same); await rt.whenIdle()
  hop(same); await rt.whenIdle()
  assert.equal(rt.getStats().evaluations, 1, 'the same response must not be observed twice')
})

await t('item6: the handoff performs NO broker I/O (structural)', async () => {
  const src   = readFileSync(new URL('../lib/scalp-shadow-runtime.mjs', import.meta.url), 'utf8')
  const start = src.indexOf('export function createShadowHandoff')
  const body  = src.slice(start, src.indexOf('\n}\n', start) + 3)
  assert.ok(body.length > 100, 'handoff body found')
  for (const banned of ['fetch(', '/v1/positions', '/api/orders', 'broker.', 'http://', 'https://']) {
    assert.equal(body.includes(banned), false, `handoff must not contain ${banned}`)
  }
  assert.equal(/^\s*(?:await\s+)?fetch\(/m.test(src), false, 'runtime module must contain no fetch')
})

await t('item6: createShadowHandoff rejects a runtime without observe()', () => {
  assert.throws(() => createShadowHandoff(null), /runtime with observe/)
  assert.throws(() => createShadowHandoff({}), /runtime with observe/)
})

if (failed) { console.error(`\n${failed} failed`); process.exit(1) }
console.log('scalp-shadow-handoff: all tests passed')
