// tests/profit-protection-activation.test.mjs
// ── PROFIT-PROTECTION ACTIVATION: THE WIRED RESOLVER ────────────────────────
//
// Phase 1 wires lib/profit-protection-mode.mjs into the real MT5 call site
// (app/api/mt5-sync/route.ts), replacing two flags that were ANDed together
// inline. These tests pin four things:
//
//   1. EVERY mode-resolution combination.
//   2. The SAFETY property: with the environment unset or invalid, live
//      protection CANNOT be activated — asserted exhaustively, not by example.
//   3. Exact behavioural equivalence with the PRE-CHANGE expression, with its two
//      deliberate deltas pinned by name so neither can change silently later.
//   4. EXECUTION: env → resolver → the REAL manageTrades() → no broker action.
//
// Nothing here changes thresholds, bands, ATR logic or stop placement. The only
// subject is WHICH mode is selected.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolveProfitProtectionMode, describeProfitProtectionMode, PP_MODES, PP_MODE_DEFAULT } from '../lib/profit-protection-mode.mjs'
import { manageTrades } from '../lib/trade-manager.ts'

let failed = 0
const t = (name, fn) => {
  try { fn(); console.log('  ok   ' + name) }
  catch (e) { failed++; console.error('  FAIL ' + name + '\n        ' + (e.stack || e.message).split('\n').slice(0, 4).join('\n        ')) }
}

// ── The PRE-CHANGE expression, preserved verbatim as an ORACLE ───────────────
// This is the exact code the call site ran before Phase 1. It exists here to
// prove the new resolver is behaviour-preserving (modulo two documented deltas),
// which is precisely what a refactor must demonstrate.
function preChangeShadowProtection(env) {
  const forceShadow = env.PROFIT_PROTECTION_SHADOW_MODE === 'true'
  return forceShadow || (env.PROFIT_PROTECTION_MODE || 'shadow') !== 'live'
}
/** Pre-change telemetry mode, same derivation the call site used. */
function preChangePptMode(env) {
  return preChangeShadowProtection(env) ? 'shadow' : 'live'
}
/** Post-change telemetry mode — the route's new mapping. */
const newPptMode = (env) => (resolveProfitProtectionMode(env).mode === 'live' ? 'live' : 'shadow')

const env = (mode, legacy) => {
  const e = {}
  if (mode   !== undefined) e.PROFIT_PROTECTION_MODE = mode
  if (legacy !== undefined) e.PROFIT_PROTECTION_SHADOW_MODE = legacy
  return e
}

// A deliberately hostile vocabulary — every plausible operator typo, casing
// mistake, padding, wrong-type value and unknown token.
const MODES = [
  undefined, '', 'shadow', 'live', 'off',
  'LIVE', 'Live', 'LIVE ', ' live ', 'live ', ' liv',
  'liv', 'livee', 'yes', 'true', '1', 'on', 'OFF', 'Off', ' shadow',
]
const LEGACIES = [
  undefined, '', 'true', 'false', 'TRUE', 'True', ' true ', 'yes', '1', 'false ',
]
// The full cross-product every resolution test iterates.
const MATRIX = MODES.flatMap((m) => LEGACIES.map((l) => [m, l]))


// ── 1. Every combination resolves to a value in the valid vocabulary ────────
t('1. every mode combination resolves to a valid, non-empty mode', () => {
  assert.deepEqual(PP_MODES, ['off', 'shadow', 'live'])
  assert.equal(PP_MODE_DEFAULT, 'shadow')
  for (const [m, l] of MATRIX) {
    const r = resolveProfitProtectionMode(env(m, l))
    assert.ok(PP_MODES.includes(r.mode), `mode "${r.mode}" from MODE=${m} LEGACY=${l} must be in vocabulary`)
    assert.equal(typeof r.shadowProtection, 'boolean')
    // shadow/live/off must be mutually exclusive and total.
    assert.equal([r.shadow, r.live, r.off].filter(Boolean).length, 1,
      `exactly one of shadow/live/off for MODE=${m} LEGACY=${l}`)
    // shadowProtection is the boolean the call site consumes.
    assert.equal(r.shadowProtection, r.mode !== 'live')
  }
  console.log(`     ${MATRIX.length} combinations checked (${MODES.length} modes × ${LEGACIES.length} legacy values)`)
})

// ── 2. THE SAFETY PROPERTY ──────────────────────────────────────────────────
t('2. UNSET environment → SHADOW, never live', () => {
  for (const e of [{}, env(undefined, undefined), env('', ''), env(undefined, ''), env('', undefined)]) {
    const r = resolveProfitProtectionMode(e)
    assert.equal(r.mode, 'shadow', `unset env must resolve to shadow, got ${r.mode}`)
    assert.equal(r.live, false, 'live must be false when unset')
    assert.equal(r.shadowProtection, true, 'shadowProtection must be true when unset')
    assert.equal(newPptMode(e), 'shadow', 'telemetry must record shadow when unset')
  }
})

t('2. INVALID value → SHADOW, never live', () => {
  // Anything not exactly the token `live` (case/whitespace insensitive) is invalid.
  // NB: 'OFF'/'Off' are deliberately NOT in this list — they normalise to the VALID
  // `off` mode, which is a hard stop, not an unrecognised value.
  const INVALID = ['liv', 'livee', 'yes', 'true', '1', 'on', 'LIVING', 'l-i-v-e', '0', 'null', 'undefined']
  for (const v of INVALID) {
    const r = resolveProfitProtectionMode(env(v, undefined))
    assert.notEqual(r.mode, 'live', `MODE="${v}" must NOT activate live`)
    assert.equal(r.shadowProtection, true, `MODE="${v}" must stay shadow`)
    assert.equal(newPptMode(env(v, undefined)), 'shadow', `MODE="${v}" must record shadow`)
    // An unrecognised token must always carry a diagnostic — never a silent downgrade.
    assert.ok(r.notes.length > 0, `MODE="${v}" must produce a diagnostic note`)
  }
})

t('2. `off` is a hard stop and can never be reported as live', () => {
  for (const l of LEGACIES) {
    const r = resolveProfitProtectionMode(env('off', l))
    assert.equal(r.mode, 'off', `MODE=off LEGACY=${l}`)
    assert.equal(r.live, false, 'off must never report live')
    assert.equal(r.shadowProtection, true, 'off must keep the call site in non-live behaviour')
    assert.equal(newPptMode(env('off', l)), 'shadow', 'off records as shadow (schema vocabulary is shadow|live)')
  }
})

t('2. live is reachable ONLY from the EXACT token `live`, and never with legacy force-shadow', () => {
  for (const [m, l] of MATRIX) {
    const r = resolveProfitProtectionMode(env(m, l))
    const modeIsExactlyLive = m === 'live'                       // exact: no padding, lowercase
    const legacyForcesShadow = l !== undefined && String(l).trim().toLowerCase() === 'true'
    const expectedLive = modeIsExactlyLive && !legacyForcesShadow
    assert.equal(r.mode === 'live', expectedLive,
      `MODE=${JSON.stringify(m)} LEGACY=${JSON.stringify(l)} → live should be ${expectedLive}`)
  }
  // Near-miss spellings are explicitly NOT live (fail closed).
  for (const near of ['LIVE', 'Live', 'live ', ' live ', 'lIvE']) {
    assert.notEqual(resolveProfitProtectionMode(env(near, undefined)).mode, 'live',
      `MODE=${JSON.stringify(near)} must not activate live`)
  }
})

t('2. an unset environment is the single most common state — assert it directly', () => {
  // The production default. Nothing configured anywhere.
  const r = resolveProfitProtectionMode({})
  assert.equal(r.source, 'default', 'must be attributed to the default')
  assert.equal(r.mode, PP_MODE_DEFAULT, 'must equal the documented safe default')
  assert.equal(describeProfitProtectionMode(r), 'profit-protection mode=shadow (source=default)')
})

// ── 3. BEHAVIOURAL EQUIVALENCE WITH THE PRE-CHANGE EXPRESSION ───────────────
// A refactor must prove it preserved behaviour. This compares the new resolver
// against the exact expression it replaced, over the whole matrix, and
// classifies every difference.
const IDENTICAL = []
const NARROWED  = []   // old=live  → new=shadow  (STRICTER: protection stays off)
const WIDENED   = []   // old=shadow → new=live    (WIDER: protection becomes active)
for (const [m, l] of MATRIX) {
  const e    = env(m, l)
  const oldV = preChangeShadowProtection(e)
  const newV = resolveProfitProtectionMode(e).shadowProtection
  if (oldV === newV)                    IDENTICAL.push([m, l])
  else if (oldV === false && newV === true)  NARROWED.push([m, l])
  else                                  WIDENED.push([m, l])
}

t('3. the delta from the pre-change expression is EXACTLY two known classes', () => {
  assert.equal(WIDENED.length + NARROWED.length + IDENTICAL.length, MATRIX.length)

  // (a) NARROWED — a legacy force-shadow variant now correctly beats MODE=live.
  //     Old code compared `=== 'true'` exactly, so SHADOW_MODE=TRUE was ignored
  //     and live won. New code honours the operator's legacy flag.
  const expectedNarrowed = ['TRUE', 'True', ' true '].map((l) => ['live', l])
  assert.deepEqual(
    NARROWED.map(([m, l]) => [m, l]).sort(),
    expectedNarrowed.sort(),
    'NARROWED must be exactly {MODE=live} × {TRUE, True, " true "}'
  )

  // (b) WIDENED MUST BE ZERO — this is the Phase-1 hardening contract. No input,
  //     however it is spelled, may newly arm live protection. The pre-change
  //     expression compared `!== 'live'` EXACTLY, so requiring the exact token
  //     restores historical behaviour rather than diverging from it.
  assert.equal(WIDENED.length, 0,
    `WIDENED must be 0. Offenders: ${JSON.stringify(WIDENED)}`)
  console.log(`     equivalence: ${IDENTICAL.length} identical, ${NARROWED.length} narrowed, ${WIDENED.length} widened`)
})

t('3. SAFETY: every difference moves LIVE → SHADOW/OFF; never SHADOW/OFF → LIVE', () => {
  // The directional contract, asserted directly rather than inferred.
  assert.deepEqual(WIDENED, [], 'no input may newly move toward LIVE')
  for (const [m, l] of NARROWED) {
    const e = env(m, l)
    assert.equal(preChangeShadowProtection(e), false, `old must have been LIVE for MODE=${m} LEGACY=${l}`)
    assert.equal(resolveProfitProtectionMode(e).shadowProtection, true, `new must be non-live for MODE=${m} LEGACY=${l}`)
  }
  // And nothing may become live that was not live before.
  for (const [m, l] of MATRIX) {
    const e = env(m, l)
    const oldLive = preChangeShadowProtection(e) === false
    const newLive = resolveProfitProtectionMode(e).mode === 'live'
    if (newLive) assert.ok(oldLive, `MODE=${m} LEGACY=${l} became live but was not live before`)
  }
})

t('3. STRICT OPT-IN: only the exact token `live` activates live', () => {
  // NB: 'liv e' is deliberately absent — an internal space is not a casing/padding
  // variant of `live`, so it is `invalid`, not `inexact`.
  const NEAR = ['LIVE', 'Live', 'lIvE', 'live ', ' live ', ' live', 'LIVE ', 'live\t', '\nlive ']
  for (const v of NEAR) {
    const r = resolveProfitProtectionMode(env(v, undefined))
    assert.notEqual(r.mode, 'live', `MODE=${JSON.stringify(v)} must NOT activate live`)
    assert.equal(r.mode, 'shadow', `MODE=${JSON.stringify(v)} must resolve to shadow`)
    assert.equal(r.source, 'inexact', `MODE=${JSON.stringify(v)} must be attributed to 'inexact'`)
    assert.equal(r.shadowProtection, true, `MODE=${JSON.stringify(v)} must stay non-live`)
    assert.ok(r.notes.length > 0, `MODE=${JSON.stringify(v)} must carry a diagnostic`)
    const note = r.notes.join(' ')
    assert.match(note, /exact lowercase "live"/, 'diagnostic must state the exact-token requirement')
    assert.match(note, /PROFIT_PROTECTION_MODE=live/, 'diagnostic must name the exact required value')
  }
  // …and the one exact spelling DOES activate, cleanly.
  const ok = resolveProfitProtectionMode(env('live', undefined))
  assert.equal(ok.mode, 'live')
  assert.equal(ok.source, 'env')
  assert.equal(ok.shadowProtection, false)
  assert.equal(ok.notes.length, 0, 'an exact, unambiguous live setting needs no diagnostic')
})

t('3. OFF and SHADOW are distinguishable in diagnostics', () => {
  const off = resolveProfitProtectionMode(env('off', undefined))
  const sh  = resolveProfitProtectionMode(env('shadow', undefined))
  assert.equal(off.mode, 'off')
  assert.equal(sh.mode, 'shadow')
  assert.notEqual(describeProfitProtectionMode(off), describeProfitProtectionMode(sh),
    'OFF must not be reported as SHADOW')
  assert.match(describeProfitProtectionMode(off), /mode=off/)
  assert.match(describeProfitProtectionMode(sh), /mode=shadow/)
  // Both keep execution non-live (the telemetry column may only store shadow|live).
  assert.equal(off.shadowProtection, true)
  assert.equal(sh.shadowProtection, true)
  // Tolerant parsing of `off` is preserved — it moves TOWARD safety.
  for (const v of ['OFF', 'Off', ' off ', 'oFf']) {
    assert.equal(resolveProfitProtectionMode(env(v, undefined)).mode, 'off', `MODE=${v} → off`)
  }
})

t('3. no unset/empty/invalid input changed outcome — those are 100% identical', () => {
  const SAFE = [undefined, '', 'shadow', 'off', 'liv', 'livee', 'yes', 'true', '1', 'on', 'OFF', 'Off']
  for (const m of SAFE) {
    for (const l of LEGACIES) {
      const e = env(m, l)
      assert.equal(
        resolveProfitProtectionMode(e).shadowProtection,
        preChangeShadowProtection(e),
        `MODE=${JSON.stringify(m)} LEGACY=${JSON.stringify(l)} must be unchanged`
      )
    }
  }
})

// ── Telemetry vocabulary: bounded to `shadow | live`, as the migration documents ──
t('3. telemetry mode stays in the shadow|live vocabulary and tracks the resolved mode', () => {
  for (const [m, l] of MATRIX) {
    const e = env(m, l)
    const before = preChangePptMode(e)
    const after  = newPptMode(e)
    assert.ok(['shadow', 'live'].includes(after), `telemetry "${after}" must stay in vocabulary`)
    assert.ok(['shadow', 'live'].includes(before))
    // Identical everywhere EXCEPT the two delta classes, where it correctly
    // follows the newly-resolved mode.
    const delta = WIDENED.some(([wm, wl]) => wm === m && wl === l)
               || NARROWED.some(([nm, nl]) => nm === m && nl === l)
    if (!delta) assert.equal(after, before, `telemetry changed unexpectedly for MODE=${m} LEGACY=${l}`)
  }
  // `off` must never leak into telemetry as a third value.
  for (const l of LEGACIES) assert.equal(newPptMode(env('off', l)), 'shadow')
})

t('3. the resolver names its source for every decision', () => {
  const SOURCES = ['env', 'default', 'invalid', 'inexact', 'legacy-override']
  for (const [m, l] of MATRIX) {
    const r = resolveProfitProtectionMode(env(m, l))
    assert.ok(SOURCES.includes(r.source), `source "${r.source}" from MODE=${m} LEGACY=${l}`)
  }
  assert.equal(resolveProfitProtectionMode({}).source, 'default')
  assert.equal(resolveProfitProtectionMode(env('live', undefined)).source, 'env')
  assert.equal(resolveProfitProtectionMode(env('LIVE', undefined)).source, 'inexact')
  assert.equal(resolveProfitProtectionMode(env('liv', undefined)).source, 'invalid')
  assert.equal(resolveProfitProtectionMode(env('live', 'true')).source, 'legacy-override')
})

// ── 4. EXECUTION: env → resolver → the REAL manageTrades() ──────────────────
// The decisive test. An env value is resolved by the SAME function the route now
// calls, and that boolean is fed to the REAL production trade manager over a
// multi-cycle lifecycle. This proves:
//   * unset / invalid env produces EXACTLY the shadow outcome (no activation),
//   * live is genuinely reachable when explicitly requested — so the gate is not
//     vacuously true and the wiring really does carry the mode through.
const PIP = 0.1, PVPL = 10, LOTS = 0.14
const RISK_PIPS  = 20 / (PVPL * LOTS)
const RISK_PRICE = RISK_PIPS * PIP
const ENTRY = 2000
const priceAtR = (r) => ENTRY + r * RISK_PRICE
const position = (over = {}) => ({
  ticket: 555001, symbol: 'XAUUSD', type: 'BUY', lots: LOTS,
  openPrice: ENTRY, sl: ENTRY - RISK_PRICE, tp: 0, profit: 0, ...over,
})

/**
 * A protection-SENSITIVE case, using the established fixture from
 * tests/trade-manager-shadow.test.mjs: a trade that peaked at £53 and retraced to
 * £43, with the 1.5R partial lock ALREADY committed at +0.5R and NO candle cache
 * (so there is no ATR and no trail to move the stop). The only remaining lever is
 * the peak-giveback rule — precisely what `shadowProtection` gates.
 *
 * A plain trending lifecycle is useless here: BE/trail already reach ~2.37R on
 * their own, so the protection rule contributes nothing and the gate would pass
 * vacuously. This fixture makes shadow and live measurably different.
 */
const LOCKED_SL = ENTRY + 0.5 * RISK_PRICE
const PEAK_STATE = {
  555001: {
    originalEntry: ENTRY, originalSl: ENTRY - RISK_PRICE, openedAt: new Date().toISOString(),
    peakProfit: 53, beApplied: true, partialLocked: true,
  },
}

/** Stable projection of a command list: ids/timestamps vary, structure must not. */
const shapeOf = (cmds) => cmds
  .map((c) => ({ type: c.type, symbol: c.symbol, ticket: c.ticket, newSl: c.newSl ?? null }))
  .sort((a, b) => String(a.type + a.ticket).localeCompare(String(b.type + b.ticket)))

function protectionCase(shadowProtection) {
  const pos = position({ profit: 43, sl: LOCKED_SL })
  const res = manageTrades([pos],
    { [pos.symbol]: { bid: priceAtR(2.65), ask: priceAtR(2.65) } },
    {},                                    // no candles → no ATR, no trail
    PEAK_STATE,
    { accountBalance: 10000, riskPct: 1, hardCapMultiplier: 3, shadowProtection })
  const mod = res.commands.find((c) => c.type === 'modify_sl')
  return {
    finalSlR: mod ? (mod.newSl - ENTRY) / RISK_PRICE : 0.5,
    commands: shapeOf(res.commands),
    shadow:   (res.shadowObservations || [])[0] || null,
  }
}

/** Derive the shadowProtection boolean from an env exactly as the route does. */
const shadowFromEnv = (e) => resolveProfitProtectionMode(e).shadowProtection

const SHADOW_RUN = protectionCase(true)
const LIVE_RUN   = protectionCase(false)

t('4. the gate is not vacuous: live places protection the shadow run does not', () => {
  assert.ok(LIVE_RUN.finalSlR > SHADOW_RUN.finalSlR + 0.5,
    `live must end materially more protective than shadow (live=${LIVE_RUN.finalSlR.toFixed(3)}R shadow=${SHADOW_RUN.finalSlR.toFixed(3)}R)`)
  // Shadow must leave the stop at the static partial lock — nothing more.
  assert.ok(Math.abs(SHADOW_RUN.finalSlR - 0.5) < 1e-9,
    `shadow must not move the stop past the static +0.5R lock, got ${SHADOW_RUN.finalSlR}`)
  console.log(`     shadow finalSl=${SHADOW_RUN.finalSlR.toFixed(3)}R · live finalSl=${LIVE_RUN.finalSlR.toFixed(3)}R`)
})

t('4. UNSET env → resolver → manageTrades behaves EXACTLY as shadow', () => {
  const unsetRun = protectionCase(shadowFromEnv({}))
  assert.equal(shadowFromEnv({}), true, 'unset must resolve shadowProtection=true')
  assert.equal(unsetRun.finalSlR, SHADOW_RUN.finalSlR,
    'an unset environment must produce precisely the shadow outcome')
  assert.deepEqual(unsetRun.commands, SHADOW_RUN.commands,
    'an unset environment must emit precisely the shadow command set')
})

t('4. INVALID env → resolver → manageTrades behaves EXACTLY as shadow', () => {
  for (const bad of ['liv', 'LIVE2', 'yes', 'true', '1', 'on', 'Off', 'off']) {
    const e = { PROFIT_PROTECTION_MODE: bad }
    assert.equal(shadowFromEnv(e), true, `MODE=${bad} must resolve to shadow`)
    const r = protectionCase(shadowFromEnv(e))
    assert.equal(r.finalSlR, SHADOW_RUN.finalSlR, `MODE=${bad} must produce the shadow outcome`)
    assert.deepEqual(r.commands, SHADOW_RUN.commands, `MODE=${bad} must produce the shadow commands`)
  }
})

t('4. NEAR-LIVE spellings → resolver → manageTrades stays at the SHADOW outcome', () => {
  // The hardening contract at execution level: an ambiguous spelling of live must
  // never move a real stop. Every one of these stays at the static +0.5R lock.
  const NEAR = ['LIVE', 'Live', 'lIvE', 'live ', ' live ', ' live', 'LIVE ', 'live\t']
  for (const near of NEAR) {
    const e = { PROFIT_PROTECTION_MODE: near }
    assert.equal(shadowFromEnv(e), true, `MODE=${JSON.stringify(near)} must resolve non-live`)
    const r = protectionCase(shadowFromEnv(e))
    assert.equal(r.finalSlR, SHADOW_RUN.finalSlR,
      `MODE=${JSON.stringify(near)} must stay at the shadow ${SHADOW_RUN.finalSlR}R, got ${r.finalSlR}R`)
    assert.ok(r.finalSlR < LIVE_RUN.finalSlR, 'a near-live spelling must not reach the live outcome')
  }
})

t('4. legacy force-shadow with MODE=live → resolver → manageTrades behaves as shadow', () => {
  const e = { PROFIT_PROTECTION_MODE: 'live', PROFIT_PROTECTION_SHADOW_MODE: 'true' }
  assert.equal(shadowFromEnv(e), true, 'the legacy flag must still force shadow')
  assert.equal(protectionCase(shadowFromEnv(e)).finalSlR, SHADOW_RUN.finalSlR)
})

t('4. MODE=off → resolver → manageTrades behaves as shadow (off is a hard stop)', () => {
  const e = { PROFIT_PROTECTION_MODE: 'off' }
  assert.equal(resolveProfitProtectionMode(e).mode, 'off')
  assert.equal(protectionCase(shadowFromEnv(e)).finalSlR, SHADOW_RUN.finalSlR,
    'off must never place the protection the live run places')
})

t('4. explicit MODE=live → resolver → manageTrades reaches the LIVE outcome', () => {
  const e = { PROFIT_PROTECTION_MODE: 'live' }
  assert.equal(shadowFromEnv(e), false, 'explicit live must resolve shadowProtection=false')
  assert.equal(protectionCase(shadowFromEnv(e)).finalSlR, LIVE_RUN.finalSlR,
    'explicit live must reproduce the live outcome')
})


// ── 5. The route is ACTUALLY wired to the canonical resolver ────────────────
t('5. the MT5 call site uses the canonical resolver, not the duplicated flags', () => {
  const route = readFileSync(new URL('../app/api/mt5-sync/route.ts', import.meta.url), 'utf8')
  assert.match(route, /resolveProfitProtectionMode\(process\.env\)/,
    'the call site must resolve the mode from process.env via the canonical resolver')
  assert.match(route, /const shadowProtection = ppMode\.shadowProtection/,
    'the boolean handed to manageTrades must come from the resolver')
  // The duplicated expression this phase removed.
  assert.equal(/PROFIT_PROTECTION_SHADOW_MODE === 'true'/.test(route), false,
    'the inline legacy-boolean comparison must be gone')
  assert.equal(/const forceShadow/.test(route), false, 'the inline forceShadow flag must be gone')
  assert.equal(/const shadowProtection = forceShadow/.test(route), false,
    'the inline boolean derivation must be gone')
  // The diagnostic path must be present so a misconfiguration is never silent.
  assert.match(route, /describeProfitProtectionMode\(ppMode\)/)
  // Telemetry vocabulary preserved: shadow | live only.
  assert.match(route, /pptMode = ppMode\.mode === 'live' \? 'live' : 'shadow'/)
})

t('5. the resolver is no longer dead code', () => {
  const route = readFileSync(new URL('../app/api/mt5-sync/route.ts', import.meta.url), 'utf8')
  assert.match(route, /import \{[^}]*resolveProfitProtectionMode[^}]*\} from '@\/lib\/profit-protection-mode\.mjs'/,
    'the route must import the canonical resolver')
})

t('5. nothing forbidden by scope changed: no thresholds, bands or broker interfaces', () => {
  // Guard the Phase-1 boundary explicitly — this logic must remain intact.
  const frozen = {
    'lib/profit-protection.mjs': /(RETENTION|BAND|FLOOR|MFE|GIVEBACK|STAGE)/,
    'lib/trade-manager.ts':      /shadowDecision|composeProtection/,
  }
  for (const [f, re] of Object.entries(frozen)) {
    const src = readFileSync(new URL(`../${f}`, import.meta.url), 'utf8')
    assert.ok(re.test(src), `${f} must still contain its protection logic (sanity)`)
  }
  // The env var NAMES are unchanged and now owned by the resolver — the call site
  // no longer names them at all, which is the point of the wiring. No NEW flag may
  // have appeared anywhere in the activation path.
  const route    = readFileSync(new URL('../app/api/mt5-sync/route.ts', import.meta.url), 'utf8')
  const resolver = readFileSync(new URL('../lib/profit-protection-mode.mjs', import.meta.url), 'utf8')
  assert.equal(/process\.env\.PROFIT_PROTECTION_/.test(route), false,
    'the call site must not name the flags directly any more — it hands over process.env')
  assert.match(route, /resolveProfitProtectionMode\(process\.env\)/)
  const names = [...resolver.matchAll(/PROFIT_PROTECTION_\w+/g)].map((m) => m[0])
  assert.deepEqual([...new Set(names)].sort(),
    ['PROFIT_PROTECTION_MODE', 'PROFIT_PROTECTION_SHADOW_MODE'],
    'exactly the two pre-existing env vars may be read')
})

// ── §3.2.1 BOTH production consumers use the ONE canonical resolver ───────
t('the scalp worker and the MT5 route resolve activation from the SAME resolver', () => {
  const worker = readFileSync(new URL('../workers/scalper.mjs', import.meta.url), 'utf8')
  const route  = readFileSync(new URL('../app/api/mt5-sync/route.ts', import.meta.url), 'utf8')

  for (const [name, src] of [['workers/scalper.mjs', worker], ['app/api/mt5-sync/route.ts', route]]) {
    assert.match(src, /resolveProfitProtectionMode\(process\.env\)/,
      `${name} must resolve the mode via the canonical resolver`)
    assert.match(src, /from '[^']*profit-protection-mode\.mjs'/,
      `${name} must import the canonical resolver module`)
  }
})

t('the scalp worker no longer re-interprets the activation env inline', () => {
  const worker = readFileSync(new URL('../workers/scalper.mjs', import.meta.url), 'utf8')
  // The duplicated expression this pass removed.
  assert.equal(/const forceShadow = process\.env\.PROFIT_PROTECTION_SHADOW_MODE === 'true'/.test(worker), false,
    'the inline legacy-boolean comparison must be gone from the worker')
  assert.equal(/\(process\.env\.PROFIT_PROTECTION_MODE \|\| 'shadow'\) !== 'live'/.test(worker), false,
    'the inline `!== \'live\'` comparison must be gone from the worker')
  // No module may implement a second resolver.
  assert.equal(/function\s+\w*[Rr]esolveProfitProtectionMode/.test(worker), false,
    'the worker must not define its own resolver')
})

t('startup reporting is a pure projection of the resolved object', () => {
  const worker = readFileSync(new URL('../workers/scalper.mjs', import.meta.url), 'utf8')
  // The reported mode and its description must come from the resolved object, so
  // "execution mode = X, startup log = Y" is structurally impossible.
  assert.match(worker, /const ppResolved = resolveProfitProtectionMode\(process\.env\)/)
  assert.match(worker, /describeProfitProtectionMode\(ppResolved\)/)
  assert.match(worker, /ppResolved\.mode === 'shadow'/)
  assert.match(worker, /ppResolved\.mode === 'live'/)
  // The wlog metadata must carry the resolved mode + source, not a re-derivation.
  assert.match(worker, /profitProtectionMode: ppResolved\.mode/)
  assert.match(worker, /metadata: \{ profitProtectionMode: ppResolved\.mode, source: ppResolved\.source/)
})

t('the worker-reported mode equals the resolver result for every matrix input', () => {
  // The startup log is a projection, so for each env the logged mode string must
  // be exactly the resolver's mode — no independent reinterpretation is possible.
  for (const [m, l] of MATRIX) {
    const r = resolveProfitProtectionMode(env(m, l))
    const logged = `Profit protection ${r.mode} mode`
    assert.ok(['Profit protection shadow mode', 'Profit protection live mode', 'Profit protection off mode'].includes(logged),
      `unexpected startup log for MODE=${m}: ${logged}`)
  }
  assert.equal(`Profit protection ${resolveProfitProtectionMode({}).mode} mode`, 'Profit protection shadow mode')
})

if (failed) { console.error(`\n${failed} failed`); process.exit(1) }
console.log('profit-protection activation: all tests passed')


