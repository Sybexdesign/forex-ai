// tests/tick-resilience.test.mjs
// ── TICK ENDPOINT RESILIENCE (production 500 regression) ────────────────────
//
// INCIDENT: /api/scalper/tick returned HTTP 500 with an EMPTY body. The signal
// card showed "tick 500" and the worker's fetchTick threw.
//
// ROOT CAUSE (proven): lib/indicators.ts enforces
//
//     if (candles.length < 60) throw new Error(`Need at least 60 candles, got ${n}`)
//
// and the tick route sliced its indicator input down to the CLOSED-bar count and
// called calculateIndicators() with NO minimum-bars guard and NO try/catch. Any
// feed that yields a closed set between 1 and 59 bars — which the account-neutral
// fallback feeds can — therefore crashed the route instead of refusing.
//
// SECOND DEFECT: the market-data ladder ended in an UNGUARDED Simulation import,
// so getMarketCandles()/getMarketPrices() could throw out of the module entirely.
//
// These tests pin the guards. They are source-level because both files sit behind
// `require('technicalindicators')` and a Next route boundary, so they cannot be
// imported from a plain node test — but they assert ORDER as well as presence, so
// a guard that survives but no longer runs before the call still fails.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

let failed = 0
const tests = []
const t = (name, fn) => tests.push([name, fn])

const ROUTE = new URL('../app/api/scalper/tick/route.ts', import.meta.url)
const INDIC = new URL('../lib/indicators.ts', import.meta.url)
const MD    = new URL('../lib/marketdata.ts', import.meta.url)

console.log('tick endpoint — resilience / no empty 500')

t('PREMISE: the indicator layer really does throw below 60 bars', () => {
  const src = readFileSync(INDIC, 'utf8')
  assert.ok(/throw new Error\(`Need at least 60 candles, got \$\{candles\.length\}`\)/.test(src),
    'if this guard ever disappears, re-derive MIN_INDICATOR_BARS')
})

t('the tick route guards the indicator input BEFORE calling calculateIndicators', () => {
  const src = readFileSync(ROUTE, 'utf8')
  assert.ok(/const MIN_INDICATOR_BARS = 60/.test(src), 'the minimum is declared and matches the indicator guard')

  const guardAt = src.indexOf('if (data.length < MIN_INDICATOR_BARS)')
  const callAt  = src.indexOf('const ind = calculateIndicators(data)')
  assert.ok(guardAt > 0, 'a minimum-bars guard exists')
  assert.ok(callAt  > 0, 'calculateIndicators is still called')
  assert.ok(guardAt < callAt,
    'the guard must run BEFORE calculateIndicators — a guard placed after it is dead code')
})

t('the short-feed refusal is fail-closed and diagnosable', () => {
  const src = readFileSync(ROUTE, 'utf8')
  const block = src.slice(src.indexOf('if (data.length < MIN_INDICATOR_BARS)'), src.indexOf('const ind = calculateIndicators(data)'))
  assert.ok(/dataSuspended:\s*true/.test(block),
    'dataSuspended=true so /api/scalper/signal refuses to generate from a short feed')
  assert.ok(/status: 503/.test(block), 'a non-2xx status keeps the worker fail-closed (apiFetch throws)')
  assert.ok(/rawCandles/.test(block) && /closedCount/.test(block) && /source/.test(block),
    'the refusal reports which feed and how many bars, so the cause is diagnosable')
  assert.ok(!/candles\.slice\(0, candles\.length\)/.test(block), 'no padding of the input')
  assert.ok(!/data\s*=\s*candles\b(?!\.slice)/.test(block),
    'the forming bar must never be added back to reach the minimum (lookahead)')
})

t('no path in the tick route can produce a bare empty 500', () => {
  const src = readFileSync(ROUTE, 'utf8')
  assert.ok(/export async function GET\(req: NextRequest\) \{\s*try \{[\s\S]*?return await handleTick\(req\)/.test(src),
    'GET wraps the handler in try/catch')
  assert.ok(/catch \(e\) \{[\s\S]*?error: 'tick-failed'[\s\S]*?status: 500/.test(src),
    'an unexpected error returns a JSON body, not an empty response')
})

t('the market-data ladder cannot throw out of the module', () => {
  const src = readFileSync(MD, 'utf8')
  const sims = [...src.matchAll(/await import\('\.\/brokers\/simulation\.adapter'\)/g)].map((m) => m.index)
  assert.equal(sims.length, 2, 'expected two Simulation fallbacks (candles + prices)')
  for (const at of sims) {
    const before = src.slice(Math.max(0, at - 400), at)
    assert.ok(/try \{[\s\S]{0,300}$/.test(before),
      'each Simulation fallback must sit inside a try block — it is the end of the ladder')
  }
  assert.ok((src.match(/source: 'Unavailable'/g) || []).length === 2,
    'both ladders degrade to an explicit Unavailable result instead of throwing')
})

// ── runner ────────────────────────────────────────────────────────────────
for (const [name, fn] of tests) {
  try { await fn(); console.log(`  ✓ ${name}`) }
  catch (e) { failed++; console.error(`  ✗ ${name}\n      ${e?.message}`) }
}
console.log(`\n${tests.length - failed}/${tests.length} passed`)
process.exit(failed ? 1 : 0)
