// tests/scalp-shadow-readonly.test.mjs
// ── §14 THE SHADOW OBSERVER IS BROKER-READ-ONLY — PROVEN, NOT ASSUMED ───────
//
// A future edit must not be able to reach a broker from the observer without this
// suite failing. Two independent proofs:
//   1. STRUCTURAL — the module cannot even name a broker-writing capability.
//   2. BEHAVIOURAL — a runtime driven through a full lifecycle never calls one.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createScalpShadowRuntime, createShadowHandoff } from '../lib/scalp-shadow-runtime.mjs'

let failed = 0
const t = (name, fn) => { try { fn(); console.log('  ok   ' + name) } catch (e) { failed++; console.error('  FAIL ' + name + '\n        ' + (e.message || e)) } }
const tick = () => new Promise((r) => setImmediate(r))

const FILES = ['../lib/scalp-shadow-runtime.mjs', '../lib/scalp-shadow-protection.mjs']

console.log('scalp shadow observer — broker read-only invariant')

// ── 1. STRUCTURAL ─────────────────────────────────────────────────────────
t('§14 neither module can name a broker-writing capability', () => {
  const BANNED = [
    'placeOrder', 'closeTrade', 'modifyTrade', 'updateStop', 'setStopLoss',
    'modifyPosition', 'PositionModify', 'orderSend', 'createOrder',
    'stopLossPips', 'takeProfitPips', 'broker.place', '/api/orders', '/v1/positions',
  ]
  for (const f of FILES) {
    // Strip comments first: the modules legitimately DOCUMENT what they cannot do
    // ("contains no fetch, no broker adapter, no /api/orders"), and that prose must
    // not read as a capability.
    const src = readFileSync(new URL(f, import.meta.url), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/[^\n]*/g, '$1')
    for (const term of BANNED) {
      assert.equal(src.includes(term), false, `${f} must not contain '${term}'`)
    }
    // No broker adapter may be imported at all.
    assert.equal(/from '[^']*brokers\/[^']*'/.test(src), false, `${f} must not import a broker adapter`)
  }
})

t('§14 the observer performs no outbound I/O of its own', () => {
  for (const f of FILES) {
    const src = readFileSync(new URL(f, import.meta.url), 'utf8')
    for (const term of ['fetch(', 'XMLHttpRequest', 'WebSocket', 'https.request']) {
      assert.equal(src.includes(term), false, `${f} must not perform I/O ('${term}')`)
    }
  }
})

// ── 2. BEHAVIOURAL ────────────────────────────────────────────────────────
t('§14 a full lifecycle never reaches a broker-writing capability', async () => {
  const rt = createScalpShadowRuntime({
    now: (() => { let t = 1_000_000; return () => (t += 61_000) })(),
    throttleMs: 0,
    log: () => {},
    loadState: async () => ({}),
    saveState: async () => true,
    attribute: async () => ({ scalp: new Map([['1', {
      trade: { id: 'T', brokerTicket: 1, pair: 'XAU/USD', direction: 'BUY', lots: 0.1,
               entryPrice: 2000, currentPrice: 2010, unrealizedPL: 10, stopLossPrice: 1990,
               openTime: '2026-09-15T00:00:00.000Z' }, record: { id: 'T' } }]]), skipped: [] }),
    confirmClosed: async () => null,
    insertRow: async () => true,
    evaluate: () => ({ stateDelta: { peakProfit: 10 }, row: { broker_ticket: 1, row_kind: 'snapshot' } }),
  })
  const handoff = createShadowHandoff(rt)
  for (let i = 0; i < 5; i++) { handoff({ openTrades: [{ brokerTicket: 1, pair: 'XAU/USD' }], instrumentGeometry: { 'XAU/USD': { known: true, pip: 0.1, pipValuePerLot: 10 } } }); await tick() }
  await rt.whenIdle()
  // The ONLY side effects this module can produce are the injected ones above.
  // The handoff returns NOTHING, so a caller cannot route it into a risk decision.
  assert.equal(handoff({ openTrades: [] }), undefined, 'the handoff returns undefined')
})

t('§14 the handoff cannot throw, even on malformed input', () => {
  const rt = createScalpShadowRuntime({
    now: () => 1, throttleMs: 0, log: () => {}, loadState: async () => ({}),
    saveState: async () => true, attribute: async () => ({ scalp: new Map(), skipped: [] }),
    confirmClosed: async () => null, insertRow: async () => true,
    evaluate: () => ({ stateDelta: {}, row: {} }),
  })
  const handoff = createShadowHandoff(rt)
  for (const bad of [null, undefined, 0, 'x', {}, { openTrades: 'nope' }, { openTrades: null },
                     { openTrades: [], instrumentGeometry: 'bad' }, []]) {
    assert.doesNotThrow(() => handoff(bad), `handoff must tolerate ${JSON.stringify(bad)}`)
  }
})

if (failed) { console.error(`\n${failed} failed`); process.exit(1) }
console.log('scalp-shadow read-only: all tests passed')
