// tests/scalp-shadow-lifecycle.test.mjs
// ── PHASE 3: SCALP SHADOW OBSERVER — LIFECYCLE, HEALTH, PERSISTENCE ─────────
//
// Phase 2 could not explain why production produced ZERO scalp shadow evidence
// (no state, no telemetry, no logs) while the worker traded actively. These tests
// pin the mechanism and the repair.
//
// The runtime is exercised through its REAL interface with injected side effects,
// so `now`, the state store and the telemetry writer are fully deterministic.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createScalpShadowRuntime } from '../lib/scalp-shadow-runtime.mjs'

let failed = 0
// These tests are ASYNC — a sync try/catch would let failures escape as unhandled
// rejections and still print "all tests passed". Tests are registered, then run
// sequentially at the end.
const tests = []
const t = (name, fn) => tests.push([name, fn])
const tick = () => new Promise((r) => setImmediate(r))

const GEOM = { 'XAU/USD': { known: true, pip: 0.1, pipValuePerLot: 10 } }
const trade = (o = {}) => ({ id: 'T-1', pair: 'XAU/USD', direction: 'BUY', lots: 0.14, entryPrice: 2000,
  currentPrice: 2000, unrealizedPL: 0, stopLossPrice: 1997.5, openTime: '2026-09-15T00:00:00.000Z', ...o })

/** A clock the test drives explicitly. */
function clock(start = 1_000_000) { let t = start; return { now: () => t, advance: (ms) => (t += ms) } }

/**
 * A runtime wired to real-ish injected side effects.
 * `loadOk: false` simulates the production state store being unavailable (null).
 */
function harness({ loadOk = true, insertOk = true, throttleMs = 60_000, attrOk = true, evaluate } = {}) {
  const clk = clock()
  const logs = []
  const inserted = []
  let stored = {}
  const runtime = createScalpShadowRuntime({
    now: clk.now,
    throttleMs,
    log: (m) => logs.push(m),
    loadState: async () => (loadOk ? stored : null),
    saveState: async (next) => { stored = next; return true },
    attribute: async (trades) => {
      if (!attrOk) throw new Error('attribution unavailable')
      const scalp = new Map()
      for (const tr of trades) if (tr.source === 'scalp') scalp.set(String(tr.brokerTicket), { trade: tr, record: tr })
      return { scalp, skipped: trades.filter((x) => x.source !== 'scalp').map((x) => ({ ticket: x.brokerTicket, reason: 'source-mismatch' })) }
    },
    confirmClosed: async () => null,
    insertRow: async (row) => { if (!insertOk) return false; inserted.push(row); return true },
    evaluate: evaluate || (({ trade: tr, prior }) => ({
      stateDelta: { peakProfit: Math.max(prior?.peakProfit ?? 0, tr.unrealizedPL) },
      row: { broker_ticket: tr.brokerTicket, row_kind: 'snapshot', pair: tr.pair },
    })),
  })
  return { runtime, clk, logs, inserted, get stored() { return stored }, setStored: (v) => { stored = v } }
}

const obs = (h, trades, at) => h.runtime.observe({ trades, geometry: GEOM, at })

console.log('scalp shadow observer — lifecycle / health / persistence')

// ── §8 THE ROOT CAUSE: the state-load abort was completely silent ──────────
t('§8 state-load failure is now OBSERVABLE (counter + health + bounded log)', async () => {
  const logs = []
  const rt = createScalpShadowRuntime({
    now: () => 1, throttleMs: 0, log: (m) => logs.push(m),
    loadState: async () => null,                       // <-- the production failure mode
    saveState: async () => true, attribute: async () => ({ scalp: new Map(), skipped: [] }),
    confirmClosed: async () => null, insertRow: async () => true,
    evaluate: () => ({ stateDelta: {}, row: {} }),
  })
  await rt.observe({ trades: [trade({ source: 'scalp', brokerTicket: 1 })], geometry: GEOM, at: 1 })
  await tick()
  const s = rt.getStats()
  const h = rt.getHealth()
  assert.equal(s.stateLoadFailures, 1, 'the counter increments')
  assert.equal(h.status, 'STATE_LOAD_FAILED', 'health names the condition')
  assert.ok(logs.some((l) => /state store unavailable/.test(l)),
    'a log line is emitted — this is what was missing in production')
  assert.equal(s.rowsPersisted, 0, 'no telemetry can be written while the store is unavailable')
  assert.equal(s.evaluated, 0, 'no evaluation happens either — the abort is fail-closed')
})

t('§8/§9 "never ran" is distinguishable from "ran with nothing to do"', async () => {
  const h = harness()
  assert.equal(h.runtime.getHealth().status, null, 'status is null before the first cycle')
  await obs(h, [], 1_000_000)
  await tick()
  const health = h.runtime.getHealth()
  assert.notEqual(health.status, null, 'a completed cycle is NOT "never ran"')
  assert.ok(health.counts.NO_OPEN_TRADES >= 1,
    'the empty-snapshot condition is recorded, even though the cycle then persisted state')
})

// ── §9 every health state is reachable and distinct ───────────────────────
t('§9 health states are distinct and recorded', async () => {
  const h = harness()
  await obs(h, [trade({ source: 'mirror', brokerTicket: 9 })], 1_000_000); await tick()
  // The TERMINAL status of a cycle is whatever it ended on (state/telemetry were
  // persisted), so the mid-cycle conditions are asserted via `counts` — which is
  // exactly why counts exist.
  const c1 = h.runtime.getHealth().counts
  assert.ok(c1.TRADE_NOT_ATTRIBUTED >= 1, 'the not-attributed condition was recorded')
  h.clk.advance(61_000)
  await obs(h, [trade({ source: 'scalp', brokerTicket: 1 })], 1_000_061); await tick()
  const c2 = h.runtime.getHealth().counts
  assert.ok(c2.TRADE_OBSERVED >= 1, 'the observed condition was recorded')
  assert.ok(c2.STATE_INITIALISED >= 1, 'a first-run empty state is reported as INITIALISED')
  assert.ok(c2.TELEMETRY_PERSISTED >= 1, 'the telemetry write was recorded')
  // The two cycles ended in genuinely different states — the distinction Phase 2
  // could not make.
  assert.ok(!c1.TRADE_OBSERVED, 'cycle 1 never observed an attributable trade')
  assert.ok(c2.TRADE_OBSERVED >= 1, 'cycle 2 observed one')
})

t('§9 health transitions are LOGGED but a steady state does not flood', async () => {
  const h = harness({ throttleMs: 0 })
  for (let i = 0; i < 40; i++) { await obs(h, [], 1_000_000 + i); await tick() }
  const healthLogs = h.logs.filter((l) => /health →/.test(l))
  assert.ok(healthLogs.length >= 1, 'the first transition is logged')
  assert.ok(healthLogs.length <= 3,
    `40 cycles inside one rate-limit window must not log per cycle (got ${healthLogs.length})`)
  // …while every occurrence is still COUNTED, so nothing is lost.
  assert.equal(h.runtime.getHealth().counts.NO_OPEN_TRADES, 40, 'all 40 are counted')
})

// ── §10 telemetry failure is observable and non-fatal ─────────────────────
t('§10 telemetry insert failure → TELEMETRY_FAILED, observer keeps running', async () => {
  const h = harness({ insertOk: false })
  await obs(h, [trade({ source: 'scalp', brokerTicket: 1 })], 1_000_000); await tick()
  assert.ok(h.runtime.getStats().rowWriteFailures >= 1, 'failure counted')
  assert.equal(h.runtime.getHealth().status, 'TELEMETRY_FAILED', 'failure is named')
  h.clk.advance(61_000)
  await obs(h, [trade({ source: 'scalp', brokerTicket: 1 })], 1_000_061); await tick()
  assert.ok(h.runtime.getStats().evaluations >= 2, 'the observer continues after a write failure')
})

t('§10 telemetry success records a persisted row', async () => {
  const h = harness()
  await obs(h, [trade({ source: 'scalp', brokerTicket: 1 })], 1_000_000); await tick()
  assert.equal(h.inserted.length, 1, 'one row inserted')
  assert.equal(h.runtime.getStats().rowsPersisted, 1)
})

// ── §11 state persistence, restore, monotonicity, restart ─────────────────
t('§11 state is persisted, then RESTORED after a restart', async () => {
  const h = harness()
  await obs(h, [trade({ source: 'scalp', brokerTicket: 7, unrealizedPL: 5 })], 1_000_000); await tick()
  assert.ok(h.stored['7'], 'state written for the open trade')
  const peak = h.stored['7'].peakProfit
  assert.equal(peak, 5)

  // RESTART: a brand-new runtime sharing the same durable store.
  const h2 = harness()
  h2.setStored(h.stored)
  await obs(h2, [trade({ source: 'scalp', brokerTicket: 7, unrealizedPL: 3 })], 9_000_000); await tick()
  assert.ok(h2.logs.some((l) => /restored 1 open scalp state/.test(l)), 'restore is logged')
  assert.ok(h2.stored['7'].peakProfit >= peak, 'peak does not regress across a restart')
})

// ── §3/§4 THE 60-SECOND SAMPLING HYPOTHESIS ───────────────────────────────
// Deterministic: the clock is driven by the test, so the throttle is exact.
t('§3/§4/§8 a sub-interval lifecycle is NO LONGER missed — the 3.1 repair', async () => {
  const h = harness({ throttleMs: 60_000 })
  await obs(h, [], 1_000_000); await tick()          // priming sweep consumes the window
  assert.equal(h.runtime.getStats().evaluated, 0)

  // A 49-second trade: opens after the priming sweep, closes before the next
  // evaluation window would have been due.
  h.clk.advance(10_000)                              // t=+10s — INSIDE the window
  await obs(h, [trade({ source: 'scalp', brokerTicket: 3, unrealizedPL: 2 })], 1_000_010); await tick()
  assert.equal(h.runtime.getStats().throttled, 0, 'a first-seen trade bypasses the evaluation throttle')
  assert.ok(h.stored['3'], 'state registered immediately, without waiting for the window')
  assert.equal(h.inserted.length, 1, 'and it received its baseline evaluation + telemetry')

  h.clk.advance(39_000)                              // t=+49s — trade has now closed
  await obs(h, [], 1_000_049); await tick()
  assert.ok(h.runtime.getHealth().counts.AWAITING_CLOSE_CONFIRMATION >= 1,
    'the disappearance is detected and reported explicitly')
  assert.ok(h.stored['3'], 'the stored lifecycle is RETAINED — not silently deleted')
})

t('§3/§4 a position longer than the window IS observed', async () => {
  const h = harness({ throttleMs: 60_000 })
  await obs(h, [], 1_000_000); await tick()
  h.clk.advance(61_000)                       // past the window
  await obs(h, [trade({ source: 'scalp', brokerTicket: 4, unrealizedPL: 2 })], 1_000_061); await tick()
  assert.equal(h.runtime.getStats().evaluated, 1, 'a >60s position is evaluated')
  assert.equal(h.inserted.length, 1, 'and produces a telemetry row')
  assert.ok(h.stored['4'], 'and creates state')
})

t('§4/§15 discovery runs every sweep; only EVALUATION is throttled', async () => {
  // Architecture A/B are now separated on purpose. Proof:
  //   (1) inside the window, a FIRST-SEEN position is still discovered + persisted;
  //   (2) inside the window, a position already known has its evaluation skipped,
  //       and health reports THROTTLED — which now means "discovery ran, the
  //       scheduled expensive evaluation was not due", NOT "the trade was unseen".
  const h = harness({ throttleMs: 60_000 })
  await obs(h, [], 1_000_000); await tick()

  h.clk.advance(5_000)                                  // inside the window
  await obs(h, [trade({ source: 'scalp', brokerTicket: 5 })], 1_000_005); await tick()
  assert.ok(h.stored['5'], 'DISCOVERY ran inside the throttle window (first-seen persisted)')
  assert.equal(h.runtime.getStats().throttled, 0, 'first-seen also evaluated immediately')

  h.clk.advance(5_000)                                  // still inside the window
  await obs(h, [trade({ source: 'scalp', brokerTicket: 5 })], 1_000_010); await tick()
  assert.equal(h.runtime.getStats().throttled, 1, 'the scheduled evaluation was not due')
  assert.equal(h.runtime.getHealth().status, 'THROTTLED')
  assert.ok(h.stored['5'], 'the trade REMAINS tracked — THROTTLED no longer means "unseen"')
  assert.ok(h.runtime.getHealth().counts.TRADE_OBSERVED >= 1,
    'discovery still reported the position on the throttled sweep')

  // The throttle still lives at the right place: it gates evaluation, and the
  // evaluation never runs before the state is loaded (discovery precedes it).
  const src = readFileSync(new URL('../lib/scalp-shadow-runtime.mjs', import.meta.url), 'utf8')
  const i = src.indexOf('async function runOnce')
  const body = src.slice(i, i + 12000)
  const loadAt  = body.indexOf('await loadState()')
  const gateAt  = body.indexOf('const evalDue')
  assert.ok(loadAt > 0 && gateAt > 0 && loadAt < gateAt,
    'state load (discovery) precedes the evaluation gate')
  assert.equal(/async function runOnce[\s\S]{0,400}?lastEvalAt < throttleMs\) \{ stats\.throttled\+\+; setHealth/.test(src), false,
    'the early-return throttle must be gone from the top of the cycle')
})

// ── §6/§7 attribution + data-shape gates fail closed with a diagnostic ────
t('§6/§7 attribution failure observes NOTHING and reports why', async () => {
  const h = harness({ attrOk: false })
  await obs(h, [trade({ source: 'scalp', brokerTicket: 1 })], 1_000_000); await tick()
  assert.equal(h.runtime.getStats().evaluated, 0, 'fail-closed: nothing observed')
  assert.ok(h.runtime.getStats().attributionSkips >= 1, 'counted')
  assert.ok(h.logs.some((l) => /attribution unavailable/.test(l)), 'diagnosed')
  assert.equal(h.inserted.length, 0)
})

t('§7 missing instrument geometry skips the trade with a named reason', async () => {
  const h = harness()
  const bad = trade({ source: 'scalp', brokerTicket: 1, pair: 'ZZZ/USD' })
  await obs(h, [bad], 1_000_000); await tick()
  assert.ok(h.runtime.getStats().geometrySkips >= 1, 'geometry skip counted')
  assert.ok(h.runtime.getHealth().counts.TRADE_DATA_INCOMPLETE >= 1, 'health names it')
  assert.ok(h.logs.some((l) => /no-instrument-geometry/.test(l)), 'reason is explicit')
  assert.equal(h.inserted.length, 0, 'no telemetry for unvalidated geometry')
})

// ── Sequential async runner ─────────────────────────────────────────────────
for (const [name, fn] of tests) {
  try {
    await fn()
    console.log('  ok   ' + name)
  } catch (e) {
    failed++
    console.error('  FAIL ' + name + '\n        ' + (e.stack || e.message).split('\n').slice(0, 4).join('\n        '))
  }
}

if (failed) { console.error(`\n${failed} failed`); process.exit(1) }
console.log('scalp-shadow lifecycle: all tests passed')
