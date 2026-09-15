// tests/profit-protection-characterisation.test.mjs
// CHARACTERISATION ONLY — documents what lib/profit-protection.mjs does today.
// No thresholds are changed here and no behaviour is asserted as "correct"; the
// assertions pin CURRENT behaviour so a later change is forced to be deliberate.
//
// WHY A TIME SEQUENCE AND NOT SNAPSHOTS
//
// profitProtection() line 103 is `if (peak <= 0 || cur >= peak) return none()`.
// Evaluating AT a peak therefore returns floor=0 / action=null at every R — which
// looks like "the algorithm does nothing" but actually means "no retracement has
// happened yet". A snapshot test proves nothing; the trade has to be walked
// through rising profit → peak → retracement, threading the two pieces of
// PERSISTED state the algorithm depends on (stage, retentionFloorUsd).
import assert from 'node:assert/strict'
import {
  profitProtection, profitFloorToSl, pickMostProtectiveSl, STAGE_RANK, PROTECTION_CONFIG,
} from '../lib/profit-protection.mjs'

const PIP = 0.1          // XAU/USD pip size
const PVPL = 10          // $ per pip per lot (XAU)
const LOTS = 0.14

/**
 * Walk a trade through an ordered list of R multiples, threading persisted state.
 * `newSl` is committed through pickMostProtectiveSl, so the recorded SL is the
 * most protective candidate seen — exactly as the live manager composes rules.
 */
export function walk(rSteps, opts = {}) {
  const riskUsd = opts.riskUsd ?? 20
  const dir     = opts.dir ?? 'BUY'
  const entry   = opts.entry ?? 2000
  const lots    = opts.lots ?? LOTS

  let stage = ''
  let retentionFloorUsd = 0
  let bestSl = dir === 'BUY' ? entry - 10 : entry + 10   // wide initial SL, out of the way
  const rows = []

  for (const r of rSteps) {
    const profit = r * riskUsd
    // peakProfit is the running max, maintained by the CALLER (trade-manager).
    const prevPeak = rows.length ? rows[rows.length - 1].peakProfit : 0
    const peakProfit = Math.max(prevPeak, profit)

    const res = profitProtection({
      dir, entry, currentSl: bestSl,
      currentProfit: profit, peakProfit,
      riskUsd, lots, pipValuePerLot: PVPL, pip: PIP,
      stage, retentionFloorUsd,
    })

    // Persist monotonically — exactly what trade-manager.ts does.
    if (res.stage) stage = res.stage
    if (res.floorUsd > 0) retentionFloorUsd = Math.max(retentionFloorUsd, res.floorUsd)
    if (res.newSl !== null) bestSl = pickMostProtectiveSl(dir, bestSl, [res.newSl])

    rows.push({
      r, peakR: riskUsd > 0 ? peakProfit / riskUsd : null,
      currentProfit: profit, peakProfit,
      stage: res.stage || stage,
      floorPct: res.floorPct ?? 0,
      floorUsd: res.floorUsd ?? 0,
      floorR: riskUsd > 0 ? (res.floorUsd ?? 0) / riskUsd : null,
      givebackR: riskUsd > 0 ? (peakProfit - profit) / riskUsd : null,
      givebackPct: res.givebackPct,
      retentionPct: res.retentionPct,
      action: res.action,
      closeRequested: res.closeRequested,
      newSl: res.newSl,
      bestSl,
      // R actually locked by the best SL so far
      protectedR: riskUsd > 0 ? ((profitFloorToSl({ dir, entry, floorUsd: 0, lots, pipValuePerLot: PVPL, pip: PIP }) - entry) === 0 ? 0 : 0) : 0,
    })
  }
  return rows
}

/** Convert a committed SL back into the R of profit it protects. */
export function slToR(sl, { dir, entry, riskUsd, lots = LOTS, pip = PIP, pipValuePerLot = PVPL }) {
  if (sl == null) return null
  const pips = (Number(sl) - Number(entry)) / Number(pip) * (dir === 'BUY' ? 1 : -1)
  const usd = pips * pipValuePerLot * lots
  return usd / riskUsd
}

const f = (v, d = 2) => (v == null || !Number.isFinite(Number(v)) ? '-' : Number(v).toFixed(d))
const pad = (s, n) => String(s).padEnd(n)
const num = (s, n) => String(s).padStart(n)

let failed = 0
const t = (name, fn) => {
  try { fn(); console.log('  ok   ' + name) }
  catch (e) { failed++; console.error('  FAIL ' + name + '\n        ' + e.message) }
}

console.log('profit-protection characterisation (CURRENT behaviour — nothing modified)')
console.log(`config bands: ${PROTECTION_CONFIG.bands.map((b) => `${b.stage}@${b.minPeakR}R=${b.floor * 100}%`).join('  ')}`)
console.log(`earlyGivebackMinPeakUsd=${PROTECTION_CONFIG.earlyGivebackMinPeakUsd}  noiseUsd=${PROTECTION_CONFIG.noiseUsd}  noiseFrac=${PROTECTION_CONFIG.noiseFractionOfPeak}  minStopGapUsd=${PROTECTION_CONFIG.minStopGapUsd}  closeRequestMinUsd=${PROTECTION_CONFIG.closeRequestMinUsd}`)

// ── 1. The 2.5R regression fixture ───────────────────────────────────────────
const RISK = 20
const PEAK = 2.5
const seq25 = [0, 0.5, 1.0, 1.5, 2.0, PEAK, 2.4, 2.3, 2.2, 2.0, 1.875, 1.75, 1.5, 1.25, 1.0, 0.5]

t('1. 2.5R peak then retracement — full table (see OUTPUT above/below)', () => {
  const rows = walk(seq25, { riskUsd: RISK })
  console.log('\n  peakR=2.5  risk=£20  peak=£50   (BUY, 0.14 lots, XAU)')
  console.log('  ' + pad('curR', 6) + num('peakR', 7) + num('profit', 8) + num('peak', 7) + num('band', 9) + num('floorR', 8) + num('floor£', 8) + num('gbR', 7) + num('gb%', 7) + num('ret%', 7) + '  ' + pad('action', 22) + num('protectedR', 11))
  for (const r of rows) {
    console.log('  ' + pad(f(r.r, 3), 6) + num(f(r.peakR, 2), 7) + num(f(r.currentProfit), 8) + num(f(r.peakProfit), 7)
      + num(r.stage || '-', 9) + num(f(r.floorR, 3), 8) + num(f(r.floorUsd), 8) + num(f(r.givebackR, 2), 7)
      + num(r.givebackPct == null ? '-' : f(r.givebackPct * 100, 1), 7)
      + num(r.retentionPct == null ? '-' : f(r.retentionPct * 100, 1), 7)
      + '  ' + pad(r.action ?? '-', 22) + num(f(slToR(r.bestSl, { dir: 'BUY', entry: 2000, riskUsd: RISK }), 3), 11))
  }
  // Pin what the fixture actually showed, so a change here is deliberate.
  const withAction = rows.filter((r) => r.action)
  assert.ok(withAction.length > 0, 'expected at least one action during the retracement')
  assert.equal(rows.find((r) => r.r === PEAK).action, null, 'nothing happens AT the peak (line 103)')
})

// ── 4. The empirical protection curve, 0.4R → 5.0R ───────────────────────────
/** Fine-grained retrace so every band's commit window is sampled. */
function retraceFrom(peakR) {
  const out = [0, peakR * 0.25, peakR * 0.5, peakR * 0.75, peakR]
  for (let r = peakR - 0.025; r >= 0.2; r -= 0.025) out.push(Math.round(r * 1000) / 1000)
  return out
}

function curveRow(peakR, riskUsd = RISK) {
  const rows = walk(retraceFrom(peakR), { riskUsd })
  const firstAction = rows.find((r) => r.action && r.action.startsWith('ratchet'))
  const firstClose  = rows.find((r) => r.closeRequested)
  const last        = rows[rows.length - 1]
  return {
    peakR, band: last.stage, floorPct: last.floorPct, floorR: last.floorR,
    protectedR: slToR(last.bestSl, { dir: 'BUY', entry: 2000, riskUsd }),
    firstActionR: firstAction ? firstAction.r : null,
    firstCloseR:  firstClose  ? firstClose.r  : null,
  }
}

t('4. protection curve 0.4R → 5.0R', () => {
  console.log('\n  protection curve (risk=£20, BUY, XAU 0.14 lots)')
  console.log('  ' + num('peakR', 7) + num('band', 14) + num('floor%', 8) + num('floorR', 8) + num('protectedR', 11) + num('maxGB_R', 9) + num('maxGB%', 8) + num('ret%', 7) + num('firstRatchet@', 14) + num('firstClose@', 12))
  const out = []
  for (const p of [0.4, 0.5, 0.8, 1.0, 1.2, 1.5, 1.7, 2.0, 2.5, 3.0, 3.5, 4.0, 5.0]) {
    const r = curveRow(p)
    out.push(r)
    const maxGBR = r.protectedR != null ? Math.max(0, p - r.protectedR) : null
    console.log('  ' + num(f(p, 3), 7) + num(r.band || '-', 14) + num(f(r.floorPct * 100, 0) + '%', 8) + num(f(r.floorR, 3), 8)
      + num(f(r.protectedR, 3), 11) + num(f(maxGBR, 3), 9)
      + num(maxGBR == null ? '-' : f((maxGBR / p) * 100, 1), 8)
      + num(r.protectedR == null ? '-' : f((r.protectedR / p) * 100, 1), 7)
      + num(f(r.firstActionR, 3), 14) + num(f(r.firstCloseR, 3), 12))
  }
  const at = (p) => out.find((o) => o.peakR === p)
  // 'DEVELOP' (not '') is what the code returns when no band applies — stage 0.
  assert.equal(at(0.4).band, 'DEVELOP', 'sub-0.5R sits in stage 0, floor 0')
  assert.equal(at(0.4).floorR, 0, 'no MFE floor below 0.5R')
  assert.equal(at(0.5).band, 'PROTECT')
  assert.equal(at(1.0).band, 'LOCK')
  assert.equal(at(1.7).band, 'STRONG')
  assert.equal(at(3.0).band, 'EXCEPTIONAL')
  // THE HEADLINE: band percentage IS the achieved retention, for every band.
  for (const o of out.filter((x) => x.floorPct > 0)) {
    assert.ok(Math.abs(o.protectedR - o.floorR) < 1e-3, `protectedR must equal floorR at ${o.peakR}R`)
    assert.ok(Math.abs(o.protectedR / o.peakR - o.floorPct) < 1e-3, `retention must equal band% at ${o.peakR}R`)
  }
})

// ── 7. Account-size independence ─────────────────────────────────────────────
t('7. account-size independence at peakR=2.5', () => {
  console.log('\n  peakR=2.5 at four account/risk scales')
  console.log('  ' + num('riskUsd', 10) + num('peak£', 10) + num('band', 9) + num('floorR', 8) + num('protectedR', 11) + num('newSl', 12))
  const results = []
  for (const riskUsd of [5, 20, 100, 1000]) {
    const last = walk(retraceFrom(2.5), { riskUsd }).slice(-1)[0]
    const protR = slToR(last.bestSl, { dir: 'BUY', entry: 2000, riskUsd })
    results.push({ riskUsd, protR })
    console.log('  ' + num(f(riskUsd), 10) + num(f(riskUsd * 2.5), 10) + num(last.stage, 9) + num(f(last.floorR, 3), 8) + num(f(protR, 3), 11) + num(last.newSl == null ? '-' : f(last.newSl, 4), 12))
  }
  // The NORMALIZED floor is scale-free ... (tolerance: slToR round-trips through
  // price/pips/lots arithmetic, so exact float equality is not meaningful here)
  for (const r of results) {
    assert.ok(Math.abs(r.protR - 1.875) < 1e-6, `protected R must be scale-free (risk=${r.riskUsd}, got ${r.protR})`)
  }
})

// ── 6. BUY / SELL symmetry ───────────────────────────────────────────────────
t('6. BUY/SELL symmetry — normalized decision must match', () => {
  const buyRows  = walk(retraceFrom(2.5), { dir: 'BUY',  riskUsd: RISK })
  const sellRows = walk(retraceFrom(2.5), { dir: 'SELL', riskUsd: RISK })
  for (let i = 0; i < buyRows.length; i++) {
    assert.equal(sellRows[i].stage, buyRows[i].stage, `band diverged at step ${i}`)
    assert.equal(sellRows[i].floorUsd, buyRows[i].floorUsd, `floor diverged at step ${i}`)
    assert.equal(sellRows[i].action, buyRows[i].action, `action diverged at step ${i}`)
  }
  // Price direction must invert.
  const buySl  = buyRows.filter((r) => r.newSl != null).slice(-1)[0]
  const sellSl = sellRows.filter((r) => r.newSl != null).slice(-1)[0]
  assert.ok(buySl.newSl > 2000, 'BUY protection must sit ABOVE entry')
  assert.ok(sellSl.newSl < 2000, 'SELL protection must sit BELOW entry')
  console.log(`\n  BUY  protected SL ${f(buySl.newSl, 4)} (> entry 2000)  ·  SELL protected SL ${f(sellSl.newSl, 4)} (< entry 2000)`)
  console.log(`  normalized floor identical: ${buyRows[6].floorUsd === sellRows[6].floorUsd}`)
})

// ── 3 + 12. CURRENT LIVE chain vs the shadow ratchet ─────────────────────────
// trade-manager.ts constants, read-only (NOT modified):
const BE_TRIGGER_R         = 0.5   // L139
const PARTIAL_LOCK_R       = 1.5   // L140 -> SL at entry + 0.5R
const TRAIL_MULT_LOOSE     = 1.0   // L149
const TRAIL_MULT_TIGHT     = 0.5   // L150
const PROFIT_TIGHTEN_USD   = 15    // L151  FIXED CURRENCY
const TRAIL_MIN_PROFIT_USD = 15    // L160  FIXED CURRENCY

/** Model the live chain deterministically, given an ATR in PRICE terms. */
function liveChain({ peakR, riskUsd, atrPrice, dir = 'BUY', entry = 2000, lots = LOTS }) {
  const usdPerPrice = 10 * PVPL * lots          // 10 pips per $1.00 of price
  const riskPrice   = riskUsd / usdPerPrice     // price distance == 1R
  const peakProfit  = peakR * riskUsd
  const peakPrice   = entry + (dir === 'BUY' ? 1 : -1) * peakR * riskPrice
  const beProtectedR   = BE_TRIGGER_R   <= peakR ? 0   : null
  const lockProtectedR = PARTIAL_LOCK_R <= peakR ? 0.5 : null
  const mult       = peakProfit > PROFIT_TIGHTEN_USD ? TRAIL_MULT_TIGHT : TRAIL_MULT_LOOSE
  const trailPrice = peakPrice - (dir === 'BUY' ? 1 : -1) * atrPrice * mult
  const trailProfit = (dir === 'BUY' ? trailPrice - entry : entry - trailPrice) * usdPerPrice
  const trailProtectedR = peakProfit > TRAIL_MIN_PROFIT_USD && trailProfit > 0 ? trailProfit / riskUsd : null
  const cands = [beProtectedR, lockProtectedR, trailProtectedR].filter((v) => v != null && v > 0)
  return {
    beProtectedR, lockProtectedR,
    trailProtectedR: trailProtectedR == null ? null : Math.round(trailProtectedR * 1000) / 1000,
    finalR: Math.round((cands.length ? Math.max(...cands) : 0) * 1000) / 1000,
    mult, riskPrice: Math.round(riskPrice * 10000) / 10000,
  }
}

t('3 + 12. OLD live chain vs shadow ratchet at a 2.5R peak', () => {
  const riskUsd = 20, peakR = 2.5, atrPrice = 2.0
  const live = liveChain({ peakR, riskUsd, atrPrice })
  const rows = walk(retraceFrom(peakR), { riskUsd })
  const last = rows[rows.length - 1]
  const shadowR = slToR(last.bestSl, { dir: 'BUY', entry: 2000, riskUsd })

  console.log('\n  ── 2.5R peak, risk £20 (peak £50) ──')
  console.log(`  CURRENT LIVE chain (ATR=$${atrPrice}, mult=${live.mult}):`)
  console.log(`    BE (0.5R trigger)          protected: ${live.beProtectedR == null ? 'n/a' : live.beProtectedR.toFixed(2) + 'R'}`)
  console.log(`    PARTIAL LOCK (1.5R→+0.5R)  protected: ${live.lockProtectedR == null ? 'n/a' : live.lockProtectedR.toFixed(2) + 'R'}`)
  console.log(`    ATR TRAIL (fixed-$ gated)  protected: ${live.trailProtectedR == null ? 'n/a' : live.trailProtectedR.toFixed(3) + 'R'}`)
  console.log(`    FINAL (most protective)    protected: ${live.finalR.toFixed(3)}R = £${(live.finalR * riskUsd).toFixed(2)}  retention ${(live.finalR / peakR * 100).toFixed(1)}%`)
  console.log(`  EXISTING SHADOW profitProtection():`)
  console.log(`    band=${last.stage} floor=${last.floorPct * 100}%  protected: ${shadowR.toFixed(3)}R = £${(shadowR * riskUsd).toFixed(2)}  retention ${(shadowR / peakR * 100).toFixed(1)}%`)

  console.log(`\n  ATR-width sensitivity (peak 2.5R, £20 risk):`)
  for (const a of [1.0, 1.5, 2.0, 3.0, 5.0]) {
    const l = liveChain({ peakR, riskUsd, atrPrice: a })
    console.log(`    ATR=$${a.toFixed(2)}  trail=${l.trailProtectedR == null ? 'n/a' : l.trailProtectedR.toFixed(3) + 'R'}  → FINAL ${l.finalR.toFixed(3)}R (${(l.finalR / peakR * 100).toFixed(1)}%)`)
  }

  // The observed production class: £53 peak, £10 retained = 0.5R at 1R≈£20.
  const observedRisk = 10 / 0.5
  const obsPeakR = 53 / observedRisk
  const obsShadow = walk(retraceFrom(obsPeakR), { riskUsd: observedRisk }).slice(-1)[0]
  const obsShadowR = slToR(obsShadow.bestSl, { dir: 'BUY', entry: 2000, riskUsd: observedRisk })
  console.log(`\n  OBSERVED CLASS REPRODUCTION (£53 peak → £10 close):`)
  console.log(`    implied 1R = £10 / 0.5R = £${observedRisk.toFixed(2)}  → peakR = ${obsPeakR.toFixed(2)}`)
  console.log(`    OLD: peak ${obsPeakR.toFixed(2)}R → protected 0.50R → retention 20.0%   (£10.00)`)
  console.log(`    NEW: peak ${obsPeakR.toFixed(2)}R → protected ${obsShadowR.toFixed(3)}R → retention ${(obsShadowR / obsPeakR * 100).toFixed(1)}%   (£${(obsShadowR * observedRisk).toFixed(2)})`)

  assert.equal(live.lockProtectedR, 0.5, 'the static partial lock protects exactly +0.5R')
  assert.ok(shadowR > live.lockProtectedR, 'the ratchet protects strictly more than the static lock')
})

// ── 5. Runner simulations — does the ladder clip strong trends? ──────────────
const RUNNERS = {
  'A (steady expansion)': [0, 0.5, 1, 1.5, 2, 2.5, 3, 4, 5],
  'B (mid pullback)':     [0, 1, 2, 2.5, 2.0, 3, 4],
  'C (deep pullback)':    [0, 1, 2, 3, 2.4, 4, 5],
  'Choppy winner':        [0, 0.6, 0.3, 0.8, 0.45, 1.1, 0.7, 1.5],
}

t('5. runner simulations — would the existing ratchet clip them?', () => {
  console.log('\n  runner simulations (risk=£20)')
  for (const [name, seq] of Object.entries(RUNNERS)) {
    const rows     = walk(seq, { riskUsd: RISK })
    const closes   = rows.filter((r) => r.closeRequested)
    const ratchets = rows.filter((r) => r.action && r.action.startsWith('ratchet'))
    const peak     = Math.max(...seq)
    const lastR    = rows[rows.length - 1].r
    const highestProtected = rows.reduce((m, r) => {
      const v = slToR(r.bestSl, { dir: 'BUY', entry: 2000, riskUsd: RISK })
      return v == null ? m : Math.max(m, v)
    }, 0)
    const exitedAtEnd = highestProtected >= lastR
    console.log(`  ${pad(name, 24)} peak=${f(peak, 1)}R end=${f(lastR, 1)}R  ratchets=${ratchets.length}  closeReqs=${closes.length}  highestProtected=${f(highestProtected, 3)}R  stopWouldExitAtEnd=${exitedAtEnd}`)
    if (ratchets.length) console.log(`      ratchet@ ${ratchets.map((r) => f(r.r, 2) + 'R').join(', ')}`)
    if (closes.length)   console.log(`      closeReq@ ${closes.map((r) => f(r.r, 2) + 'R').join(', ')}`)
  }
})

// ── POLLING-GAP FIX — the Runner C regression ────────────────────────────────
// BEFORE the fix Runner C (0→1→2→3→**2.4**→4→5R) produced:
//     closeRequested=TRUE at 2.4R with highestProtected=0.000R
// because every earlier step was a new high (early return at `cur >= peak`), so
// no floor was ever committed, and the 3.0R→2.4R jump skipped the entire ratchet
// window. The trade was market-closed at 2.4R and then ran to 5R.
t('FIX: Runner C no longer close-requests a trade that never had protection committed', () => {
  const seq = RUNNERS['C (deep pullback)']
  const rows = walk(seq, { riskUsd: RISK })
  const closes = rows.filter((r) => r.closeRequested)
  const gapCommit = rows.find((r) => r.action && r.action.startsWith('ratchet'))

  assert.equal(closes.length, 0, 'a polling gap must not market-close an unarmed trade')
  assert.ok(gapCommit, 'the floor must instead be COMMITTED at the retracement')

  const committedR = slToR(gapCommit.bestSl, { dir: 'BUY', entry: 2000, riskUsd: RISK })
  console.log(`\n  Runner C after fix: no close request; floor committed at ${f(gapCommit.r, 2)}R → protected ${f(committedR, 3)}R`)
  // The committed stop must sit in profit, below the retracement price (placeable),
  // and well below the eventual 5R so the runner is still permitted.
  assert.ok(committedR > 0, 'committed protection must be in profit')
  assert.ok(committedR < gapCommit.r, 'the stop must sit BELOW current price to be placeable')
  assert.ok(committedR < Math.max(...seq) - 1, 'the stop must leave room for the 5R continuation')
})

t('FIX: an ARMED trade still collapse-closes (the backstop is preserved)', () => {
  // Persisted floor + stage => protection was genuinely established earlier.
  const armed = profitProtection({
    dir: 'BUY', entry: 2000, currentSl: 2002.0, riskUsd: RISK, lots: LOTS,
    pipValuePerLot: PVPL, pip: PIP,
    currentProfit: 30, peakProfit: 60, stage: 'STRONG', retentionFloorUsd: 39,
  })
  assert.equal(armed.closeRequested, true, 'the collapse backstop must still fire when armed')
  assert.equal(armed.action, 'giveback-collapse-close')
  assert.match(armed.reason, /armed/, 'the reason must state it came from armed protection')

  // A live SL already committed in profit is ALSO sufficient evidence.
  const armedBySl = profitProtection({
    dir: 'BUY', entry: 2000, currentSl: 2003.0, riskUsd: RISK, lots: LOTS,
    pipValuePerLot: PVPL, pip: PIP,
    currentProfit: 30, peakProfit: 60, stage: '', retentionFloorUsd: 0,
  })
  assert.equal(armedBySl.closeRequested, true, 'a committed in-profit SL counts as armed')
})

t('FIX: the committed floor is the ACHIEVABLE level, not the unreachable target', () => {
  const r = profitProtection({
    dir: 'BUY', entry: 2000, currentSl: 1997.5, riskUsd: 20, lots: LOTS,
    pipValuePerLot: PVPL, pip: PIP,
    currentProfit: 48, peakProfit: 60, stage: '', retentionFloorUsd: 0,   // 3.0R peak, 2.4R now
  })
  // EXCEPTIONAL target would be 85% of £60 = £51 (2.55R) — ABOVE the current £48,
  // so it is not placeable. The committed floor must be the reachable level.
  assert.ok(r.newSl !== null, 'a reachable floor must be committed')
  assert.ok(r.proposedFloorUsd > r.floorUsd, 'the target (85%) exceeds what was committable')
  assert.ok(r.floorUsd <= 48 - 2 + 1e-9, 'committed floor must respect the broker min gap')
  // And the reported floor must agree with the reported SL (consistency contract).
  const conv = profitFloorToSl({ dir: 'BUY', entry: 2000, lots: LOTS, pipValuePerLot: PVPL, pip: PIP, floorUsd: r.floorUsd })
  assert.ok(Math.abs(conv - r.newSl) < 1e-9, 'floorUsd must describe the SL actually proposed')
})

t('FIX: every decision carries an observable reason', () => {
  const cases = [
    { currentProfit: 48, peakProfit: 60, stage: '', retentionFloorUsd: 0 },
    { currentProfit: 41, peakProfit: 60, stage: 'LOCK', retentionFloorUsd: 39 },
    { currentProfit: 30, peakProfit: 60, stage: 'LOCK', retentionFloorUsd: 39 },
    { currentProfit: 59, peakProfit: 60, stage: '', retentionFloorUsd: 0 },
    { currentProfit: 60, peakProfit: 60, stage: '', retentionFloorUsd: 0 },
  ]
  for (const c of cases) {
    const r = profitProtection({ dir: 'BUY', entry: 2000, currentSl: 1999.5, riskUsd: 40, lots: 1, pipValuePerLot: 1, pip: 0.1, ...c })
    assert.ok(r.reason !== undefined, `reason must be present for ${JSON.stringify(c)}`)
  }
})




