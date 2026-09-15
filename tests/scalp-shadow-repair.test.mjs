// tests/scalp-shadow-repair.test.mjs
// ── PHASE 3.1: LIFECYCLE DISCOVERY & PERSISTENCE REPAIR — MATRICES ─────────
//
// Phase 3 proved two defects: (1) a `null` state load aborted the cycle
// silently, and (2) the 60s evaluation throttle gated DISCOVERY, so a position
// shorter than the interval could be completely invisible.
//
// This suite pins the repair: discovery runs every sweep, only the expensive
// evaluation is throttled, and a first-seen position bypasses that throttle once.
// Time is driven by the test, so the throttle boundaries are exact.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createScalpShadowRuntime } from '../lib/scalp-shadow-runtime.mjs'

let failed = 0
const tests = []
const t = (name, fn) => tests.push([name, fn])
const tick = () => new Promise((r) => setImmediate(r))

const GEOM = { 'XAU/USD': { known: true, pip: 0.1, pipValuePerLot: 10 } }
const trade = (o = {}) => ({ id: 'T-1', pair: 'XAU/USD', direction: 'BUY', lots: 0.14, entryPrice: 2000,
  currentPrice: 2000, unrealizedPL: 0, stopLossPrice: 1997.5, openTime: '2026-09-15T00:00:00.000Z', ...o })

function clock(start = 1_000_000) {
  let t = start
  return { now: () => t, advance: (ms) => (t += ms) }
}

/** `loadResult` lets a test simulate every structured state-load outcome. */
function harness({ throttleMs = 60_000, loadResult = undefined, saveOk = true, insertOk = true } = {}) {
  const clk = clock()
  const logs = [], inserted = []
  let stored = {}
  const runtime = createScalpShadowRuntime({
    now: clk.now,
    throttleMs,
    log: (m) => logs.push(m),
    loadState: async () => (loadResult !== undefined ? loadResult : ({ status: Object.keys(stored).length ? 'OK_EXISTING' : 'OK_EMPTY', state: stored })),
    saveState: async (next) => { if (saveOk) stored = next; return saveOk },
    attribute: async (trades) => {
      const scalp = new Map()
      for (const tr of trades) if (tr.source === 'scalp') scalp.set(String(tr.brokerTicket), { trade: tr, record: tr })
      return { scalp, skipped: trades.filter((x) => x.source !== 'scalp').map((x) => ({ ticket: x.brokerTicket, reason: 'source-mismatch' })) }
    },
    confirmClosed: async () => null,           // nothing is ever "confirmed closed" here
    insertRow: async (row) => { if (!insertOk) return false; inserted.push(row); return true },
    evaluate: ({ trade: tr, prior }) => ({
      stateDelta: { peakProfit: Math.max(prior?.peakProfit ?? 0, tr.unrealizedPL) },
      row: { broker_ticket: tr.brokerTicket, row_kind: 'snapshot', pair: tr.pair },
    }),
  })
  return { runtime, clk, logs, inserted, get stored() { return stored }, setStored: (v) => { stored = v } }
}

const sweep = async (h, trades, at) => {
  await h.runtime.observe({ trades, geometry: GEOM, at })
  await tick()
}

/**
 * One full lifecycle: priming sweep → position appears → position closes.
 * Returns the observable facts for the §8 matrix.
 */
async function lifecycleCase(seconds, opts = {}) {
  const h = harness(opts)
  await sweep(h, [], h.clk.now())                        // priming sweep
  h.clk.advance(5_000)                                   // opens just after an evaluation
  await sweep(h, [trade({ source: 'scalp', brokerTicket: 1, unrealizedPL: 3 })], h.clk.now())
  const firstSeen  = !!h.stored['1']
  const firstEval  = h.runtime.getStats().evaluated
  const rows       = h.inserted.length
  h.clk.advance(seconds * 1000)                          // the trade closes
  await sweep(h, [], h.clk.now())
  const counts = h.runtime.getHealth().counts
  return {
    firstSeen, firstEval, rows,
    disappearanceDetected: (counts.AWAITING_CLOSE_CONFIRMATION || 0) >= 1,
    retained: !!h.stored['1'],
    missed: !firstSeen,
  }
}

console.log('scalp shadow — Phase 3.1 lifecycle discovery matrices')


// ── §8 SHORT-LIFECYCLE ACCEPTANCE MATRIX ──────────────────────────────────
// FINAL REQUIRED RESULT: completely missed = NO for every eligible case.
t('§8 10/30/49/59/60/61/90-second lifecycles are ALL discovered', async () => {
  const DURATIONS = [10, 30, 49, 59, 60, 61, 90]
  const rows = []
  for (const d of DURATIONS) rows.push([d, await lifecycleCase(d)])
  console.log('\n     sec  firstSeen  firstEval  rows  disappearance  retained  MISSED')
  for (const [d, r] of rows) {
    console.log(`     ${String(d).padStart(3)}  ${String(r.firstSeen).padStart(9)}  ${String(r.firstEval).padStart(9)}  ${String(r.rows).padStart(4)}  ${String(r.disappearanceDetected).padStart(13)}  ${String(r.retained).padStart(8)}  ${r.missed ? 'YES' : 'no'}`)
  }
  for (const [d, r] of rows) {
    assert.equal(r.missed, false, `${d}s: MUST NOT be completely missed`)
    assert.equal(r.firstSeen, true, `${d}s: first-seen must be registered`)
    assert.ok(r.firstEval >= 1, `${d}s: must receive its baseline evaluation`)
    assert.ok(r.rows >= 1, `${d}s: must produce telemetry`)
    assert.equal(r.disappearanceDetected, true, `${d}s: disappearance must be detected`)
    assert.equal(r.retained, true, `${d}s: lifecycle must be retained for reconciliation`)
  }
})

t('§8/§6 only the FIRST evaluation bypasses the throttle; later ones do not', async () => {
  const h = harness({ throttleMs: 60_000 })
  await sweep(h, [], h.clk.now())
  h.clk.advance(5_000)
  await sweep(h, [trade({ source: 'scalp', brokerTicket: 1 })], h.clk.now())
  assert.equal(h.runtime.getStats().throttled, 0, 'first evaluation is not throttled')
  h.clk.advance(5_000)                                   // still inside the window
  await sweep(h, [trade({ source: 'scalp', brokerTicket: 1 })], h.clk.now())
  assert.equal(h.runtime.getStats().throttled, 1, 'the SECOND evaluation IS throttled')
  assert.equal(h.runtime.getStats().evaluated, 1, 'and no further analysis ran')
  h.clk.advance(61_000)                                  // window elapsed
  await sweep(h, [trade({ source: 'scalp', brokerTicket: 1 })], h.clk.now())
  assert.equal(h.runtime.getStats().evaluated, 2, 'a later evaluation is due again')
})

// ── §9 TIMING BOUNDARIES — no discovery blind spot ────────────────────────
t('§9 a position appearing at ANY point in the window is still discovered', async () => {
  for (const offset of [1, 30_000, 59_999, 60_000]) {
    const h = harness({ throttleMs: 60_000 })
    await sweep(h, [], h.clk.now())
    h.clk.advance(offset)
    await sweep(h, [trade({ source: 'scalp', brokerTicket: 1 })], h.clk.now())
    assert.ok(h.stored['1'], `offset ${offset}ms: first-seen must be discovered`)
  }
})

// ── §10 MULTIPLE SIMULTANEOUS POSITIONS ───────────────────────────────────
t('§10 two positions opening together are BOTH discovered', async () => {
  const h = harness({ throttleMs: 60_000 })
  await sweep(h, [], h.clk.now())
  h.clk.advance(5_000)
  await sweep(h, [trade({ source: 'scalp', brokerTicket: 1 }), trade({ source: 'scalp', brokerTicket: 2 })], h.clk.now())
  assert.ok(h.stored['1'] && h.stored['2'], 'both registered on the same sweep')
  assert.equal(h.runtime.getStats().evaluated, 2, 'both evaluated')
  assert.equal(h.inserted.length, 2, 'both produced telemetry')
})

t('§10 one short + one long overlapping trade: neither hides the other', async () => {
  const h = harness({ throttleMs: 60_000 })
  await sweep(h, [], h.clk.now())
  h.clk.advance(5_000)
  await sweep(h, [trade({ source: 'scalp', brokerTicket: 1, unrealizedPL: 2 }),
                  trade({ source: 'scalp', brokerTicket: 2, unrealizedPL: 9 })], h.clk.now())
  assert.ok(h.stored['1'] && h.stored['2'], 'both first-seen registered')

  // #1 closes quickly while #2 keeps running — #2 must remain tracked, and its
  // evaluation must not be blocked by #1's disappearance.
  h.clk.advance(61_000)                                 // let the evaluation window elapse
  await sweep(h, [trade({ source: 'scalp', brokerTicket: 2, unrealizedPL: 12 })], h.clk.now())
  assert.ok(h.stored['2'], 'the surviving trade is still tracked')
  assert.ok(h.stored['1'], 'the closed trade is retained, awaiting close confirmation')
  assert.equal(h.stored['2'].peakProfit, 12, 'independent peaks tracked')
})

t('§10 three overlapping trades close out of order without cross-contamination', async () => {
  const h = harness({ throttleMs: 60_000 })
  await sweep(h, [], h.clk.now())
  h.clk.advance(5_000)
  await sweep(h, [trade({ source: 'scalp', brokerTicket: 1, unrealizedPL: 1 }),
                  trade({ source: 'scalp', brokerTicket: 2, unrealizedPL: 2 }),
                  trade({ source: 'scalp', brokerTicket: 3, unrealizedPL: 3 })], h.clk.now())
  assert.deepEqual(Object.keys(h.stored).sort(), ['1', '2', '3'])
  h.clk.advance(2_000)
  await sweep(h, [trade({ source: 'scalp', brokerTicket: 3 }),
                  trade({ source: 'scalp', brokerTicket: 1 })], h.clk.now())  // #2 gone first
  assert.ok(h.stored['2'], '#2 retained')
  assert.ok(h.stored['1'] && h.stored['3'], '#1 and #3 untouched')
})

t('§10 a new trade is never hidden by the throttle consumed by an older one', async () => {
  const h = harness({ throttleMs: 60_000 })
  await sweep(h, [], h.clk.now())
  // Trade A seen first (consumes the window via its bypass evaluation).
  h.clk.advance(5_000)
  await sweep(h, [trade({ source: 'scalp', brokerTicket: 1 })], h.clk.now())
  const before = h.runtime.getStats().evaluated
  // Trade B appears moments later, still inside the window. Its FIRST evaluation
  // must still happen even though A already "used" the window.
  h.clk.advance(1_000)
  await sweep(h, [trade({ source: 'scalp', brokerTicket: 1 }), trade({ source: 'scalp', brokerTicket: 2 })], h.clk.now())
  assert.ok(h.stored['2'], 'the newer trade is registered')
  // A first-seen position triggers ONE early pass; `lastEvalAt` is still stamped,
  // so the normal 60s cadence for already-known trades is unchanged.
  assert.ok(h.runtime.getStats().evaluated > before,
    'the new trade received its own baseline evaluation despite the consumed window')
})


// ── §12 RESTART MATRIX ────────────────────────────────────────────────────
t('§12 Restart A — state exists + trade still open → restored, no duplicate', async () => {
  const h = harness()
  await sweep(h, [], h.clk.now())
  h.clk.advance(5_000)
  await sweep(h, [trade({ source: 'scalp', brokerTicket: 7, unrealizedPL: 5 })], h.clk.now())

  const h2 = harness()                       // a NEW runtime sharing the store
  h2.setStored(h.stored)
  await sweep(h2, [trade({ source: 'scalp', brokerTicket: 7, unrealizedPL: 8 })], h2.clk.now())
  assert.equal(h2.runtime.getStats().evaluated, 1, 'the still-open trade is evaluated')
  assert.ok(h2.logs.some((l) => /restored 1 open scalp state/.test(l)), 'restore is logged')
  assert.ok(h2.stored['7'].peakProfit >= 5, 'peak monotonic across restart')
  assert.equal(Object.keys(h2.stored).length, 1, 'NO duplicate lifecycle was created')
  assert.equal(h2.runtime.getStats().stateLoadFailures, 0, 'the restore was not an error')
})

t('§12 Restart B — state exists + trade already closed → retained, not abandoned', async () => {
  const h = harness()
  await sweep(h, [], h.clk.now())
  h.clk.advance(5_000)
  await sweep(h, [trade({ source: 'scalp', brokerTicket: 8, unrealizedPL: 4 })], h.clk.now())
  const h2 = harness()
  h2.setStored(h.stored)
  await sweep(h2, [], h2.clk.now())           // the trade is no longer open
  assert.ok(h2.stored['8'], 'state RETAINED for reconciliation — not silently dropped')
  assert.ok((h2.runtime.getHealth().counts.AWAITING_CLOSE_CONFIRMATION || 0) >= 1,
    'and the awaiting-confirmation state is reported')
})

t('§12 Restart C — no state + eligible trade open → treated as first-seen', async () => {
  const h = harness()
  await sweep(h, [trade({ source: 'scalp', brokerTicket: 9 })], h.clk.now())
  assert.ok(h.stored['9'], 'registered as first-seen on a cold start')
  assert.ok((h.runtime.getHealth().counts.STATE_INITIALISED || 0) >= 1, 'reported as initialisation, not restore')
})

t('§12 Restart D — storage UNAVAILABLE → fail closed, NO fabricated state', async () => {
  const h = harness({ loadResult: { status: 'HTTP_FAILURE', detail: 'HTTP 503' } })
  await sweep(h, [trade({ source: 'scalp', brokerTicket: 1 })], h.clk.now())
  assert.equal(h.runtime.getStats().stateLoadFailures, 1, 'the failure is counted')
  assert.equal(h.runtime.getHealth().status, 'STATE_LOAD_FAILED', 'and named')
  assert.equal(h.inserted.length, 0, 'no telemetry')
  assert.deepEqual(h.stored, {}, 'NO fabricated state — storage was never written')
  assert.equal(h.runtime.getStats().evaluated, 0, 'fail-closed: nothing evaluated')
})

t('§12 Restart E — valid config but NO scalpShadowState → clean first run', async () => {
  const h = harness({ loadResult: { status: 'OK_EMPTY', state: {} } })
  await sweep(h, [trade({ source: 'scalp', brokerTicket: 1 })], h.clk.now())
  assert.equal(h.runtime.getStats().stateLoadFailures, 0, 'NOT a failure')
  assert.ok((h.runtime.getHealth().counts.STATE_INITIALISED || 0) >= 1, 'initialised cleanly')
  assert.ok(h.stored['1'], 'and the trade is observed')
})

t('§2/§3 every structured load status is classified correctly', async () => {
  const FAIL = ['HTTP_FAILURE', 'TIMEOUT', 'NETWORK_FAILURE', 'MALFORMED_RESPONSE', 'CONFIG_NOT_FOUND']
  for (const status of FAIL) {
    const h = harness({ loadResult: { status, detail: 'test' } })
    await sweep(h, [trade({ source: 'scalp', brokerTicket: 1 })], h.clk.now())
    assert.equal(h.runtime.getStats().stateLoadFailures, 1, `${status} must be a failure`)
    assert.equal(h.runtime.getHealth().status, 'STATE_LOAD_FAILED', `${status} must be named`)
    assert.ok(h.logs.some((l) => l.includes(status)), `${status} must appear in the diagnostic`)
    assert.deepEqual(h.stored, {}, `${status} must NOT fabricate state`)
  }
  for (const status of ['OK_EXISTING', 'OK_EMPTY']) {
    const h = harness({ loadResult: { status, state: {} } })
    await sweep(h, [trade({ source: 'scalp', brokerTicket: 1 })], h.clk.now())
    assert.equal(h.runtime.getStats().stateLoadFailures, 0, `${status} must NOT be a failure`)
  }
  const legacyOk = harness({ loadResult: {} })
  await sweep(legacyOk, [trade({ source: 'scalp', brokerTicket: 1 })], legacyOk.clk.now())
  assert.equal(legacyOk.runtime.getStats().stateLoadFailures, 0, 'legacy object result = ok')
})

// ── §13 STATE PERSISTENCE FAILURE ─────────────────────────────────────────
t('§13 saveState failure → STATE_WRITE_FAILED, counted, non-fatal, retried', async () => {
  const h = harness({ saveOk: false })
  await sweep(h, [], h.clk.now())
  h.clk.advance(5_000)
  await sweep(h, [trade({ source: 'scalp', brokerTicket: 1, unrealizedPL: 6 })], h.clk.now())
  assert.ok(h.runtime.getStats().stateWriteFailures >= 1, 'failure counted')
  assert.ok((h.runtime.getHealth().counts.STATE_WRITE_FAILED || 0) >= 1, 'failure named')
  assert.deepEqual(h.stored, {}, 'nothing durable was written — no false claim of persistence')
  h.clk.advance(61_000)
  await sweep(h, [trade({ source: 'scalp', brokerTicket: 1, unrealizedPL: 6 })], h.clk.now())
  assert.ok(h.runtime.getStats().evaluations >= 3, 'the observer continued after the failure')
})

// ── §14 TELEMETRY FAILURE IS OBSERVATIONAL ONLY ───────────────────────────
t('§14 telemetry failure never stops the lifecycle', async () => {
  const h = harness({ insertOk: false })
  await sweep(h, [], h.clk.now())
  h.clk.advance(5_000)
  await sweep(h, [trade({ source: 'scalp', brokerTicket: 1, unrealizedPL: 7 })], h.clk.now())
  assert.ok(h.runtime.getStats().rowWriteFailures >= 1, 'counted')
  assert.ok((h.runtime.getHealth().counts.TELEMETRY_FAILED || 0) >= 1, 'named')
  assert.ok(h.stored['1'], 'state still persisted despite telemetry failure')
  h.clk.advance(61_000)
  await sweep(h, [trade({ source: 'scalp', brokerTicket: 1, unrealizedPL: 9 })], h.clk.now())
  assert.equal(h.runtime.getStats().evaluations >= 3, true, 'the next lifecycle cycle still ran')
})

// ── §16 BOUNDED LOGGING ───────────────────────────────────────────────────
t('§16 a steady cadence does not log per cycle', async () => {
  const h = harness({ throttleMs: 60_000 })
  for (let i = 0; i < 120; i++) {          // ~1 hour at a 30s cadence
    h.clk.advance(30_000)
    await sweep(h, [trade({ source: 'scalp', brokerTicket: 1, unrealizedPL: 1 })], h.clk.now())
  }
  const healthLogs = h.logs.filter((l) => /health →/.test(l))
  console.log(`     sweeps=120 evaluations=${h.runtime.getStats().evaluations} rows=${h.inserted.length} healthLogLines=${healthLogs.length}`)
  assert.ok(healthLogs.length <= 70, `health lines must be rate-limited (got ${healthLogs.length})`)
  assert.ok(h.inserted.length > 0, 'telemetry still flows')
})

// ── §18/§19 FREEZES ───────────────────────────────────────────────────────
t('§18 the protection ALGORITHM is frozen (bands + MFE/BE intact)', () => {
  const pp = readFileSync(new URL('../lib/profit-protection.mjs', import.meta.url), 'utf8')
  const pc = readFileSync(new URL('../lib/protection-candidates.mjs', import.meta.url), 'utf8')
  const sp = readFileSync(new URL('../lib/scalp-shadow-protection.mjs', import.meta.url), 'utf8')
  // The 55/65/75/85 retention bands must be byte-identical in intent.
  for (const band of ['0.55', '0.65', '0.75', '0.85']) {
    assert.ok(pp.includes(band), `retention band ${band} present in profit-protection.mjs`)
  }
  assert.match(pp, /RETENTION RATCHET/, 'the ratchet design note is intact')
  // MFE composition lives in protection-candidates; BE / partial-lock in the manager.
  assert.match(pc, /MFE|mfe/, 'MFE candidate logic present')
  assert.match(sp, /partial|PROTECT|LOCK|STRONG/, 'stage vocabulary present')
})

t('§19 Capital is untouched: IBroker gained NO stop-modify method', () => {
  const iface = readFileSync(new URL('../lib/brokers/interface.ts', import.meta.url), 'utf8')
  for (const banned of ['modifyStop', 'updateStop', 'modifyTrade', 'setStopLoss']) {
    assert.equal(iface.includes(banned), false, `IBroker must not declare ${banned}`)
  }
})

// ── Sequential async runner ───────────────────────────────────────────────
for (const [name, fn] of tests) {
  try { await fn(); console.log('  ok   ' + name) }
  catch (e) { failed++; console.error('  FAIL ' + name + '\n        ' + (e.stack || e.message).split('\n').slice(0, 4).join('\n        ')) }
}
if (failed) { console.error(`\n${failed} failed`); process.exit(1) }
console.log('scalp-shadow repair: all tests passed')

