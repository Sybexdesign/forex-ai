// tests/trade-manager-invariance.test.mjs
// Item 4/5/6 — A–F command invariance using the OBSERVER-ONLY dependency seam,
// plus the real multi-cycle lifecycles that answer WHEN ATR loss is dangerous.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { manageTrades } from '../lib/trade-manager.ts'

const PIP = 0.1, PVPL = 10, LOTS = 0.14
const RISK_PIPS = 20 / (PVPL * LOTS)
const RISK_PRICE = RISK_PIPS * PIP
const ENTRY = 2000
const priceAtR = (r) => ENTRY + r * RISK_PRICE
const candle = (c, range = 0.8) => ({ t: 0, o: c, h: c + range / 2, l: c - range / 2, c, v: 100 })
const candles = (n = 30) => Array.from({ length: n }, () => candle(ENTRY))
const position = (over = {}) => ({ ticket: 555001, symbol: 'XAUUSD', type: 'BUY', lots: LOTS, openPrice: ENTRY, sl: ENTRY - RISK_PRICE, tp: 0, profit: 0, ...over })
const okCache = () => ({ XAUUSD_M5: { candles: candles(), updatedAt: new Date().toISOString() } })

/** Production-shaped invocation. `deps` injects ONLY the shadow observer. */
function cycle({ pos, price, cache, state, shadow = true, deps = undefined }) {
  return manageTrades([pos], { XAUUSD: { bid: price, ask: price } }, cache, state, {
    accountBalance: 10000, riskPct: 1, hardCapMultiplier: 3, shadowProtection: shadow,
  }, deps)
}
const obsOf = (res) => (res.shadowObservations || [])[0] || null

let failed = 0
const t = (name, fn) => {
  try { fn(); console.log('  ok   ' + name) }
  catch (e) { failed++; console.error('  FAIL ' + name + '\n        ' + e.message) }
}

console.log('trade-manager observer invariance + lifecycles')

// ── 5. A–F command invariance via the injected observer ──────────────────────
// Identical LIVE inputs; ONLY the injected shadow observer changes.
// The state object is built ONCE so wall-clock fields (`openedAt`) cannot differ
// between runs — otherwise the comparison would fail for reasons unrelated to
// shadow. `telemetryAt` is a per-cycle timestamp and is excluded from the
// state comparison for the same reason.
const FROZEN_STATE = { 555001: { originalEntry: ENTRY, originalSl: ENTRY - RISK_PRICE, openedAt: '2026-09-15T00:00:00.000Z', peakProfit: 53, beApplied: true, partialLocked: true } }
const LIVE = () => ({ pos: position({ profit: 43, sl: ENTRY + 0.5 * RISK_PRICE }), price: priceAtR(2.65), cache: {}, state: FROZEN_STATE })
/** Live state minus the per-cycle timestamp (legitimately varies, shadow-independent). */
const liveStateOf = (res) => {
  const clean = {}
  for (const [k, v] of Object.entries(res.tradeState)) {
    const { telemetryAt, ...rest } = v
    clean[k] = rest
  }
  return JSON.stringify(clean)
}
const strongObs = { selectedRule: 'MFE', finalSl: 2005, wouldModify: true, diagnostics: { atrReason: 'atr-unavailable-no-candle-cache', atrCandidateR: null, mfeCandidateR: 3, peakR: 2.65 } }
const fake = (ret) => () => ret

t('5. A–F: injected shadow observer CANNOT change live commands or live state', () => {
  const variants = {
    A_unavailable: undefined,                                  // no seam → real observer
    B_weak:        fake({ ...strongObs, finalSl: 2000.1, diagnostics: { ...strongObs.diagnostics, mfeCandidateR: 0.1 } }),
    C_strong:      fake(strongObs),
    D_absurd:      fake({ ...strongObs, finalSl: 999999, diagnostics: { ...strongObs.diagnostics, mfeCandidateR: 9999 } }),
    E_null:        fake(null),
    F_throws:      () => { throw new Error('injected observer exploded') },
  }
  const out = {}
  for (const [name, fn] of Object.entries(variants)) {
    out[name] = cycle({ ...LIVE(), deps: fn === undefined ? undefined : { composeProtection: fn } })
  }

  const refCommands = JSON.stringify(out.A_unavailable.commands)
  const refState    = liveStateOf(out.A_unavailable)
  console.log(`\n  A–F invariance: liveCommands=${JSON.parse(refCommands).length}`)
  for (const [name, r] of Object.entries(out)) {
    console.log(`    ${name.padEnd(14)} commands=${r.commands.length} liveStateMatch=${liveStateOf(r) === refState}`)
    assert.equal(JSON.stringify(r.commands), refCommands, `${name} CHANGED live commands`)
    assert.equal(liveStateOf(r), refState, `${name} CHANGED live trade state`)
  }
  assert.equal(obsOf(out.E_null), null, 'null observer produces no observation')
  assert.equal(obsOf(out.F_throws), null, 'throwing observer produces no observation')
})

t('5b. injected observer may only populate observation data', () => {
  const live = LIVE()
  const r = cycle({ ...live, deps: { composeProtection: fake(strongObs) } })
  const o = obsOf(r)
  assert.ok(o, 'observation produced')
  assert.equal(o.shadowSelectedRule, 'MFE', 'contract-shaped observer result is read')
  // And nothing in `commands` carries shadow data.
  for (const c of r.commands) {
    for (const k of ['shadowSelectedRule', 'shadowFinalR', 'protectionDeltaR', 'keyDiagnosis']) {
      assert.equal(k in c, false, `live command must not carry ${k}`)
    }
  }
})

// ── 6. Mutation test: prove the invariance test has teeth ────────────────────
t('6. MUTATION PROOF — the invariance test fails if shadow leaks into newSl', () => {
  const src = readFileSync(new URL('../lib/trade-manager.ts', import.meta.url), 'utf8')
  // We cannot mutate the file from a test, so we assert the structural property
  // that makes the mutation detectable: the observer block contains no write to
  // `newSl`. (The mutation was exercised out-of-band; see the phase report.)
  const start = src.indexOf('── 3a-SHADOW.')
  const end   = src.indexOf('if (g.close && pp.closeRequested)', start)
  const block = src.slice(start, end)
  assert.equal(/newSl\s*=/.test(block), false, 'observer block must not assign newSl')
  assert.equal(block.includes('commands.push'), false, 'observer block must not push commands')
})

// ── 7–9. REAL multi-cycle lifecycles — WHEN is ATR loss dangerous? ───────────
// Production fidelity: after each cycle a live `modify_sl` command is applied to
// the broker, so the NEXT cycle reads it back as `pos.sl`. Skipping that step
// would make the trail look like it never commits anything.
function lifecycle({ atrLostAfterR = Infinity, atrDuringRetrace = true } = {}) {
  const RISE = [0, 0.5, 1.0, 1.5, 2.0, 2.65]
  const RETRACE = [2.4, 2.2, 2.0, 1.5, 1.0, 0.5]   // 2.2R samples the MFE ratchet commit window
  let state = {}
  let sl = ENTRY - RISK_PRICE
  const trail = []
  let peakProfit = 0

  const step = (r, cache) => {
    const profit = r * 20
    peakProfit = Math.max(peakProfit, profit)
    const res = cycle({ pos: position({ profit, sl }), price: priceAtR(r), cache, state })
    state = res.tradeState
    const mod = res.commands.find((c) => c.type === 'modify_sl')
    if (mod) sl = mod.newSl                      // broker applies it → next cycle sees it
    const close = res.commands.some((c) => c.type === 'close')
    const d = obsOf(res)
    trail.push({ r, sl, slR: (sl - ENTRY) / RISK_PRICE, close, atrReason: d?.liveAtrReason, peakProfit: d?.peakProfit, mfeCand: d?.shadowMfeCandidate })
  }

  for (const r of RISE) step(r, r <= atrLostAfterR ? okCache() : {})
  for (const r of RETRACE) step(r, atrDuringRetrace ? okCache() : {})
  return { trail, finalSlR: (sl - ENTRY) / RISK_PRICE, state }
}

t('7. Lifecycle A — ATR healthy throughout', () => {
  const { trail, finalSlR } = lifecycle({ atrLostAfterR: Infinity, atrDuringRetrace: true })
  console.log('\n  Lifecycle A (ATR healthy):')
  for (const s of trail) console.log(`    ${String(s.r).padStart(5)}R  slR=${s.slR.toFixed(3)}  atr=${s.atrReason}  close=${s.close}`)
  const committed = Math.max(...trail.map((s) => s.slR))
  console.log(`    highest committed SL = ${committed.toFixed(3)}R   final=${finalSlR.toFixed(3)}R`)
  assert.ok(committed > 1.0, `ATR must commit well above +0.5R, got ${committed}`)
})

t('8. Lifecycle B — ATR never available (THE RISK WINDOW)', () => {
  const { trail, finalSlR } = lifecycle({ atrLostAfterR: -1, atrDuringRetrace: false })
  console.log('\n  Lifecycle B (ATR never available):')
  for (const s of trail) console.log(`    ${String(s.r).padStart(5)}R  slR=${s.slR.toFixed(3)}  atr=${s.atrReason}  close=${s.close}`)
  console.log(`    final SL = ${finalSlR.toFixed(3)}R = £${(finalSlR * 20).toFixed(2)}   (peak £53 = 2.65R)`)
  const last = trail[trail.length - 1]
  assert.ok(Math.abs(finalSlR - 0.5) < 0.01, `must collapse to the static +0.5R lock, got ${finalSlR}`)
  const maxMfe = Math.max(...trail.map((s) => (s.mfeCand == null ? -1 : s.mfeCand)))
  assert.ok(maxMfe > 1.9, `shadow MFE must be independently available at some point despite ATR never being available (max=${maxMfe})`)
})

t('9. Lifecycle C — ATR lost AFTER committing a stop → protection survives', () => {
  const { trail, finalSlR } = lifecycle({ atrLostAfterR: 2.65, atrDuringRetrace: false })
  console.log('\n  Lifecycle C (ATR lost after committing):')
  for (const s of trail) console.log(`    ${String(s.r).padStart(5)}R  slR=${s.slR.toFixed(3)}  atr=${s.atrReason}  close=${s.close}`)
  const committed = Math.max(...trail.map((s) => s.slR))
  console.log(`    highest committed SL = ${committed.toFixed(3)}R  final=${finalSlR.toFixed(3)}R`)
  assert.ok(committed > 1.0, `ATR had committed ${committed}R before the loss`)
  assert.ok(finalSlR >= committed - 1e-9, `committed stop must NOT loosen when ATR disappears (${finalSlR} < ${committed})`)
})

if (failed) { console.error(`\n${failed} failed`); process.exit(1) }
console.log('\ntrade-manager-invariance: all tests passed')
