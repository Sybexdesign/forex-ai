// tests/trade-manager-shadow.test.mjs
// REAL `manageTrades()` integration + shadow command-invariance.
//
// RUN VIA:  node --import ./scripts/test-ts-register.mjs tests/trade-manager-shadow.test.mjs
// (the --import hook resolves the project's `@/*` alias and extensionless
//  relative imports so Node executes the REAL TypeScript, not a copy)
//
// NOTHING here changes live behaviour. These tests prove the shadow observer
// cannot influence the commands the production function returns.
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { manageTrades } from '../lib/trade-manager.ts'

const PIP = 0.1, PVPL = 10, LOTS = 0.14
const RISK_PIPS = 20 / (PVPL * LOTS)            // £20 planned risk
const RISK_PRICE = RISK_PIPS * PIP              // ≈1.4286 price = 1R
const ENTRY = 2000
const priceAtR = (r) => ENTRY + r * RISK_PRICE

/** EACandle needs h/l/c; a flat body with a fixed range yields a stable ATR. */
const candle = (c, range = 0.8) => ({ t: 0, o: c, h: c + range / 2, l: c - range / 2, c, v: 100 })
const candles = (n = 30, price = ENTRY) => Array.from({ length: n }, () => candle(price))

const position = (over = {}) => ({
  ticket: 555001, symbol: 'XAUUSD', type: 'BUY', lots: LOTS,
  openPrice: ENTRY, sl: ENTRY - RISK_PRICE, tp: 0, profit: 0, ...over,
})

function run({ pos = position(), price = ENTRY, cache = null, state = {}, shadow = true } = {}) {
  const latestPrices = price == null ? {} : { [pos.symbol]: { bid: price, ask: price } }
  const candleCache = cache === null
    ? { [`${pos.symbol}_M5`]: { candles: candles(), updatedAt: new Date().toISOString() } }
    : cache
  return manageTrades([pos], latestPrices, candleCache, state, {
    accountBalance: 10000, riskPct: 1, hardCapMultiplier: 3, shadowProtection: shadow,
  })
}
const obs = (res) => (res.shadowObservations || [])[0] || null

let failed = 0
const t = (name, fn) => {
  try { fn(); console.log('  ok   ' + name) }
  catch (e) { failed++; console.error('  FAIL ' + name + '\n        ' + e.message) }
}

console.log('trade-manager SHADOW integration (real manageTrades)')
console.log('---')

// ── 1. The real function executes ────────────────────────────────────────────
t('1. manageTrades() is the REAL production export and runs', () => {
  assert.equal(typeof manageTrades, 'function')
  const res = run({ price: priceAtR(2.65), pos: position({ profit: 53 }) })
  assert.ok(Array.isArray(res.commands), 'returns commands')
  assert.ok(res.tradeState, 'returns tradeState')
  assert.ok(Array.isArray(res.shadowObservations), 'returns shadowObservations')
  assert.equal(res.shadowObservations.length, 1, 'one observation for one profitable position')
})

// ── 2. Healthy ATR participates ──────────────────────────────────────────────
t('2. healthy ATR → candidate captured, peakR ≈ 2.65', () => {
  const res = run({ price: priceAtR(2.65), pos: position({ profit: 53 }) })
  const d = obs(res)
  console.log(`  A (healthy ATR): liveAtrReason=${d.liveAtrReason} liveAtr=${d.liveAtr} liveAtrCandidate=${d.liveAtrCandidate?.toFixed(4)}`)
  console.log(`     liveFinal=${d.liveFinalCandidate?.toFixed(4)} (${d.liveFinalR?.toFixed(3)}R) liveModify=${d.liveModify}`)
  console.log(`     shadow: atrCand=${d.shadowAtrCandidate?.toFixed(3)}R mfeCand=${d.shadowMfeCandidate?.toFixed(3)}R rule=${d.shadowSelectedRule} finalR=${d.shadowFinalR?.toFixed(3)} deltaR=${d.protectionDeltaR}`)
  console.log(`     plannedRisk=${d.plannedRisk?.toFixed(3)} (${
    d.plannedRiskSource}) peakProfit=${d.peakProfit}`)
  const atrOk = Math.abs(d.liveAtr - 0.8) < 1e-9
  assert.ok(atrOk, `ATR from flat candles (range 0.8), got ${d.liveAtr}`)
  assert.ok(d.liveAtrCandidate !== null, 'the live ATR candidate must be captured')
  assert.ok(d.peakR > 2.5 && d.peakR < 2.8, `peakR ≈ 2.65, got ${d.peakR}`)
  assert.equal(d.plannedRiskSource, 'reconstructed-from-initial-sl')
})

// ── 3 + 4. Missing candles / missing price — the £53 core fixture ────────────
// PEAK-THEN-RETRACE, represented faithfully:
//   * `profitProtection()` returns at its `cur >= peak` guard while a trade makes
//     new highs, so an at-peak snapshot proves nothing — the peak is carried in
//     PERSISTED state (£53) and the current profit is retraced to £43.
//   * A trade that peaked at 2.65R has ALREADY had the 1.5R partial lock fire, so
//     the live SL sits at +0.5R. Leaving `pos.sl` at the original stop while
//     claiming `partialLocked: true` would be a self-contradictory fixture (it
//     reported −1R, which no real lifecycle could produce).
const LOCKED_SL = ENTRY + 0.5 * RISK_PRICE     // the +0.5R partial-lock stop
const PEAK_STATE = {
  555001: {
    originalEntry: ENTRY, originalSl: ENTRY - RISK_PRICE, openedAt: new Date().toISOString(),
    peakProfit: 53, beApplied: true, partialLocked: true,
  },
}
const retracedPosition = (over = {}) => position({ profit: 43, sl: LOCKED_SL, ...over })

t('3. missing candle cache → live ATR skipped → LIVE FINAL = +0.5R (≈£10), MFE still available', () => {
  const res = run({ price: priceAtR(2.65), pos: retracedPosition(), cache: {}, state: PEAK_STATE })
  const d = obs(res)
  console.log(`  B (no candles, peak £53, retraced to £43, partial lock already at +0.5R):`)
  console.log(`     liveAtrReason=${d.liveAtrReason} liveAtr=${d.liveAtr} liveAtrCandidate=${d.liveAtrCandidate}`)
  console.log(`     LIVE FINAL = ${d.liveFinalCandidate?.toFixed(4)}  (${d.liveFinalR?.toFixed(3)}R)  = £${(d.liveFinalR * 20).toFixed(2)}   liveModify=${d.liveModify}`)
  console.log(`     shadow: atrReason=${d.shadowAtrReason} atrCand=${d.shadowAtrCandidate} mfeCand=${d.shadowMfeCandidate?.toFixed(3)}R rule=${d.shadowSelectedRule} finalR=${d.shadowFinalR?.toFixed(3)}`)
  console.log(`     deltaR=${d.protectionDeltaR}  peakR=${d.peakR?.toFixed(3)}  retention=${d.retentionTargetPct}`)
  assert.equal(d.liveAtrReason, 'live-atr-missing-candles')
  assert.equal(d.liveAtr, null)
  assert.equal(d.liveAtrCandidate, null)
  assert.equal(d.candleKeyFound, false)
  // THE CORE £53→£10 MECHANISM, from the REAL function:
  assert.ok(Math.abs(d.liveFinalR - 0.5) < 1e-6, `live final must be the static +0.5R lock, got ${d.liveFinalR}`)
  // And the shadow must NOT be limited to that floor.
  assert.ok(d.shadowMfeCandidate !== null, 'shadow MFE must remain independently available without ATR')
  assert.ok(d.shadowMfeCandidate > 1.9, `shadow MFE ≈1.9875R, got ${d.shadowMfeCandidate}`)
  assert.equal(d.shadowAtrCandidate, null, 'no ATR candidate may be fabricated')
  assert.ok(d.protectionDeltaR > 1.4, `shadow must protect materially more, delta=${d.protectionDeltaR}`)
  assert.equal(res.commands.filter((c) => c.type === 'close').length, 0, 'no adaptive close emitted')
})

t('4. missing price → live ATR disabled with an explicit reason', () => {
  const res = run({ price: null, pos: position({ profit: 43 }), state: PEAK_STATE })
  const d = obs(res)
  console.log(`  C (no price): liveAtrReason=${d.liveAtrReason} priceKeyFound=${d.priceKeyFound} currentPrice=${d.currentPrice} ATR=${d.liveAtr}`)
  assert.equal(d.priceKeyFound, false)
  // ATR is still COMPUTED from candles; it is the PRICE that is missing.
  assert.ok(d.liveAtr !== null)
  assert.equal(d.liveAtrReason, 'live-atr-missing-price')
  assert.equal(d.liveAtrCandidate, null, 'no ATR candidate without a price')
})

// ── 6. Symbol-key fixtures ───────────────────────────────────────────────────
function symCase(posSym, keySym) {
  const pos = position({ symbol: posSym, profit: 53 })
  const px = priceAtR(2.65)
  const latestPrices = { [keySym]: { bid: px, ask: px } }
  const candleCache = { [`${keySym}_M5`]: { candles: candles(), updatedAt: new Date().toISOString() } }
  const res = manageTrades([pos], latestPrices, candleCache, {}, {
    accountBalance: 10000, riskPct: 1, hardCapMultiplier: 3, shadowProtection: true,
  })
  return (res.shadowObservations || [])[0]
}

t('6. four symbol-key fixtures — raw vs normalized lookup', () => {
  const cases = [['XAUUSD', 'XAUUSD'], ['XAUUSD', 'XAU/USD'], ['XAU/USD', 'XAU/USD'], ['XAU/USD', 'XAUUSD']]
  console.log('\n  symbol fixtures (position symbol vs price/cache key):')
  console.log('  ' + 'posSym'.padEnd(9) + 'keySym'.padEnd(10) + 'norm'.padEnd(10) + 'priceFound'.padEnd(12) + 'candlesFound'.padEnd(14) + 'midPx'.padEnd(10) + 'ATR'.padEnd(7) + 'liveAtrReason')
  const out = []
  for (const [posSym, keySym] of cases) {
    const d = symCase(posSym, keySym)
    out.push({ posSym, keySym, d })
    console.log('  ' + String(posSym).padEnd(9) + String(keySym).padEnd(10) + String(d.symbolNormalized).padEnd(10)
      + String(d.priceKeyFound).padEnd(12) + String(d.candleKeyFound).padEnd(14)
      + String(d.currentPrice == null ? '-' : d.currentPrice).padEnd(10)
      + String(d.liveAtr == null ? '-' : d.liveAtr).padEnd(7) + d.liveAtrReason)
  }
  // F1/F3: the lookup key matches the raw symbol → everything found.
  assert.equal(out[0].d.priceKeyFound, true, 'F1 XAUUSD+XAUUSD must find price')
  assert.equal(out[0].d.candleKeyFound, true, 'F1 must find candles')
  assert.equal(out[2].d.priceKeyFound, true, 'F3 XAU/USD+XAU/USD must find price')
  assert.equal(out[2].d.candleKeyFound, true, 'F3 must find candles')
  // F2/F4: mismatch by construction → lookup MUST fail and be recorded.
  assert.equal(out[1].d.priceKeyFound, false, 'F2 XAUUSD+XAU/USD must record a MISS')
  assert.equal(out[3].d.priceKeyFound, false, 'F4 XAU/USD+XAUUSD must record a MISS')
  assert.equal(out[1].d.liveAtr, null, 'F2 must have no ATR')
  assert.equal(out[3].d.liveAtr, null, 'F4 must have no ATR')
})

// ── 13. SHADOW COMMAND INVARIANCE ────────────────────────────────────────────
// DESIGN NOTE (important): a variant-based invariance test (A–F "shadow proposes
// weak/strong/aggressive/nothing") is IMPOSSIBLE here without injecting the
// observer, because every input the shadow reads is ALSO a live input:
//   * `state.peakProfit` drives the live 3b ratchet (varying it moves `newSl`)
//   * `riskCtx.shadowProtection` IS the live/shadow gate for 3b
// Varying them therefore changes live commands legitimately, not by leakage.
// (Observed: D/E produced 1 command vs 0 for A/B/C — that is the live 3b gate,
//  not shadow influence. Asserting equality across those variants would be a
//  FALSE test.)
//
// What we CAN prove here without DI:
//   1. determinism — identical inputs always yield identical commands;
//   2. `commands` never reference the shadow output;
//   3. the shadow block performs no assignment into execution state.
// The mutation test (reported separately) is what gives this teeth: injecting
// `newSl = shadow.finalSl` makes the observation diverge and the suite fail.
t('13. identical inputs → identical live commands (determinism)', () => {
  const res1 = run({ price: priceAtR(2.65), pos: retracedPosition(), cache: {}, state: PEAK_STATE })
  const res2 = run({ price: priceAtR(2.65), pos: retracedPosition(), cache: {}, state: PEAK_STATE })
  assert.equal(JSON.stringify(res1.commands), JSON.stringify(res2.commands), 'commands must be deterministic')
  assert.equal(res1.commands.length, 0, 'and this fixture legitimately emits no live command')

  // The shadow observed the cycle even though nothing was commanded.
  const d = obs(res1)
  assert.ok(d, 'shadow observation still produced')
  assert.equal(d.shadowSelectedRule, 'MFE')
  assert.ok(d.shadowMfeCandidate > 1.9, 'shadow would protect ~1.99R')

  // `commands` must carry no shadow-derived field.
  for (const c of res1.commands) {
    for (const k of ['shadowSelectedRule', 'shadowFinalR', 'shadowFinalCandidate', 'protectionDeltaR']) {
      assert.equal(k in c, false, `a live command must not carry ${k}`)
    }
  }
})

t('13b. the shadow block performs no assignment into execution state (structural)', () => {
  const src = readFileSync(new URL('../lib/trade-manager.ts', import.meta.url), 'utf8')
  const start = src.indexOf('── 3a-SHADOW.')
  const end   = src.indexOf('if (g.close && pp.closeRequested)', start)
  assert.ok(start > 0 && end > start, 'shadow block located')
  const block = src.slice(start, end)
  // No writes to anything that feeds command emission.
  for (const banned of ['newSl =', 'commands.push', 'state.beApplied =', 'state.partialLocked =',
                        'state.protectionStage =', 'state.retentionFloorUsd =', 'nextState[']) {
    assert.equal(block.includes(banned), false, `shadow block must not contain \`${banned}\``)
  }
  assert.ok(block.includes('shadowObservations.push'), 'and it must only collect observations')
})


if (failed) { console.error(`\n${failed} failed`); process.exit(1) }
console.log('\ntrade-manager-shadow: all tests passed')


