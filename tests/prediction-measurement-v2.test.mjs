// tests/prediction-measurement-v2.test.mjs
// ─────────────────────────────────────────────────────────────────────────────
// PREDICTION MEASUREMENT v2 regression suite (Phase 9).
//
// These cases exist because production PROVED the defect: reconstruction on the
// active account (login 476906137, 2026-09-24) against authoritative M5 candle
// highs/lows found 13 of 15 stored `mfe_pips = 0` rows had a genuine favourable
// excursion the ~10-second sweep sampler never saw (largest >= 17.4 pips), and
// every reconstructed MAE was understated (up to ~2.3x).
//
// The "sampling regression" case below reproduces that exact class of defect.
// ─────────────────────────────────────────────────────────────────────────────
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  normaliseBars, windowBars, computeExcursion, resolveOutcomeFromCandles,
  measurePrediction, assertNoLiveAffectingColumns, compareWithLegacy,
  OUTCOME_CLASS, AMBIGUITY_FLAG, MEASUREMENT_COLUMNS, FORBIDDEN_LIVE_COLUMNS,
  MEASUREMENT_VERSION, M5_BAR_SECONDS,
} from '../lib/prediction-excursion.mjs'
import {
  buildCandleHistoryRows, buildCandleHistoryRowsForCache, parseCandleCacheKey,
} from '../lib/m5-candle-history.mjs'
import { pipSizeOf, symbolOf, applyV2Measurements, persistCandleHistory, V2_WINDOW_MS } from '../lib/prediction-measurement-v2-runtime.mjs'

let failed = 0
const pending = []
const t = (name, fn) => {
  const pass = () => console.log('  ok   ' + name)
  const fail = (e) => { failed++; console.error('  FAIL ' + name + '\n        ' + (e?.message ?? e)) }
  try {
    const r = fn()
    // Async cases (the instrumentation tests use a fake async client) must be
    // awaited before the summary is printed, or a rejection would be missed.
    if (r && typeof r.then === 'function') { pending.push(r.then(pass, fail)); return }
    pass()
  } catch (e) { fail(e) }
}

// Bar open times are epoch SECONDS (EA convention: mt5direct does c.t * 1000).
const T0 = Math.floor(Date.UTC(2026, 8, 24, 4, 0, 0) / 1000)
const WIN = 15 * 60 * 1000

/** Build consecutive M5 bars starting at `startSec`: [[o,h,l,c], ...] */
const bars = (startSec, rows) =>
  rows.map((r, i) => ({ t: startSec + i * M5_BAR_SECONDS, o: r[0], h: r[1], l: r[2], c: r[3], v: 10 }))

const XAU_PIP = 0.1
const XAG_PIP = 0.01

console.log('prediction-measurement-v2')

// ═══ SCHEMA / SAFETY CONTRACT (Phase 2, Phase 7, Phase 8) ════════════════════
t('safety: v2 payload touches only declared additive columns', () => {
  const p = measurePrediction({
    candles: bars(T0, [[2000, 2005, 1998, 2002], [2002, 2006, 2000, 2004], [2004, 2007, 2001, 2005]]),
    entry: 2000, direction: 'BUY', sl: 1990, tp: 2010,
    createdAt: T0 * 1000, windowMs: WIN, pip: XAU_PIP, nowMs: (T0 + 1200) * 1000,
  })
  assert.equal(assertNoLiveAffectingColumns(p), true)
  for (const k of Object.keys(p)) {
    assert.ok(MEASUREMENT_COLUMNS.includes(k), `undeclared column ${k}`)
  }
})

t('safety: live columns are refused by the guard', () => {
  for (const bad of FORBIDDEN_LIVE_COLUMNS) {
    assert.throws(
      () => assertNoLiveAffectingColumns({ [bad]: 1 }),
      /live column|undeclared/, `guard must reject ${bad}`,
    )
  }
  // The two fields the live expectancy engine derives R from.
  assert.throws(() => assertNoLiveAffectingColumns({ mfe_pips: 0 }), /live column/)
  assert.throws(() => assertNoLiveAffectingColumns({ mae_pips: 0 }), /live column/)
  assert.throws(() => assertNoLiveAffectingColumns({ outcome: 'LOSS' }), /live column/)
})

t('safety: measurePrediction never emits outcome/mfe_pips/mae_pips/r_multiple', () => {
  const p = measurePrediction({
    candles: bars(T0, [[2000, 2010, 1990, 2005]]),
    entry: 2000, direction: 'BUY', sl: 1990, tp: 2010,
    createdAt: T0 * 1000, windowMs: WIN, pip: XAU_PIP, nowMs: (T0 + 900) * 1000,
  })
  for (const k of FORBIDDEN_LIVE_COLUMNS) {
    assert.ok(!(k in p), `v2 must not carry ${k}`)
  }
})

t('provenance: version/source/granularity are declared on every measurement', () => {
  const p = measurePrediction({
    candles: bars(T0, [[2000, 2005, 1998, 2002]]),
    entry: 2000, direction: 'BUY', sl: 1990, tp: 2010,
    createdAt: T0 * 1000, windowMs: WIN, pip: XAU_PIP, nowMs: (T0 + 600) * 1000,
  })
  assert.equal(p.measurement_version, MEASUREMENT_VERSION)
  assert.equal(p.measurement_version, 2)
  assert.equal(p.resolution_source, 'BROKER_CANDLES')
  assert.equal(p.resolution_granularity, 'M5')
})

// ═══ BUY EXCURSION (Phase 3) ════════════════════════════════════════════════
t('BUY: favourable high creates MFE, adverse low creates MAE', () => {
  const p = measurePrediction({
    candles: bars(T0, [[2000, 2005, 1999, 2003], [2003, 2006, 1998, 2004], [2004, 2004, 1997, 2000]]),
    entry: 2000, direction: 'BUY', sl: 1900, tp: 2100,
    createdAt: T0 * 1000, windowMs: WIN, pip: XAU_PIP, nowMs: (T0 + 1200) * 1000,
  })
  assert.equal(p.authoritative_mfe_pips, 60, 'high 2006 - entry 2000 = 6.0 = 60 pips')
  assert.equal(p.authoritative_mae_pips, 30, 'entry 2000 - low 1997 = 3.0 = 30 pips')
})

t('BUY: genuine zero favourable movement is measured 0, not null', () => {
  const p = measurePrediction({
    candles: bars(T0, [[1999, 2000, 1998, 1999], [1999, 2000, 1997, 1998]]),
    entry: 2000, direction: 'BUY', sl: 1900, tp: 2100,
    createdAt: T0 * 1000, windowMs: WIN, pip: XAU_PIP, nowMs: (T0 + 900) * 1000,
  })
  assert.strictEqual(p.authoritative_mfe_pips, 0, 'measured and genuinely zero -> 0')
  assert.ok(p.authoritative_mae_pips > 0, 'adverse excursion exists')
})

// ═══ SELL EXCURSION (Phase 3) ═══════════════════════════════════════════════
t('SELL: favourable low creates MFE, adverse high creates MAE', () => {
  const p = measurePrediction({
    candles: bars(T0, [[2000, 2002, 1998, 1999], [1999, 2001, 1996, 1997], [1997, 2000, 1994, 1995]]),
    entry: 2000, direction: 'SELL', sl: 2100, tp: 1900,
    createdAt: T0 * 1000, windowMs: WIN, pip: XAU_PIP, nowMs: (T0 + 1200) * 1000,
  })
  assert.equal(p.authoritative_mfe_pips, 60, 'entry 2000 - low 1994 = 6.0 = 60 pips')
  assert.equal(p.authoritative_mae_pips, 20, 'high 2002 - entry 2000 = 2.0 = 20 pips')
})

t('SELL: genuine zero favourable movement is measured 0, not null', () => {
  const p = measurePrediction({
    candles: bars(T0, [[2001, 2002, 2000, 2001], [2001, 2003, 2000, 2002]]),
    entry: 2000, direction: 'SELL', sl: 2100, tp: 1900,
    createdAt: T0 * 1000, windowMs: WIN, pip: XAU_PIP, nowMs: (T0 + 900) * 1000,
  })
  assert.strictEqual(p.authoritative_mfe_pips, 0, 'SELL that never traded below entry -> MFE 0')
  assert.equal(p.authoritative_mae_pips, 30, 'high 2003 - 2000 = 3.0 = 30 pips')
})

t('XAG pip conversion uses the symbol-specific pip size', () => {
  const p = measurePrediction({
    candles: bars(T0, [[63.50, 63.55, 63.45, 63.52]]),
    entry: 63.50, direction: 'BUY', sl: 60, tp: 70,
    createdAt: T0 * 1000, windowMs: WIN, pip: XAG_PIP, nowMs: (T0 + 600) * 1000,
  })
  assert.equal(p.authoritative_mfe_pips, 5, '0.05 / 0.01 = 5 pips')
  assert.equal(p.authoritative_mae_pips, 5, '0.05 / 0.01 = 5 pips')
  assert.equal(pipSizeOf('XAG/USD'), 0.01)
  assert.equal(pipSizeOf('XAU/USD'), 0.1)
  assert.equal(pipSizeOf('USD/JPY'), 0.01, 'JPY checked first, exactly as the worker does')
  assert.equal(pipSizeOf('EUR/USD'), 0.0001)
  assert.equal(symbolOf('XAU/USD'), 'XAUUSD', 'cache keys use the compact symbol')
})

// ═══ SAMPLING REGRESSION — reproduces the production defect (Phase 9 core) ═══
t('sampling regression: a wick the sweep sampler misses is captured from the candle', () => {
  // A BUY at 2000 whose 15-minute path REALLY wicks to 2008 (80 pips favourable),
  // but which the ~10s sweep loop only ever observed at <= 2002 (20 pips).
  const candles = bars(T0, [
    [2000, 2002, 1999, 2001],
    [2001, 2002.5, 2000, 2002],   // wick to 2002.5 only
    [2002, 2008, 2001, 2003],     // <- the wick the sampler slept through
  ])
  // v1 semantics, replayed exactly as workers/scalper.mjs does it:
  //   sig.maxP = max(observed sweep prices)
  const sweepSamples = [2000, 2001, 2002, 2001, 2002.5, 2002]
  const v1Max = Math.max(...sweepSamples)
  const v1MfePips = +Math.max(0, (v1Max - 2000) / XAU_PIP).toFixed(2)

  const p = measurePrediction({
    candles, entry: 2000, direction: 'BUY', sl: 1900, tp: 2100,
    createdAt: T0 * 1000, windowMs: WIN, pip: XAU_PIP, nowMs: (T0 + 1200) * 1000,
  })

  assert.equal(v1MfePips, 25, 'sweep sampler only ever saw 25 pips')
  assert.equal(p.authoritative_mfe_pips, 80, 'candle high 2008 -> 80 pips is captured')
  assert.ok(
    p.authoritative_mfe_pips > v1MfePips * 3,
    'the missed excursion must be materially larger than the sampled one',
  )
})

t('sampling regression: compareWithLegacy flags the v1 zero the sampler missed', () => {
  const candles = bars(T0, [
    [2000, 2000.2, 1999, 2000],
    [2000, 2000.1, 1998, 1999],
    [1999, 2001.8, 1997, 2000],   // favourable excursion to 2001.8
  ])
  const p = measurePrediction({
    candles, entry: 2000, direction: 'BUY', sl: 1900, tp: 2100,
    createdAt: T0 * 1000, windowMs: WIN, pip: XAU_PIP, nowMs: (T0 + 1200) * 1000,
  })
  // This is the exact production shape: v1 stored 0, v2 proves 18 pips.
  const cmp = compareWithLegacy({ mfe_pips: 0, mae_pips: 5, outcome: 'INCONCLUSIVE' }, p)
  assert.equal(p.authoritative_mfe_pips, 18)
  assert.equal(cmp.v1_zero_mfe_but_v2_positive, true)
  assert.equal(cmp.mfe_delta, 18)
})

// ═══ PARTIAL FIRST CANDLE (Phase 1 / Phase 3 / Phase 9) ═════════════════════
t('partial candle: pre-entry movement is excluded from strict, disclosed in diag', () => {
  // Prediction created 44s INTO the first M5 bar. That bar's high (2010) may
  // have occurred BEFORE the prediction existed, so it must never be presented
  // as an exact post-entry extreme.
  const candles = bars(T0, [
    [2000, 2010, 1999, 2005],   // partial: the first 44s of this bar pre-date the prediction
    [2005, 2005, 2001, 2002],   // fully post-entry
    [2002, 2003, 2000, 2001],   // fully post-entry
  ])
  const p = measurePrediction({
    candles, entry: 2000, direction: 'BUY', sl: 1990, tp: 2100,
    createdAt: (T0 + 44) * 1000, windowMs: WIN, pip: XAU_PIP, nowMs: (T0 + 960) * 1000,
  })
  // UPPER bound includes the partial bar and is NOT labelled exact.
  assert.equal(p.authoritative_mfe_pips, 100, 'upper bound sees the partial bar high 2010')
  // LOWER bound uses only fully post-entry bars — zero pre-entry contamination.
  assert.equal(p.strict_mfe_pips, 50, 'lower bound uses post-entry highs only (2005)')
  assert.ok(p.strict_mfe_pips <= p.authoritative_mfe_pips, 'bracket must be ordered')
  assert.equal(p.strict_mae_pips, 0, 'post-entry bars never traded below 2000 -> measured genuine 0')
  assert.equal(p.authoritative_mae_pips, 10, 'upper bound also sees the partial bar low 1999')
  // The uncertainty is DISCLOSED rather than hidden.
  assert.equal(p.measurement_diag.partialFirstOverlapMs, 44_000)
  assert.ok(p.measurement_diag.flags.includes(AMBIGUITY_FLAG.PARTIAL_FIRST_CANDLE))
  assert.equal(p.measurement_diag.barsInWindow, 3)
  assert.equal(p.measurement_diag.strictBars, 2)
})

t('partial candle: windowBars reports the overlap explicitly', () => {
  const candles = bars(T0, [[2000, 2001, 1999, 2000], [2000, 2002, 1999, 2001]])
  const w = windowBars(candles, (T0 + 44) * 1000, (T0 + 944) * 1000)
  assert.equal(w.inclusive.length, 2, 'bar0 (partial) + bar1 (complete)')
  assert.equal(w.strict.length, 1, 'only bar1 lies entirely inside the window')
  assert.equal(w.partialFirstOverlapMs, 44_000)
})

t('partial candle: an aligned window has no overlap and strict covers the contract bars', () => {
  const candles = bars(T0, [[2000, 2005, 1998, 2002], [2002, 2006, 2000, 2004], [2004, 2007, 2001, 2005]])
  const w = windowBars(candles, T0 * 1000, (T0 + 900) * 1000)
  assert.equal(w.partialFirstOverlapMs, 0, 'aligned start -> zero pre-entry contamination')
  assert.equal(w.strict.length, 3, 'the contract\'s 3 future M5 closes are all usable')
})

// ═══ TP/SL BARRIER RESOLUTION (Phase 5) ═════════════════════════════════════
const resolveWith = (rows, opts = {}) => resolveOutcomeFromCandles({
  candles: bars(T0, rows), entry: 2000, direction: 'BUY', sl: 1990, tp: 2010,
  fromTs: T0 * 1000, toTs: (T0 + 900) * 1000, ...opts,
})

t('TP/SL: TP touched, SL not -> TP_BEFORE_SL', () => {
  const r = resolveWith([[2000, 2012, 1995, 2008]])
  assert.equal(r.outcomeClass, OUTCOME_CLASS.TP_BEFORE_SL)
  assert.equal(r.legacyOutcome, 'WIN')
})

t('TP/SL: SL touched, TP not -> SL_BEFORE_TP', () => {
  const r = resolveWith([[2000, 2005, 1988, 1992]])
  assert.equal(r.outcomeClass, OUTCOME_CLASS.SL_BEFORE_TP)
  assert.equal(r.legacyOutcome, 'LOSS')
})

t('TP/SL: neither barrier touched -> NEITHER', () => {
  const r = resolveWith([[2000, 2005, 1995, 2002], [2002, 2006, 1994, 2000]])
  assert.equal(r.outcomeClass, OUTCOME_CLASS.NEITHER)
  assert.equal(r.legacyOutcome, 'INCONCLUSIVE')
})

t('TP/SL: TP in an earlier bar than SL -> TP_BEFORE_SL', () => {
  const r = resolveWith([[2000, 2012, 1995, 2010], [2010, 2011, 1985, 1986]])
  assert.equal(r.outcomeClass, OUTCOME_CLASS.TP_BEFORE_SL, 'first decisive bar wins')
  assert.equal(r.hitBarIndex, 0)
})

t('TP/SL: SL in an earlier bar than TP -> SL_BEFORE_TP', () => {
  const r = resolveWith([[2000, 2005, 1985, 1986], [1986, 2012, 1986, 2010]])
  assert.equal(r.outcomeClass, OUTCOME_CLASS.SL_BEFORE_TP, 'first decisive bar wins')
  assert.equal(r.hitBarIndex, 0)
})

t('TP/SL: both barriers inside ONE candle -> ORDER_AMBIGUOUS, never a guess', () => {
  const r = resolveWith([[2000, 2012, 1988, 2001]])
  assert.equal(r.outcomeClass, OUTCOME_CLASS.ORDER_AMBIGUOUS)
  // Must NOT be silently reported as WIN or LOSS.
  assert.equal(r.legacyOutcome, 'INCONCLUSIVE', 'ambiguity degrades to INCONCLUSIVE, not a fabricated verdict')
  assert.ok(r.flags.includes(AMBIGUITY_FLAG.SAME_CANDLE_BOTH))
})

t('TP/SL: no candles for the window -> INSUFFICIENT_DATA', () => {
  const r = resolveOutcomeFromCandles({
    candles: [], entry: 2000, direction: 'BUY', sl: 1990, tp: 2010,
    fromTs: T0 * 1000, toTs: (T0 + 900) * 1000,
  })
  assert.equal(r.outcomeClass, OUTCOME_CLASS.INSUFFICIENT_DATA)
  assert.ok(r.flags.includes(AMBIGUITY_FLAG.NO_CANDLES_IN_WINDOW))
})

t('TP/SL: SELL barriers are mirrored correctly', () => {
  const sell = (rows) => resolveOutcomeFromCandles({
    candles: bars(T0, rows), entry: 2000, direction: 'SELL', sl: 2010, tp: 1990,
    fromTs: T0 * 1000, toTs: (T0 + 900) * 1000,
  })
  assert.equal(sell([[2000, 2005, 1988, 1992]]).outcomeClass, OUTCOME_CLASS.TP_BEFORE_SL)
  assert.equal(sell([[2000, 2012, 1995, 2008]]).outcomeClass, OUTCOME_CLASS.SL_BEFORE_TP)
  assert.equal(sell([[2000, 2012, 1988, 2001]]).outcomeClass, OUTCOME_CLASS.ORDER_AMBIGUOUS)
})

t('TP/SL: an interior candle gap is disclosed', () => {
  const sparse = [
    { t: T0, o: 2000, h: 2002, l: 1998, c: 2000, v: 1 },
    // bar at T0+300 deliberately missing
    { t: T0 + 600, o: 2000, h: 2002, l: 1998, c: 2000, v: 1 },
  ]
  const r = resolveOutcomeFromCandles({
    candles: sparse, entry: 2000, direction: 'BUY', sl: 1990, tp: 2010,
    fromTs: T0 * 1000, toTs: (T0 + 900) * 1000,
  })
  assert.ok(r.flags.includes(AMBIGUITY_FLAG.GAP_IN_CANDLES), 'a missing bar could hide a touch')
})

// ═══ NULL vs ZERO (Phase 7) ═════════════════════════════════════════════════
t('NULL vs ZERO: no candles at all -> NULL, never a fabricated 0', () => {
  const p = measurePrediction({
    candles: [], entry: 2000, direction: 'BUY', sl: 1990, tp: 2010,
    createdAt: T0 * 1000, windowMs: WIN, pip: XAU_PIP, nowMs: (T0 + 900) * 1000,
  })
  assert.strictEqual(p.authoritative_mfe_pips, null, 'unavailable -> NULL')
  assert.strictEqual(p.authoritative_mae_pips, null, 'unavailable -> NULL')
  assert.strictEqual(p.strict_mfe_pips, null)
  assert.strictEqual(p.strict_mae_pips, null)
  assert.equal(p.outcome_class, OUTCOME_CLASS.INSUFFICIENT_DATA)
})

t('NULL vs ZERO: candles exist but none overlap the window -> NULL', () => {
  const p = measurePrediction({
    // Bars an hour before the prediction window.
    candles: bars(T0 - 3600, [[2000, 2005, 1998, 2002]]),
    entry: 2000, direction: 'BUY', sl: 1990, tp: 2010,
    createdAt: T0 * 1000, windowMs: WIN, pip: XAU_PIP, nowMs: (T0 + 900) * 1000,
  })
  assert.strictEqual(p.authoritative_mfe_pips, null)
  assert.equal(p.outcome_class, OUTCOME_CLASS.INSUFFICIENT_DATA)
})

t('NULL vs ZERO: measured genuine zero is 0, and is distinguishable from NULL', () => {
  const measured = measurePrediction({
    candles: bars(T0, [[1999, 2000, 1998.5, 1999.5], [1999.5, 2000, 1998, 1999]]),
    entry: 2000, direction: 'BUY', sl: 1900, tp: 2100,
    createdAt: T0 * 1000, windowMs: WIN, pip: XAU_PIP, nowMs: (T0 + 900) * 1000,
  })
  const unavailable = measurePrediction({
    candles: [], entry: 2000, direction: 'BUY', sl: 1900, tp: 2100,
    createdAt: T0 * 1000, windowMs: WIN, pip: XAU_PIP, nowMs: (T0 + 900) * 1000,
  })
  assert.strictEqual(measured.authoritative_mfe_pips, 0)
  assert.strictEqual(unavailable.authoritative_mfe_pips, null)
  assert.notStrictEqual(measured.authoritative_mfe_pips, unavailable.authoritative_mfe_pips,
    'a measured 0 and an unmeasured NULL must never collide')
})

t('NULL vs ZERO: invalid entry/pip is INSUFFICIENT_DATA, not 0', () => {
  const p = measurePrediction({
    candles: bars(T0, [[2000, 2005, 1998, 2002]]),
    entry: 0, direction: 'BUY', sl: 1990, tp: 2010,
    createdAt: T0 * 1000, windowMs: WIN, pip: XAU_PIP, nowMs: (T0 + 900) * 1000,
  })
  assert.strictEqual(p.authoritative_mfe_pips, null)
  assert.equal(p.outcome_class, OUTCOME_CLASS.INSUFFICIENT_DATA)
})

// ═══ TIME-TO-LEVEL (Phase 6) ════════════════════════════════════════════════
t('time-to-level: never fabricated from M5 — no time_to_* keys are emitted', () => {
  const p = measurePrediction({
    candles: bars(T0, [[2000, 2012, 1995, 2010]]),
    entry: 2000, direction: 'BUY', sl: 1990, tp: 2010,
    createdAt: T0 * 1000, windowMs: WIN, pip: XAU_PIP, nowMs: (T0 + 900) * 1000,
  })
  assert.ok(!('time_to_tp_s' in p), 'M5 cannot establish second precision')
  assert.ok(!('time_to_sl_s' in p))
  assert.equal(p.measurement_diag.timeToLevel, 'NOT_DERIVED_M5_GRANULARITY')
})

t('time-to-level: hit evidence is BAR-level and snapshots to a 300s boundary', () => {
  const p = measurePrediction({
    // bar0: o=2000 h=2000 l=1988 c=1992  -> SL (1990) touched, TP (2010) not
    // bar1: o=1992 h=2015 l=1992 c=2010  -> TP touched, but bar0 already decided
    candles: bars(T0, [[2000, 2000, 1988, 1992], [1992, 2015, 1992, 2010]]),
    entry: 2000, direction: 'BUY', sl: 1990, tp: 2010,
    createdAt: T0 * 1000, windowMs: WIN, pip: XAU_PIP, nowMs: (T0 + 900) * 1000,
  })
  assert.equal(p.outcome_class, OUTCOME_CLASS.SL_BEFORE_TP, 'bar0 hits SL first')
  assert.equal(p.measurement_diag.hitBarIndex, 0)
  const hitMs = new Date(p.measurement_diag.hitBarOpenIso).getTime()
  assert.equal(hitMs % (M5_BAR_SECONDS * 1000), 0, 'bar-open aligned, not second-precise')
})

// ═══ BAR NORMALISATION ══════════════════════════════════════════════════════
t('bars: both EA-compact and adapter shapes are accepted', () => {
  const compact = normaliseBars([{ t: T0, o: 1, h: 2, l: 0.5, c: 1.5, v: 3 }])
  const adapter = normaliseBars([{ time: new Date(T0 * 1000).toISOString(), open: 1, high: 2, low: 0.5, close: 1.5, volume: 3 }])
  assert.equal(compact.length, 1)
  assert.equal(adapter.length, 1)
  assert.equal(compact[0].tMs, adapter[0].tMs, 'seconds and ISO must resolve to the same instant')
})

t('bars: invalid OHLC is dropped rather than coerced', () => {
  const b = normaliseBars([
    { t: T0, o: 1, h: 0.5, l: 2, c: 1, v: 1 },        // high < low
    { t: T0 + 300, o: 1, h: NaN, l: 0.5, c: 1, v: 1 }, // non-finite
    { t: T0 + 600, o: 1, h: 2, l: 0.5, c: 1, v: 1 },   // valid
  ])
  assert.equal(b.length, 1)
  assert.equal(b[0].tMs, (T0 + 600) * 1000)
})

t('bars: duplicate bar times are collapsed so an excursion cannot double-count', () => {
  const b = normaliseBars([
    { t: T0, o: 1, h: 2, l: 0.5, c: 1, v: 1 },
    { t: T0, o: 1, h: 2, l: 0.5, c: 1, v: 1 },
  ])
  assert.equal(b.length, 1)
})

// ═══ M5 CANDLE HISTORY — forward-only, idempotent (Phase 1 / scope) ═════════
t('history: only CLOSED bars are persisted', () => {
  const nowSec = T0 + 900
  const { rows, stats } = buildCandleHistoryRows({
    symbol: 'XAUUSD',
    bars: bars(T0, [[1, 2, 0.5, 1], [1, 2, 0.5, 1], [1, 2, 0.5, 1]]),
    nowMs: nowSec * 1000,
  })
  // T0+600 bar closes at T0+900 == now → closed. No bar is open here.
  assert.equal(rows.length, 3)
  assert.equal(stats.openSkipped, 0)

  const mid = buildCandleHistoryRows({
    symbol: 'XAUUSD',
    bars: bars(T0, [[1, 2, 0.5, 1], [1, 2, 0.5, 1], [1, 2, 0.5, 1]]),
    nowMs: (T0 + 700) * 1000,   // third bar is still forming
  })
  assert.equal(mid.rows.length, 2, 'the in-progress bar must not be stored')
  assert.equal(mid.stats.openSkipped, 1)
})

t('history: re-ingesting the same feed produces byte-identical rows (idempotent)', () => {
  const feed = bars(T0, [[1, 2, 0.5, 1], [1, 2.5, 0.4, 1.1]])
  const a = buildCandleHistoryRows({ symbol: 'XAUUSD', bars: feed, nowMs: (T0 + 900) * 1000 })
  const b = buildCandleHistoryRows({ symbol: 'XAUUSD', bars: feed, nowMs: (T0 + 960) * 1000 })
  assert.deepEqual(a.rows, b.rows, 'closed bars never change → the upsert is a genuine no-op')
})

t('history: rows carry the compact symbol, timeframe and epoch-second bar_time', () => {
  const { rows } = buildCandleHistoryRows({
    symbol: 'XAUUSD', bars: bars(T0, [[2000, 2005, 1998, 2002]]), nowMs: (T0 + 900) * 1000,
  })
  assert.equal(rows[0].symbol, 'XAUUSD')
  assert.equal(rows[0].timeframe, 'M5')
  assert.equal(rows[0].bar_time, T0, 'epoch SECONDS, the unit the EA sends')
  assert.equal(rows[0].open_price, 2000)
  assert.equal(rows[0].high_price, 2005)
  assert.equal(rows[0].low_price, 1998)
  assert.equal(rows[0].close_price, 2002)
})

t('history: duplicate and invalid bars are collapsed/dropped', () => {
  const { rows, stats } = buildCandleHistoryRows({
    symbol: 'XAUUSD',
    bars: [
      { t: T0, o: 1, h: 2, l: 0.5, c: 1, v: 1 },
      { t: T0, o: 1, h: 2, l: 0.5, c: 1, v: 1 },
      { t: T0 + 300, o: 1, h: 0.4, l: 2, c: 1, v: 1 },  // high < low
    ],
    nowMs: (T0 + 900) * 1000,
  })
  assert.equal(rows.length, 1)
  assert.equal(stats.duplicates, 1)
  assert.equal(stats.invalid, 1)
})

t('history: cache keys parse, and only the requested timeframe is collected', () => {
  assert.deepEqual(parseCandleCacheKey('XAUUSD_M5'), { symbol: 'XAUUSD', tf: 'M5' })
  assert.deepEqual(parseCandleCacheKey('XAGUSD_H1'), { symbol: 'XAGUSD', tf: 'H1' })
  assert.equal(parseCandleCacheKey('nonsense'), null)

  const cache = {
    XAUUSD_M5:  { candles: bars(T0, [[2000, 2005, 1998, 2002]]) },
    XAGUSD_M5:  { candles: bars(T0, [[63.5, 63.6, 63.4, 63.55]]) },
    XAUUSD_M15: { candles: bars(T0, [[2000, 2005, 1998, 2002]]) },  // must be ignored
    XAUUSD_H1:  { candles: bars(T0, [[2000, 2005, 1998, 2002]]) },  // must be ignored
  }
  const { rows, stats } = buildCandleHistoryRowsForCache(cache, (T0 + 900) * 1000, 'M5')
  assert.equal(rows.length, 2, 'XAU + XAG M5 only')
  assert.equal(stats.matched, 2)
  assert.ok(rows.every(r => r.timeframe === 'M5'))
  assert.deepEqual([...new Set(rows.map(r => r.symbol))].sort(), ['XAGUSD', 'XAUUSD'])
})

// ═══ SOURCE-LEVEL SEPARATION PROOF (Phase 2 / Phase 9 safety) ═══════════════
t('separation: the measurement math module has ZERO imports', () => {
  const src = readFileSync(new URL('../lib/prediction-excursion.mjs', import.meta.url), 'utf8')
  assert.ok(!/^\s*import\s/m.test(src), 'a module with no imports cannot reach a broker, order or risk path')
})

t('separation: no measurement module references execution/authority/protection code', () => {
  const files = [
    '../lib/prediction-excursion.mjs',
    '../lib/m5-candle-history.mjs',
    '../lib/prediction-measurement-v2-runtime.mjs',
  ]
  const forbidden = [
    'trade-authority', 'trade-manager', 'expectancy-engine', 'profit-protection',
    'scalp-shadow', 'brokers/', 'placeOrder', 'closePosition', 'modifyOrder',
    'pendingOrders', 'manual_lots', 'riskPct',
  ]
  // Comments are stripped: a header may legitimately NAME the live path it is
  // careful not to touch (that documentation is the point). What must be absent
  // is an actual code reference.
  const stripComments = (s) => s
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/\s\/\/.*$/gm, '')
  for (const f of files) {
    const code = stripComments(readFileSync(new URL(f, import.meta.url), 'utf8'))
    for (const bad of forbidden) {
      assert.ok(!code.includes(bad), `${f} must not reference ${bad} in code`)
    }
  }
})

t('separation: the live expectancy engine still reads the FROZEN v1 columns', () => {
  // The invariant this whole phase protects: repairing measurement must not
  // move the live gate. expectancy-engine.ts is untouched and still consumes
  // prediction_logs.mfe_pips / mae_pips / outcome.
  const src = readFileSync(new URL('../lib/expectancy-engine.ts', import.meta.url), 'utf8')
  assert.ok(src.includes('row.mfe_pips'), 'v1 MFE input still present')
  assert.ok(src.includes('row.mae_pips'), 'v1 MAE input still present')
  assert.ok(!src.includes('authoritative_mfe_pips'), 'the live engine must NOT consume v2 fields')
  assert.ok(!src.includes('authoritative_mae_pips'))
})

t('separation: the migration is additive only', () => {
  const raw = readFileSync(
    new URL('../supabase/migrations/20261006_prediction_measurement_v2.sql', import.meta.url), 'utf8',
  )
  // Strip comment lines first: the REVERSIBILITY block legitimately documents
  // the DROP statements a human would run by hand, and those are not executed.
  const sql = raw.split('\n').filter(l => !l.trimStart().startsWith('--')).join('\n')
  assert.ok(sql.includes('ADD COLUMN IF NOT EXISTS authoritative_mfe_pips'))
  assert.ok(sql.includes('CREATE TABLE IF NOT EXISTS public.m5_candle_history'))
  assert.ok(sql.includes('ENABLE ROW LEVEL SECURITY'))
  // Never rewrite existing observations.
  assert.ok(!/UPDATE\s+public\.prediction_logs/i.test(sql), 'no backfill UPDATE allowed')
  assert.ok(!/DROP\s+COLUMN/i.test(sql), 'no destructive changes in executable SQL')
  // The additive columns the live engine must never consume.
  assert.ok(!/^(?!.*--).*ALTER COLUMN\s+mfe_pips/im.test(sql), 'mfe_pips must not be altered')
})

// ═══ INSTRUMENTATION & IDEMPOTENCY (pre-deployment latency / RLS observability) ═
/**
 * Minimal staged fake Supabase client. Every chain method returns a thenable
 * proxy, so the exact call shapes the runtime uses resolve without a database.
 */
function chainable(resultFn) {
  const proxy = new Proxy({}, {
    get(_t, prop) {
      if (prop === 'then') return (res, rej) => Promise.resolve().then(resultFn).then(res, rej)
      if (prop === 'catch') return (rej) => Promise.resolve().then(resultFn).catch(rej)
      if (prop === 'finally') return (fin) => Promise.resolve().then(resultFn).finally(fin)
      return () => proxy
    },
  })
  return proxy
}

function fakeSb({ selectResult = { data: [], error: null }, updateResults = [], upsertResult = { data: [], error: null } } = {}) {
  const log = { updates: [], upsertCalls: 0, upsertRows: 0, upsertOpts: null }
  let i = 0
  return {
    log,
    from() {
      return {
        select: () => chainable(() => selectResult),
        update: (payload) => {
          log.updates.push(payload)
          const idx = i++
          return chainable(() => updateResults[idx] ?? { data: [], error: null })
        },
        upsert: (rows, opts) => {
          log.upsertCalls++
          log.upsertRows = rows.length
          log.upsertOpts = opts
          return chainable(() => upsertResult)
        },
      }
    },
  }
}

const pendingRow = (over = {}) => ({
  id: 'P-1', pair: 'XAU/USD', direction: 'BUY', entry: 2000, sl: 1990, tp: 2010,
  created_at: new Date((T0 - 1200) * 1000).toISOString(),   // window already over
  prediction_expires_at: new Date((T0 - 300) * 1000).toISOString(),
  mfe_pips: 0, mae_pips: 0, outcome: 'LOSS', ...over,
})
const cacheFor = (rows) => ({ XAUUSD_M5: { candles: bars(T0, rows) } })

t('instr: rows_updated counts a write that actually landed', () => {
  const sb = fakeSb({
    selectResult: { data: [pendingRow()], error: null },
    updateResults: [{ data: [{ id: 'P-1' }], error: null }],
  })
  return applyV2Measurements(sb, {
    candleCache: cacheFor([[2000, 2005, 1998, 2002]]),
    nowMs: T0 * 1000, userId: 'u1',
  }).then(s => {
    assert.equal(s.rows_attempted, 1)
    assert.equal(s.rows_updated, 1)
    assert.equal(s.rows_skipped, 0)
    assert.equal(s.errors, 0)
    assert.equal(s.rls_blocked, false)
    assert.ok(s.v2_measurement_ms >= 0)
  })
})

t('instr: an idempotent skip counts as skipped, not as an error', () => {
  // Another writer already won the race: 0 rows returned, but no error.
  const sb = fakeSb({
    selectResult: { data: [pendingRow()], error: null },
    updateResults: [{ data: [], error: null }],
  })
  return applyV2Measurements(sb, {
    candleCache: cacheFor([[2000, 2005, 1998, 2002]]),
    nowMs: T0 * 1000, userId: 'u1',
  }).then(s => {
    assert.equal(s.rows_attempted, 1)
    assert.equal(s.rows_updated, 0)
    assert.equal(s.rows_skipped, 1, 'a no-op write is a skip, not a failure')
    assert.equal(s.errors, 0)
  })
})
t('instr: missing userId refuses to measure (no cross-account attribution)', () => {
  const sb = fakeSb({})
  return applyV2Measurements(sb, { candleCache: {}, userId: null }).then(s => {
    assert.equal(s.error, 'NO_USER_ID')
    assert.equal(s.rows_attempted, 0)
    assert.equal(sb.log.updates.length, 0, 'no write may be attempted without an owner')
  })
})

t('instr: timing is recorded per phase and the total covers them', () => {
  const sb = fakeSb({
    selectResult: { data: [pendingRow()], error: null },
    updateResults: [{ data: [{ id: 'P-1' }], error: null }],
  })
  return applyV2Measurements(sb, {
    candleCache: cacheFor([[2000, 2005, 1998, 2002]]),
    nowMs: T0 * 1000, userId: 'u1',
  }).then(s => {
    assert.equal(typeof s.select_ms, 'number')
    assert.equal(typeof s.update_ms, 'number')
    assert.ok(s.v2_measurement_ms >= s.select_ms + s.update_ms - 1, 'total must cover its phases')
  })
})

t('instr: the written payload never contains a live column', () => {
  const sb = fakeSb({
    selectResult: { data: [pendingRow({ mfe_pips: 0, mae_pips: 12, outcome: 'LOSS' })], error: null },
    updateResults: [{ data: [{ id: 'P-1' }], error: null }],
  })
  return applyV2Measurements(sb, {
    candleCache: cacheFor([[2000, 2005, 1998, 2002]]),
    nowMs: T0 * 1000, userId: 'u1',
  }).then(() => {
    const payload = sb.log.updates[0]
    assert.equal(payload.mfe_pips, undefined, 'v1 MFE must never be written by v2')
    assert.equal(payload.mae_pips, undefined)
    assert.equal(payload.outcome, undefined)
    assert.equal(payload.r_multiple, undefined)
    assert.equal(payload.measurement_version, 2)
    // The v1 zero vs v2 positive signal is recorded for the shadow study.
    assert.equal(typeof payload.measurement_diag.v1_comparison, 'object')
  })
})

t('instr: candle history reports rows_inserted from the write representation', () => {
  const sb = fakeSb({ upsertResult: { data: [], error: null } })
  return persistCandleHistory(
    sb, { XAUUSD_M5: { candles: bars(T0, [[2000, 2005, 1998, 2002]]) } }, (T0 + 900) * 1000,
  ).then(s => {
    assert.equal(s.rows_attempted, 1)
    assert.equal(s.rows_inserted, 0, 'all duplicates ignored -> nothing inserted')
    assert.equal(s.rls_blocked, true, 'attempted but nothing written is flagged for review')
    assert.equal(typeof s.candle_history_ms, 'number')
    assert.equal(sb.log.upsertOpts.onConflict, 'symbol,timeframe,bar_time')
    assert.equal(sb.log.upsertOpts.ignoreDuplicates, true, 'idempotency contract')
  })
})

t('instr: candle history counts genuinely new bars as inserted', () => {
  const sb = fakeSb({ upsertResult: { data: [{ bar_time: T0 }], error: null } })
  return persistCandleHistory(
    sb, { XAUUSD_M5: { candles: bars(T0, [[2000, 2005, 1998, 2002]]) } }, (T0 + 900) * 1000,
  ).then(s => {
    assert.equal(s.rows_attempted, 1)
    assert.equal(s.rows_inserted, 1)
    assert.equal(s.rls_blocked, false)
  })
})

const settled = await Promise.all(pending)
console.log(
  failed === 0
    ? `\nprediction-measurement-v2: all assertions passed (${settled.length} async cases awaited)`
    : `\nprediction-measurement-v2: ${failed} FAILED`,
)
process.exitCode = failed === 0 ? 0 : 1
