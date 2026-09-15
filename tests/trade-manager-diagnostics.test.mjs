// tests/trade-manager-diagnostics.test.mjs
// Observation-only diagnostics: restart lifecycles, gap detector, symbol
// diagnosis, protection-health classification, and logging isolation.
import assert from 'node:assert/strict'
import {
  manageTrades, detectProtectionGap, refineAtrReason, classifyProtectionHealth,
  GAP_MIN_DELTA_R, GAP_MIN_PROFIT_R, ATR_WARMUP_SEC, CANDLE_STALE_SEC,
} from '../lib/trade-manager.ts'

const PIP = 0.1, PVPL = 10, LOTS = 0.14
const RISK_PRICE = (20 / (PVPL * LOTS)) * PIP
const ENTRY = 2000
const priceAtR = (r) => ENTRY + r * RISK_PRICE
const candle = (c, t = 0) => ({ t, o: c, h: c + 0.4, l: c - 0.4, c, v: 100 })
const candles = (n = 30, t = 0) => Array.from({ length: n }, () => candle(ENTRY, t))
const position = (over = {}) => ({ ticket: 555001, symbol: 'XAUUSD', type: 'BUY', lots: LOTS, openPrice: ENTRY, sl: ENTRY - RISK_PRICE, tp: 0, profit: 0, ...over })
const okCache = (t = 0) => ({ XAUUSD_M5: { candles: candles(30, t), updatedAt: new Date().toISOString() } })

/** Production-shaped invocation. */
function cycle({ pos, price, cache, state }) {
  const res = manageTrades([pos], price == null ? {} : { XAUUSD: { bid: price, ask: price } }, cache, state, {
    accountBalance: 10000, riskPct: 1, hardCapMultiplier: 3, shadowProtection: true,
  })
  const mod = res.commands.find((c) => c.type === 'modify_sl')
  return { res, sl: mod ? mod.newSl : pos.sl, obs: (res.shadowObservations || [])[0] || null, state: res.tradeState }
}

let failed = 0
const t = (name, fn) => {
  try { fn(); console.log('  ok   ' + name) }
  catch (e) { failed++; console.error('  FAIL ' + name + '\n        ' + e.message) }
}

console.log('trade-manager diagnostics (observation only)')

const RISE = [0, 0.5, 1.0, 1.5, 2.0, 2.65]
const RETRACE = [2.4, 2.2, 2.0, 1.5, 1.0, 0.5]

/** Drive a lifecycle; persisted state + broker SL are carried, as production does. */
function drive({ startState = {}, startSl = ENTRY - RISK_PRICE, riseCache, retraceCache, retrace = RETRACE }) {
  let state = startState, sl = startSl
  const trail = []
  const step = (r, cache) => {
    const c = cycle({ pos: position({ profit: r * 20, sl }), price: priceAtR(r), cache, state })
    state = c.state; sl = c.sl
    trail.push({ r, slR: (sl - ENTRY) / RISK_PRICE, obs: c.obs, close: c.res.commands.some((x) => x.type === 'close') })
  }
  for (const r of RISE) step(r, riseCache(r))
  for (const r of retrace) step(r, retraceCache(r))
  return { state, sl, trail }
}

t('Restart A — ATR committed ~2R then restart with NO candles', () => {
  const p1 = drive({ riseCache: () => okCache(), retraceCache: () => okCache(), retrace: [] })
  const committed = Math.max(...p1.trail.map((s) => s.slR))
  // RESTART: only what production persists survives (state + broker SL).
  // candleCache/latestPrices are rebuilt from scratch → empty.
  const after = drive({ startState: p1.state, startSl: p1.sl, riseCache: () => ({}), retraceCache: () => ({}) })
  const finalR = after.trail[after.trail.length - 1].slR
  const lostAtrObs = after.trail.find((s) => s.obs?.liveAtrReason === 'live-atr-missing-candles')?.obs
  console.log(`\n  Restart A: committed ${committed.toFixed(3)}R → after restart+no-candles final ${finalR.toFixed(3)}R`)
  console.log(`     peakProfit survived=${lostAtrObs?.peakProfit} refined=${lostAtrObs?.atrRefinedReason} health=${lostAtrObs?.protectionHealth}`)
  assert.ok(committed > 2.0, `ATR must commit >2R, got ${committed}`)
  assert.ok(finalR >= committed - 1e-9, `protection must NOT fall back to +0.5R (got ${finalR})`)
  assert.equal(after.state['555001'].peakProfit, 53, 'persisted peak survives the restart')
  assert.equal(lostAtrObs?.liveAtrReason, 'live-atr-missing-candles', 'shadow identifies missing ATR')
})

t('Restart B — ATR never committed; restart; still unavailable → gap fires', () => {
  const b = drive({ riseCache: () => ({}), retraceCache: () => ({}) })
  const b2 = drive({ startState: b.state, startSl: b.sl, riseCache: () => ({}), retraceCache: () => ({}) })
  const finalR = b2.trail[b2.trail.length - 1].slR
  const gaps = b2.trail.map((s) => s.obs).filter(Boolean).map((o) => detectProtectionGap(o)).filter(Boolean)
  console.log(`\n  Restart B: final ${finalR.toFixed(3)}R (£${(finalR * 20).toFixed(2)}); gaps detected=${gaps.length}`)
  if (gaps[0]) console.log(`     gap: peakR=${gaps[0].peakR?.toFixed(2)} live=${gaps[0].liveFinalR} shadow=${gaps[0].shadowFinalR} delta=${gaps[0].protectionDeltaR} refined=${gaps[0].atrRefinedReason}`)
  assert.ok(Math.abs(finalR - 0.5) < 0.01, `must stay at the weak +0.5R floor, got ${finalR}`)
  assert.ok(gaps.length > 0, 'profit_protection_gap_detected must fire')
  assert.equal(gaps[0].severity, 'COUNTERFACTUAL_ONLY')
})

t('Restart C — candle recovery re-enables ATR, monotonically', () => {
  const b = drive({ riseCache: () => ({}), retraceCache: () => ({}) })
  const recovered = drive({ startState: b.state, startSl: b.sl, riseCache: () => okCache(), retraceCache: () => okCache() })
  const beforeR = b.trail[b.trail.length - 1].slR
  const atrAfter = recovered.trail.find((s) => s.obs?.liveAtrReason === 'live-atr-active')?.obs
  const finalR = recovered.trail[recovered.trail.length - 1].slR
  console.log(`\n  Restart C: before=${beforeR.toFixed(3)}R → recovered final=${finalR.toFixed(3)}R`)
  assert.equal(atrAfter?.liveAtrReason, 'live-atr-active', 'ATR becomes available again')
  assert.ok(finalR >= beforeR - 1e-9, 'recovery must not loosen protection')
})

// ── 2. Gap detector unit tests ───────────────────────────────────────────────
t('2. detectProtectionGap — fires / does-not-fire matrix', () => {
  const base = { timestamp: 'T', tradeId: 'x', symbolRaw: 'XAUUSD', currentR: 2.15, peakR: 2.65, liveFinalR: 0.497, shadowFinalR: 1.9875, protectionDeltaR: 1.49, liveAtrReason: 'live-atr-missing-candles' }
  assert.ok(detectProtectionGap(base), 'fires on a material ATR-outage gap')
  assert.equal(detectProtectionGap({ ...base, liveAtrReason: 'live-atr-active' }), null, 'no gap when ATR is healthy')
  assert.equal(detectProtectionGap({ ...base, protectionDeltaR: -0.4 }), null, 'no gap when live is stronger')
  assert.equal(detectProtectionGap({ ...base, currentR: GAP_MIN_PROFIT_R - 0.1 }), null, 'no gap below the profit bar')
  assert.equal(detectProtectionGap({ ...base, protectionDeltaR: GAP_MIN_DELTA_R - 0.01 }), null, 'no gap below the delta bar')
  assert.equal(detectProtectionGap(null), null)
  assert.equal(detectProtectionGap(undefined), null)
  assert.equal(detectProtectionGap({ ...base, shadowFinalR: NaN }), null)
  assert.equal(detectProtectionGap({ ...base, protectionDeltaR: NaN }), null)
  assert.ok(detectProtectionGap({ ...base, protectionDeltaR: 0.6 }, { minDeltaR: 0.5 }), 'configurable bar')
  assert.equal(detectProtectionGap({ ...base, protectionDeltaR: 0.6 }, { minDeltaR: 2 }), null)
  assert.equal(detectProtectionGap(base).severity, 'COUNTERFACTUAL_ONLY', 'telemetry-only marker')
})

// ── 3. Symbol / key diagnosis unit tests ─────────────────────────────────────
t('3. refineAtrReason — distinguishes the operational causes', () => {
  // CANONICAL bar: calcATR needs ATR_PERIOD + 1 = 15 candles for a full window.
  const REQUIRED = 15
  const common = { candleCount: 30, requiredCandles: REQUIRED, processUptimeSec: 9999 }
  assert.equal(refineAtrReason({ ...common, liveAtrReason: 'live-atr-active', candleKeyFound: true, priceKeyFound: true, keyDiagnosis: 'keys-ok' }), 'atr-available')
  assert.equal(refineAtrReason({ ...common, candleKeyFound: false, priceKeyFound: true, keyDiagnosis: 'key-mismatch-suspected', candleCount: 0 }), 'atr-symbol-key-mismatch')
  assert.equal(refineAtrReason({ ...common, candleKeyFound: true, priceKeyFound: false, keyDiagnosis: 'key-mismatch-suspected', candleCount: 0 }), 'atr-price-key-mismatch')
  assert.equal(refineAtrReason({ ...common, candleKeyFound: false, priceKeyFound: true, keyDiagnosis: 'candle-cache-empty-no-alternate', candleCount: 0 }), 'atr-cache-missing-no-alternate')
  assert.equal(refineAtrReason({ candleCount: 3, requiredCandles: REQUIRED, candleKeyFound: true, priceKeyFound: true, keyDiagnosis: 'keys-ok', processUptimeSec: ATR_WARMUP_SEC - 10 }), 'atr-cache-warming')
  assert.equal(refineAtrReason({ ...common, candleCount: 3, candleKeyFound: true, priceKeyFound: true, keyDiagnosis: 'keys-ok' }), 'atr-insufficient-candles')
  // Exactly at the canonical bar must be accepted (off-by-one guard).
  assert.equal(refineAtrReason({ ...common, candleCount: REQUIRED, candleKeyFound: true, priceKeyFound: true, keyDiagnosis: 'keys-ok' }), 'atr-unavailable-other',
    'ATR_PERIOD+1 candles is a FULL window, so it must not be reported as insufficient')
  assert.equal(refineAtrReason({ ...common, candleCount: REQUIRED - 1, candleKeyFound: true, priceKeyFound: true, keyDiagnosis: 'keys-ok' }), 'atr-insufficient-candles')
  assert.equal(refineAtrReason({ ...common, candleKeyFound: true, priceKeyFound: true, keyDiagnosis: 'keys-ok', candleAgeSec: CANDLE_STALE_SEC + 1 }), 'atr-stale-candles')
  assert.equal(refineAtrReason({ ...common, liveAtrReason: 'live-atr-below-profit-gate', candleKeyFound: true, priceKeyFound: true, keyDiagnosis: 'keys-ok' }), 'atr-available-below-progress-gate')
})

// ── 7. Protection-health classification ──────────────────────────────────────
t('7. classifyProtectionHealth — aggregate label per trade', () => {
  assert.equal(classifyProtectionHealth(null), 'NO_OBSERVATION')
  assert.equal(classifyProtectionHealth({ liveAtrReason: 'live-atr-active' }), 'HEALTHY_ATR')
  assert.equal(classifyProtectionHealth({ liveAtrReason: 'live-atr-missing-candles', liveFinalR: 2.37, protectionDeltaR: -0.4, currentR: 2.15 }), 'HEALTHY_EXISTING_SL')
  assert.equal(classifyProtectionHealth({ liveAtrReason: 'live-atr-missing-candles', liveFinalR: 0.497, shadowFinalR: 1.99, protectionDeltaR: 1.49, currentR: 2.15, atrRefinedReason: 'atr-cache-missing-no-alternate' }), 'PROTECTION_GAP')
  assert.equal(classifyProtectionHealth({ liveAtrReason: 'live-atr-missing-candles', liveFinalR: 0.497, protectionDeltaR: 0, currentR: 2.15, atrRefinedReason: 'atr-cache-warming' }), 'ATR_WARMING')
  assert.equal(classifyProtectionHealth({ liveAtrReason: 'live-atr-missing-candles', liveFinalR: 0.497, protectionDeltaR: 0, currentR: 2.15, atrRefinedReason: 'atr-symbol-key-mismatch' }), 'ATR_KEY_MISMATCH_SUSPECTED')
  assert.equal(classifyProtectionHealth({ liveAtrReason: 'live-atr-missing-candles', liveFinalR: 0.497, protectionDeltaR: 0, currentR: 2.15, atrRefinedReason: 'atr-stale-candles' }), 'ATR_STALE')
})

// ── 4. Logging isolation (serialisation boundary) ────────────────────────────
t('4. logging/serialisation cannot affect commands or state', () => {
  const c = cycle({ pos: position({ profit: 43, sl: ENTRY + 0.5 * RISK_PRICE }), price: priceAtR(2.65), cache: {}, state: {} })
  const before = JSON.stringify(c.res.commands)
  try { JSON.stringify(c.obs) } catch { /* any consumer failure is outside trading */ }
  assert.equal(JSON.stringify(c.res.commands), before, 'commands unaffected by serialisation')
  assert.ok(c.res.tradeState, 'state returned regardless')
  assert.doesNotThrow(() => JSON.stringify(c.obs), 'observation always serialises (no cycles/functions)')
})

if (failed) { console.error(`\n${failed} failed`); process.exit(1) }
console.log('\ntrade-manager-diagnostics: all tests passed')

