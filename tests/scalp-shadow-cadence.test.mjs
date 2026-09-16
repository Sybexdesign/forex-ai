// tests/scalp-shadow-cadence.test.mjs
// ── PHASE 3.2: OBSERVATION INDEPENDENT OF ORDER ATTEMPTS ───────────────────
//
// The third production defect: observation was reachable only via
// fetchRiskState(), whose sole caller is the auto-trade order path. No order
// attempt → no observation → no evidence in a flat market.
//
// These tests wire the REAL runtime, the REAL handoff and the REAL cadence
// together, faking only I/O (the account fetch, the state store, the telemetry
// writer). That is the production orchestration, not a reimplementation.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createScalpShadowRuntime, createShadowHandoff } from '../lib/scalp-shadow-runtime.mjs'
import { createShadowObserver } from '../lib/scalp-shadow-cadence.mjs'

let failed = 0
const tests = []
const t = (name, fn) => tests.push([name, fn])
const tick = () => new Promise((r) => setImmediate(r))

const GEOM = { 'XAU/USD': { known: true, pip: 0.1, pipValuePerLot: 10 } }
const trade = (o = {}) => ({ id: 'T-1', pair: 'XAU/USD', direction: 'BUY', lots: 0.14, entryPrice: 2000,
  currentPrice: 2000, unrealizedPL: 0, stopLossPrice: 1997.5, openTime: '2026-09-15T00:00:00.000Z', ...o })

/**
 * The REAL production orchestration: runtime + handoff + cadence.
 * Only I/O is faked. `fetchAccount` returns a NEW object per call, exactly like a
 * real HTTP response, so snapshot-identity dedupe behaves as in production.
 */
function workerFixture({ openTrades = [], loadResult = undefined, saveOk = true, insertOk = true, fetchThrows = false } = {}) {
  const clk = { t: 1_000_000, advance(ms) { this.t += ms } }
  const now = () => clk.t
  const logs = [], inserted = [], fetchCalls = { n: 0 }, orderAttempts = { n: 0 }
  let stored = {}
  const runtime = createScalpShadowRuntime({
    now,
    throttleMs: 60_000,
    log: (m) => logs.push(m),
    loadState: async () => (loadResult !== undefined ? loadResult
      : { status: Object.keys(stored).length ? 'OK_EXISTING' : 'OK_EMPTY', state: stored }),
    saveState: async (next) => { if (saveOk) stored = next; return saveOk },
    attribute: async (trades) => {
      const scalp = new Map()
      for (const tr of trades) if (tr.source === 'scalp') scalp.set(String(tr.brokerTicket), { trade: tr, record: tr })
      return { scalp, skipped: [] }
    },
    confirmClosed: async () => null,
    insertRow: async (row) => { if (!insertOk) return false; inserted.push(row); return true },
    evaluate: ({ trade: tr, prior }) => ({
      stateDelta: { peakProfit: Math.max(prior?.peakProfit ?? 0, tr.unrealizedPL) },
      row: { broker_ticket: tr.brokerTicket, row_kind: 'snapshot', pair: tr.pair },
    }),
  })
  const handoff = createShadowHandoff(runtime, { now })   // use the fake clock, not Date.now
  const observer = createShadowObserver({
    shadowHandoff: handoff,
    fetchAccount: async () => {
      fetchCalls.n++
      if (fetchThrows) throw new Error('account endpoint unreachable')
      return { openTrades: openTrades.map((x) => ({ ...x })), instrumentGeometry: GEOM }
    },
    getTrackedCount: () => Object.keys(runtime.getState() || {}).length,
    ttlMs: 30_000,
    now,
    log: (m) => logs.push(m),
  })
  return { runtime, observer, clk, logs, inserted, stored: () => stored, fetchCalls, orderAttempts }
}

/** One worker sweep: the tick is unconditional; no order path is entered. */
const sweep = async (f, marketOpen = true) => { await f.observer.tick(marketOpen); await tick() }

console.log('scalp shadow — Phase 3.2 observation reachability')

// ── §8 THE QUIET-MARKET PROOF (the most important test) ───────────────────
t('§8 quiet market, ZERO order attempts → observer still executes', async () => {
  const f = workerFixture({ openTrades: [trade({ source: 'scalp', brokerTicket: 42, unrealizedPL: 7 })] })
  for (let i = 0; i < 6; i++) { f.clk.advance(10_000); await sweep(f) }   // ~60s of 10s sweeps
  assert.equal(f.orderAttempts.n, 0, 'no order was attempted')
  const s = f.runtime.getStats(), h = f.runtime.getHealth()
  assert.ok(s.snapshotsObserved > 0, 'the observer RECEIVED snapshots')
  assert.ok((h.counts.STATE_INITIALISED || 0) >= 1, 'first-run state initialised')
  assert.ok((h.counts.TRADE_FIRST_SEEN || 0) >= 1, 'TRADE_FIRST_SEEN emitted')
  assert.notEqual(f.runtime.getState()['42'], undefined, 'position DISCOVERED and tracked')
  assert.ok(f.inserted.length >= 1, 'telemetry produced')
  console.log(`     orderAttempts=${f.orderAttempts.n} snapshotsObserved=${s.snapshotsObserved} handovers=${f.observer.getStats().handedOver} fetches=${f.fetchCalls.n} rows=${f.inserted.length}`)
})

t('§8 the tick is reachable with NO signal at all', async () => {
  const f = workerFixture({ openTrades: [trade({ source: 'scalp', brokerTicket: 1 })] })
  await sweep(f)                                    // a single sweep, no signal evaluation
  assert.equal(f.fetchCalls.n, 1, 'one authoritative fetch')
  assert.equal(f.runtime.getStats().snapshotsObserved, 1, 'observed on the first sweep')
})

// ── §3 account state is REUSED, not re-polled ─────────────────────────────
t('§3 a fresh snapshot is reused across sweeps (no extra traffic)', async () => {
  const f = workerFixture({ openTrades: [trade({ source: 'scalp', brokerTicket: 1 })] })
  await sweep(f)
  const afterFirst = f.fetchCalls.n
  for (let i = 0; i < 3; i++) { f.clk.advance(5_000); await sweep(f) }    // 15s — inside the 30s TTL
  assert.equal(f.fetchCalls.n, afterFirst, 'no extra fetch while the snapshot is fresh')
  assert.ok(f.observer.getStats().reuses >= 1, 'the reuse path was taken')
  f.clk.advance(31_000)                                                  // TTL expired
  await sweep(f)
  assert.equal(f.fetchCalls.n, afterFirst + 1, 'exactly one fetch after the TTL expired')
})

// ── §4/I evaluation cadence is UNCHANGED ──────────────────────────────────
t('§4/I 60s evaluation throttle survives the 10s discovery cadence', async () => {
  const f = workerFixture({ openTrades: [trade({ source: 'scalp', brokerTicket: 1 })] })
  for (let i = 0; i < 6; i++) { f.clk.advance(10_000); await sweep(f) }   // 6 sweeps over 60s
  const s = f.runtime.getStats()
  // Discovery ran on several sweeps, but the EXPENSIVE evaluation did NOT scale
  // with sweep count — the 60s cadence held.
  assert.ok(s.snapshotsObserved >= 2, `discovery ran repeatedly (got ${s.snapshotsObserved})`)
  assert.ok(s.evaluated <= 2, `evaluation must not scale with sweeps (evaluated=${s.evaluated})`)
  assert.ok(s.throttled >= 1, `later sweeps were throttled (throttled=${s.throttled})`)
  console.log(`     sweeps=6 snapshotsObserved=${s.snapshotsObserved} evaluations=${s.evaluations} evaluated=${s.evaluated} throttled=${s.throttled}`)
})

t('§4/J first-seen bypass remains immediate', async () => {
  const f = workerFixture({ openTrades: [] })
  await sweep(f)
  f.clk.advance(5_000)
  f.runtime.observe({ trades: [trade({ source: 'scalp', brokerTicket: 9 })], geometry: GEOM, at: f.clk.t })
  await tick()
  assert.equal(f.runtime.getStats().evaluated, 1, 'first-seen evaluated without waiting')
  assert.equal(f.runtime.getStats().throttled, 0, 'and it was not throttled')
})



// ── §5/§10 ONE canonical entry point; an order attempt observes ONCE ──────
t('§10 order path + sweep on the SAME snapshot → exactly ONE observation', async () => {
  const f = workerFixture({ openTrades: [trade({ source: 'scalp', brokerTicket: 5 })] })
  const acct = { openTrades: [trade({ source: 'scalp', brokerTicket: 5 })], instrumentGeometry: GEOM }
  // The order path publishes its freshly-fetched snapshot and observes it…
  f.observer.publishSnapshot(acct)
  assert.equal(f.observer.observeOnce(acct), true, 'the order path observed it once')
  // …then the very next sweep reuses that same snapshot.
  const r = await f.observer.tick(true)
  await tick()
  assert.equal(r.observed, false, 'the sweep did NOT observe it again')
  assert.equal(f.observer.getStats().handedOver, 1, 'exactly ONE handover for this snapshot')
  assert.equal(f.observer.getStats().deduped, 1, 'the duplicate was counted, not processed')
})

t('§5 there is exactly ONE canonical observation entry point', () => {
  const src = readFileSync(new URL('../workers/scalper.mjs', import.meta.url), 'utf8')
  const lines = src.split('\n')
  // `shadowHandoff` is no longer CALLED by the worker at all — it is injected into
  // the cadence module, which owns the single invocation. So the worker must
  // reference it exactly twice: the definition and the injection.
  const refs = lines.filter((l) => /shadowHandoff/.test(l) && !/^\s*(\/\/|\*)/.test(l))
  assert.equal(refs.length, 2, `shadowHandoff must only be defined + injected (found ${refs.length})`)
  assert.ok(refs.some((l) => /const shadowHandoff = createShadowHandoff/.test(l)), 'defined once')
  assert.ok(refs.some((l) => /^\s*shadowHandoff,$/.test(l)), 'injected once, never called directly')
  // Exactly one named entry point.
  const entry = lines.filter((l) => /const observeShadowOnce =/.test(l))
  assert.equal(entry.length, 1, 'exactly one observeShadowOnce definition')
  // And the cadence is driven from the SWEEP.
  assert.match(src, /await shadowObserver\.tick\(marketOpen\)/)
})

// ── §9 gate matrix: observation is NOT behind any trading gate ────────────
t('§9 confidence / hold / cooldown / no-signal skips cannot suppress observation', () => {
  const src = readFileSync(new URL('../workers/scalper.mjs', import.meta.url), 'utf8')
  const lines = src.split('\n')
  const sweepAt = lines.findIndex((l) => l.includes('async function runSweep()'))
  const tickLine = lines.findIndex((l) => l.includes('await shadowObserver.tick(marketOpen)'))
  assert.ok(sweepAt > 0, 'runSweep exists')
  assert.ok(tickLine > sweepAt, 'the tick lives INSIDE the sweep path')
  // The real property: no trading gate is evaluated between the start of the
  // sweep and the observation tick — the tick is not inside (or downstream of)
  // any of them. (The gate STRINGS also appear in helper definitions earlier in
  // the file, so a naive first-occurrence check would be wrong.)
  const between = lines.slice(sweepAt, tickLine).join('\n')
  for (const gate of ['skipped-confidence', 'skipped-cooldown', 'skipped-hold',
                      'MIN_CONFIDENCE', 'isTradeEligible']) {
    assert.equal(between.includes(gate), false,
      `'${gate}' must NOT be evaluated before the observation tick`)
  }
  console.log(`     sweep@${sweepAt + 1}  tick@${tickLine + 1}  (no gates in between)`)
})

t('§9 observation runs on every sweep regardless of signal gating', async () => {
  const f = workerFixture({ openTrades: [trade({ source: 'scalp', brokerTicket: 3 })] })
  await sweep(f, true)                                // market open, no signal
  assert.ok(f.runtime.getStats().snapshotsObserved >= 1)
  f.clk.advance(31_000)
  await sweep(f, true)                                // another open-market sweep, still no signal
  const seen = f.runtime.getStats().snapshotsObserved
  assert.ok(seen >= 2, `observation is independent of signal flow (snapshotsObserved=${seen}, fetches=${f.fetchCalls.n})`)
})


// ── §12 state-load diagnostics are reachable WITHOUT an order ─────────────
t('§12 STATE_LOAD_FAILED is reachable with no signal and no order', async () => {
  const f = workerFixture({ openTrades: [trade({ source: 'scalp', brokerTicket: 1 })],
                            loadResult: { status: 'HTTP_FAILURE', detail: 'HTTP 503' } })
  await sweep(f)
  assert.equal(f.orderAttempts.n, 0, 'no order attempt')
  assert.equal(f.runtime.getStats().stateLoadFailures, 1, 'the failure is counted')
  assert.equal(f.runtime.getHealth().status, 'STATE_LOAD_FAILED', 'and named')
  assert.ok(f.logs.some((l) => l.includes('HTTP_FAILURE')), 'the exact classification is preserved')
  assert.deepEqual(f.stored(), {}, 'no fabricated state')
})

t('§12 clean first run (OK_EMPTY) is reachable with no order', async () => {
  const f = workerFixture({ openTrades: [trade({ source: 'scalp', brokerTicket: 1 })],
                            loadResult: { status: 'OK_EMPTY', state: {} } })
  await sweep(f)
  assert.equal(f.orderAttempts.n, 0)
  assert.equal(f.runtime.getStats().stateLoadFailures, 0, 'NOT a failure')
  assert.ok((f.runtime.getHealth().counts.STATE_INITIALISED || 0) >= 1, 'initialised')
  assert.ok(f.stored()['1'], 'and the position was observed')
})

t('§12 CONFIG_NOT_FOUND is reachable and classified without an order', async () => {
  const f = workerFixture({ openTrades: [],
                            loadResult: { status: 'CONFIG_NOT_FOUND', detail: 'no active broker_config row' } })
  await sweep(f)
  assert.equal(f.runtime.getStats().stateLoadFailures, 1)
  assert.ok(f.logs.some((l) => l.includes('CONFIG_NOT_FOUND')), 'the distinct classification is preserved')
})

// ── §7 failure isolation ──────────────────────────────────────────────────
t('§7 a failing account fetch cannot throw into the sweep', async () => {
  const f = workerFixture({ fetchThrows: true, openTrades: [trade({ source: 'scalp', brokerTicket: 1 })] })
  let threw = false
  const r = await f.observer.tick(true).catch(() => { threw = true })
  await tick()
  assert.equal(threw, false, 'tick() must never reject')
  assert.equal(r.action, 'fetch-failed')
  assert.equal(f.observer.getStats().failures, 1, 'the failure is counted')
  assert.ok(f.logs.some((l) => /could not obtain an account snapshot/.test(l)), 'REPORTED, not hidden')
})

t('§7 an observer exception cannot reach the trading path', async () => {
  const logs = []
  const obs = createShadowObserver({
    shadowHandoff: () => { throw new Error('observer exploded') },
    fetchAccount: async () => ({ openTrades: [] }),
    getTrackedCount: () => 0,
    log: (m) => logs.push(m),
  })
  const r = await obs.tick(true)
  assert.equal(r.action, 'failed', 'the failure is contained')
  assert.ok(logs.some((l) => /observer exploded/.test(l)), 'and reported')
})

// ── §14 read-only invariant still holds for the new module ────────────────
t('§14 the cadence module is broker-read-only', () => {
  const src = readFileSync(new URL('../lib/scalp-shadow-cadence.mjs', import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/[^\n]*/g, '$1')
  for (const bad of ['placeOrder', 'closeTrade', 'modifyTrade', 'updateStop', 'setStopLoss', 'modifyStop',
                     'stopLossPips', 'takeProfitPips', 'broker.', 'brokers/']) {
    assert.equal(src.includes(bad), false, `cadence must not reference '${bad}'`)
  }
  assert.equal(/fetch\(/.test(src), false, 'no I/O of its own — fetchAccount is injected')
})

// ── Sequential async runner ───────────────────────────────────────────────
for (const [name, fn] of tests) {
  try { await fn(); console.log('  ok   ' + name) }
  catch (e) { failed++; console.error('  FAIL ' + name + '\n        ' + (e.stack || e.message).split('\n').slice(0, 4).join('\n        ')) }
}
if (failed) { console.error(`\n${failed} failed`); process.exit(1) }
console.log('scalp-shadow cadence: all tests passed')
