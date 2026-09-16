// tests/candle-time-format.test.mjs
// ── CANDLE TIMESTAMPS MUST BE PARSEABLE (production 500 regression) ─────────
//
// INCIDENT: /api/scalper/tick returned 500 {"detail":"Invalid time value"}.
//
// CHAIN (proven):
//   1. lib/brokers/oanda.adapter.ts requests `Accept-Datetime-Format: UNIX`, so
//      OANDA returns the bar time as a NUMERIC STRING of SECONDS
//      ("1789556700.000000000"). The adapter passed it through raw.
//   2. `new Date("1789556700.000000000")` is an Invalid Date — no JS Date parser
//      accepts fractional Unix seconds.
//   3. selectLatestClosedCandle() therefore discarded EVERY OANDA bar as untimed,
//      so the closed-bar selector saw nothing.
//   4. evaluateMarketHealth() then read the raw string and called .toISOString()
//      on the Invalid Date. `lastTime ? lastTime.toISOString() : null` used the
//      Date object's TRUTHINESS — and an Invalid Date is truthy — so instead of
//      the intended TIME_ERROR verdict it threw RangeError("Invalid time value"),
//      crashing the route.
//
// These tests exercise the real functions (market-health has no module-level
// `require`, so it imports cleanly) plus the new normaliser.
import assert from 'node:assert/strict'
import { evaluateMarketHealth, selectLatestClosedCandle } from '../lib/market-health.ts'
import { toIsoUtc } from '../lib/brokers/oanda.adapter.ts'

let failed = 0
const tests = []
const t = (name, fn) => tests.push([name, fn])

const SPAN = 5 * 60_000
const NOW  = Date.parse('2026-09-16T10:00:00.000Z')

/** Bars exactly as OANDA delivers them with Accept-Datetime-Format: UNIX.
 *  TRUE 5-minute spacing (300_000 ms): a 300 ms spacing made the broker-clock
 *  inference read nonsense and mis-report staleness. */
const unixBars = (n = 80) => {
  const out = []
  for (let i = 0; i < n; i++) {
    const ms = NOW - (n - i) * 300_000        // newest bar opens 5 min before NOW
    out.push({ time: `${ms / 1000}.000000000`, open: 100, high: 101, low: 99, close: 100.5, volume: 10 })
  }
  return out
}
/** Bars with a proper ISO time. */
const isoBars = (n = 80) => unixBars(n).map((b) => ({ ...b, time: new Date(parseFloat(b.time) * 1000).toISOString() }))

console.log('candle timestamps — format / resilience')

t('PREMISE: a UNIX-seconds string is an Invalid Date in JS', () => {
  assert.equal(Number.isFinite(new Date('1789556700.000000000').getTime()), false)
  assert.equal(Number.isFinite(new Date('1789556700').getTime()), false)
})

t('toIsoUtc converts OANDA UNIX strings to ISO-8601 UTC', () => {
  assert.equal(toIsoUtc('1789556700.000000000'), new Date(1789556700 * 1000).toISOString())
  assert.equal(toIsoUtc('1789556700'), new Date(1789556700 * 1000).toISOString())
  assert.equal(toIsoUtc('2026-09-16T20:15:00.000Z'), '2026-09-16T20:15:00.000Z', 'ISO passes through')
  assert.equal(toIsoUtc(1789556700000), new Date(1789556700000).toISOString(), 'ms numbers')
  for (const bad of [null, undefined, '', '   ', 'garbage', NaN, {}, []]) {
    assert.equal(toIsoUtc(bad), null, `${JSON.stringify(bad)} -> null, never a throw`)
  }
})

t('PREMISE: untimed bars are discarded by the closed-candle selector', () => {
  const sel = selectLatestClosedCandle(unixBars(80), SPAN, NOW, 'probe:5m')
  assert.equal(sel.none, true, 'every UNIX-string bar is untimed, so nothing is selectable')
  assert.equal(sel.closedCount, 0)
})

t('DEFECT: market-health no longer throws on an unparseable timestamp (was a 500)', () => {
  // This is the exact call that crashed production.
  let verdict
  assert.doesNotThrow(() => {
    verdict = evaluateMarketHealth(unixBars(80), SPAN, NOW, { pair: 'XAU/USD', timeframe: '5m' })
  }, 'an untimed feed must produce a verdict, not a RangeError')
  assert.equal(verdict.status, 'TIME_ERROR', 'and the verdict is the intended fail-closed one')
  assert.equal(verdict.dataSuspended, true, 'dataSuspended so /api/scalper/signal refuses to generate')
  assert.equal(verdict.lastCandleTime, null, 'no fabricated timestamp')
})

t('a healthy ISO feed still reports HEALTHY (no over-correction)', () => {
  // Distinct cacheKey: inferBrokerOffsetMs() caches the calibrated offset per
  // `${pair}:${timeframe}`, and the key is meant to identify one data source.
  // Reusing the untimed probe's key would inherit its (bogus) offset and
  // mis-report staleness, so this case uses its own.
  const v = evaluateMarketHealth(isoBars(80), SPAN, NOW, { pair: 'XAU/USD', timeframe: '15m' })
  assert.equal(v.status, 'HEALTHY')
  assert.equal(v.dataSuspended, false)
  assert.ok(v.lastCandleTime, 'a real timestamp is reported')
  const sel = selectLatestClosedCandle(isoBars(80), SPAN, NOW, 'iso:5m')
  assert.equal(sel.none, false)
  assert.ok(sel.closedCount >= 60, `closed bars available for indicators (got ${sel.closedCount})`)
})

t('every degenerate timestamp shape is tolerated, none throws', () => {
  for (const bad of ['garbage', NaN, undefined, null, {}, '1789556700.000000000']) {
    const bars = isoBars(80)
    bars[bars.length - 1] = { ...bars[bars.length - 1], time: bad }
    assert.doesNotThrow(() => evaluateMarketHealth(bars, SPAN, NOW, { pair: 'XAU/USD', timeframe: '5m' }),
      `time=${JSON.stringify(bad)} must not throw`)
    assert.doesNotThrow(() => selectLatestClosedCandle(bars, SPAN, NOW, 'probe:5m'),
      `time=${JSON.stringify(bad)} must not throw in the selector`)
  }
})

// ── runner ────────────────────────────────────────────────────────────────
for (const [name, fn] of tests) {
  try { await fn(); console.log(`  ✓ ${name}`) }
  catch (e) { failed++; console.error(`  ✗ ${name}\n      ${e?.message}`) }
}
console.log(`\n${tests.length - failed}/${tests.length} passed`)
process.exit(failed ? 1 : 0)
