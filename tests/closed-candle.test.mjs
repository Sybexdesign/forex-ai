// tests/closed-candle.test.mjs
// Closed-candle selection + market-health tests (audit fix 2026-09-04).
//
// Run:
//   npm run test:market-health
//
// The test compiles the single pure module lib/market-health.ts to CJS first
// (no app bootstrap / DB required) and exercises the exact production logic:
//   A  forming candle exists → latest fully closed candle is selected
//   B  same closed candle requested repeatedly → identical selection
//   C  next candle closes → selection advances
//   D  no valid closed candle → none=true
//   E  broker offset +3h → correct closed candle (no false candle_open)
//   F  stale feed → dataSuspended=true (signal generation blocked)
//   G  time error → dataSuspended=true (signal generation blocked)
//   H  forming candle never enters the closed data set (no lookahead)
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import assert from 'node:assert/strict'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const outDir = path.join(root, '.testbuild')
const mhPath = path.join(outDir, 'market-health.js')

// Compile the single pure module (mirrors npm script build:market-health-test).
const tscBin = path.join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'tsc.cmd' : 'tsc')
const compiled = spawnSync(tscBin, [
  'lib/market-health.ts',
  '--outDir', outDir,
  '--module', 'commonjs',
  '--target', 'es2020',
  '--esModuleInterop',
  '--skipLibCheck',
], { cwd: root, encoding: 'utf8' })
if (compiled.status !== 0) {
  console.error(compiled.stdout)
  console.error(compiled.stderr)
  throw new Error('tsc compile of lib/market-health.ts failed')
}

const { selectLatestClosedCandle, evaluateMarketHealth } = await import(mhPath)

const FIVE_MIN = 5 * 60_000
const now = Date.now()

/** Build `count` ascending candles ending at the given open (ms). */
function makeCandles(openEndMs, spanMs = FIVE_MIN, count = 200) {
  const candles = []
  for (let i = 0; i < count; i++) {
    const t = openEndMs - (count - 1 - i) * spanMs
    candles.push({ time: new Date(t).toISOString(), open: 1.2, high: 1.21, low: 1.19, close: 1.205, volume: 100 })
  }
  return candles
}

// UTC now aligned: the forming bar opened at the last 5m boundary.
const lastOpen = now - (now % FIVE_MIN)

// ── Test A — forming candle present → bars[len-1] forming, bars[len-2] closed
{
  const candles = makeCandles(lastOpen)
  const sel = selectLatestClosedCandle(candles, FIVE_MIN, now, 'A:test')
  assert.equal(sel.none, false, 'A: a closed candle exists')
  assert.equal(sel.formingPresent, true, 'A: newest bar is forming')
  assert.equal(sel.closedCount, candles.length - 1, 'A: exactly one bar excluded (the forming one)')
  assert.equal(sel.closedCloseTime, new Date(lastOpen - FIVE_MIN + FIVE_MIN).toISOString(),
    'A: latest closed candle close = the boundary that just ended')
  assert.ok(sel.newestIsForming, 'A: newest candle flagged forming')
  console.log('PASS A: forming present → previous closed candle selected')
}

// ── Test A2 — feed newest-first (descending) orientation is handled robustly
{
  const candles = makeCandles(lastOpen).reverse()
  const sel = selectLatestClosedCandle(candles, FIVE_MIN, now, 'A2:test')
  assert.equal(sel.none, false)
  assert.equal(sel.formingPresent, true)
  assert.equal(sel.closedCount, candles.length - 1)
  console.log('PASS A2: newest-first feed also selects the correct closed candle')
}

// ── Test B — same closed candle requested repeatedly → identical selection
{
  const candles = makeCandles(lastOpen)
  const s1 = selectLatestClosedCandle(candles, FIVE_MIN, now, 'B1:test')
  const s2 = selectLatestClosedCandle(candles, FIVE_MIN, now + 5_000, 'B1:test')  // same feed, seconds later
  assert.equal(s1.closedCloseTime, s2.closedCloseTime, 'B: same candle → same close identity')
  assert.equal(s1.closedOpenTime, s2.closedOpenTime)
  console.log('PASS B: repeated evaluation of the same candle keeps one identity')
}

// ── Test C — next candle closes (feed advanced) → selection advances
{
  const oldCandles = makeCandles(lastOpen)                     // feed before the close
  const newCandles = makeCandles(lastOpen + FIVE_MIN)          // feed after: new bar just closed
  const sOld = selectLatestClosedCandle(oldCandles, FIVE_MIN, now, 'C:test')
  const afterNewClose = lastOpen + FIVE_MIN + 30_000
  const sAfter = selectLatestClosedCandle(newCandles, FIVE_MIN, afterNewClose, 'C:test')
  assert.notEqual(sAfter.closedCloseTime, sOld.closedCloseTime, 'C: candle advances after the next close')
  assert.equal(sAfter.closedCloseTime, new Date(lastOpen + FIVE_MIN).toISOString())
  console.log('PASS C: selection advances when the next candle closes')
}

// ── Test D — no valid closed candle → none=true
{
  // Feed just started: a single in-progress candle with no completed history.
  const candles = [{ time: new Date(now - 30_000).toISOString(), open: 1.2, high: 1.21, low: 1.19, close: 1.205, volume: 100 }]
  const sel = selectLatestClosedCandle(candles, FIVE_MIN, now, 'D:test')
  assert.equal(sel.none, true)
  assert.equal(sel.closedCount, 0)
  console.log('PASS D: no closed candle → none=true (signal gate will return candle_open)')
}

// ── Test E — broker offset +3h (times stamped 3h ahead of UTC server clock)
{
  const brokerOpen = lastOpen + 3 * 3600_000          // broker frame = UTC+3
  const candles = makeCandles(brokerOpen)
  const sel = selectLatestClosedCandle(candles, FIVE_MIN, now, 'E:test')
  assert.equal(sel.none, false, 'E: offset +3h must not produce a false no-closed-candle')
  assert.equal(sel.formingPresent, true, 'E: newest +3h bar still forming in UTC')
  assert.equal(sel.closedCloseTime, new Date(brokerOpen - FIVE_MIN + FIVE_MIN).toISOString(),
    'E: closed candle close = the +3h-frame boundary that ended')
  const health = evaluateMarketHealth(candles, FIVE_MIN, now, { pair: 'XAU/E', timeframe: '5m' })
  assert.equal(health.status, 'HEALTHY', 'E: market health healthy with +3h broker offset')
  assert.equal(Math.round(health.brokerOffsetSec / 3600), 3, 'E: inferred offset ≈ +3h')
  console.log('PASS E: broker +3h calibration selects the correct closed candle (HEALTHY)')
}

// ── Test H — the forming bar never enters the closed slice (no lookahead)
{
  const candles = makeCandles(lastOpen)
  const sel = selectLatestClosedCandle(candles, FIVE_MIN, now, 'H:test')
  assert.equal(sel.closedCloseTime, new Date(lastOpen).toISOString(),
    'H: closed close == forming-open boundary, NOT forming-open + span')
  // The data set the tick route feeds indicators is candles[0..closedCount);
  // the forming bar index is closedCount and must never be included.
  const closedSlice = candles.slice(0, sel.closedCount)
  assert.ok(!closedSlice.some(c => new Date(c.time).getTime() === lastOpen),
    'H: forming bar (opened lastOpen) must not be in the closed data set')
  assert.equal(closedSlice[closedSlice.length - 1].time, new Date(lastOpen - FIVE_MIN).toISOString())
  console.log('PASS H: forming candle excluded from the closed indicator data set')
}

// ── Test F — stale feed → dataSuspended=true (signal generation blocked)
{
  const STALE = 30 * 60_000
  const candles = makeCandles(lastOpen - STALE)   // last bar closed 30 min ago
  const health = evaluateMarketHealth(candles, FIVE_MIN, now, { pair: 'XAU/F', timeframe: '5m' })
  assert.equal(health.status, 'STALE_FEED')
  assert.equal(health.dataSuspended, true, 'F: stale feed must suspend signal generation')
  console.log('PASS F: STALE_FEED suspends signal generation')
}

// ── Test G — time error → dataSuspended=true (signal generation blocked)
{
  // Normal aligned feed (offset 0) plus one rogue candle stamped 90 minutes in
  // the future — a real clock/EA failure mode. The watchdog must refuse to
  // generate rather than silently trusting the inconsistent feed.
  const candles = makeCandles(lastOpen)
  candles.push({ time: new Date(lastOpen + FIVE_MIN + 90 * 60_000).toISOString(), open: 1.2, high: 1.21, low: 1.19, close: 1.205, volume: 100 })
  const health = evaluateMarketHealth(candles, FIVE_MIN, now, { pair: 'XAU/G', timeframe: '5m' })
  assert.equal(health.status, 'TIME_ERROR')
  assert.equal(health.dataSuspended, true, 'G: clock error must suspend signal generation')
  console.log('PASS G: TIME_ERROR suspends signal generation')
}

// ── Market health is NOT damaged by a forming candle (distinct concepts)
{
  const candles = makeCandles(lastOpen)
  const health = evaluateMarketHealth(candles, FIVE_MIN, now, { pair: 'XAU/H', timeframe: '5m' })
  assert.equal(health.status, 'HEALTHY')
  assert.equal(health.dataSuspended, false)
  console.log('PASS : forming candle is healthy market data (FORMING ≠ data failure)')
}

console.log('\nAll closed-candle tests passed.')
