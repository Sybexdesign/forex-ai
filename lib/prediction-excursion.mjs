// lib/prediction-excursion.mjs
// ─────────────────────────────────────────────────────────────────────────────
// PREDICTION MEASUREMENT v2 — authoritative candle-derived excursion + resolution
//
// WHY THIS EXISTS (production defect, reconstructed 2026-09-24 on the active
// account login 476906137):
//
//   v1 measured MFE/MAE from ~10-second worker sweep prices
//   (workers/scalper.mjs resolvePredictionLogs). A sweep sampler only ever sees
//   the price AT the moment it samples, so any excursion that happened between
//   sweeps is invisible. Reconstruction against authoritative M5 candle
//   highs/lows found:
//
//     * 15 predictions stored mfe_pips = 0
//     * 13 of those 15 had GENUINE favourable movement the sampler missed
//     * the largest missed favourable excursion was >= 17.4 pips
//     * EVERY reconstructed MAE was understated, up to ~2.3x
//
//   The BUY/SELL excursion FORMULAS were correct. The defect is the market-data
//   SOURCE: sweep ticks instead of market highs/lows.
//
// WHAT THIS MODULE IS
//   A pure, side-effect-free calculator. It imports NOTHING — no broker, no
//   Supabase, no order/trade-management code, no worker state. It cannot place
//   an order, close a position, move a stop, alter risk or grant a permit,
//   because it has no capability to reach any of that (Phase 2 separation).
//
// WHAT THIS MODULE IS NOT
//   It does NOT write the canonical `mfe_pips` / `mae_pips` columns. Those feed
//   lib/expectancy-engine.ts → lib/trade-authority.ts (the live expectancy veto)
//   and are deliberately frozen. v2 writes ADDITIVE columns only.
//
// GRANULARITY HONESTY (Phase 1 / Phase 3)
//   The finest data this account actually has is M5. There are no broker ticks
//   and no M1 (the EA pushes M5/M15/H1/H4 only). Therefore exact
//   "post-entry-only" extrema are NOT derivable when a prediction is created
//   partway through an M5 bar: that bar's own high/low includes price action
//   from BEFORE the prediction existed.
//
//   Rather than silently counting pre-prediction price action, v2 reports a
//   BRACKET, and never calls either end "exact":
//
//     strict  (LOWER bound) — bars fully inside the window (t >= fromTs &&
//                             t + 300s <= toTs). Zero pre-entry contamination.
//                             May understate by up to one bar.
//     inclusive (UPPER bound) — every bar overlapping the window. Best
//                             estimate, but the first bar may carry up to
//                             `partialFirstOverlapMs` of pre-entry movement.
//
//   The overlap is reported explicitly so no reader has to guess.
// ─────────────────────────────────────────────────────────────────────────────

/** M5 bar duration. The contract timeframe (prediction-contract.mjs). */
export const M5_BAR_SECONDS = 300

/** Schema version stamped on every v2 measurement row. */
export const MEASUREMENT_VERSION = 2

export const RESOLUTION_SOURCE_BROKER_CANDLES = 'BROKER_CANDLES'
export const RESOLUTION_GRANULARITY_M5 = 'M5'

/** Explicit outcome vocabulary. Ambiguity is a FIRST-CLASS result, not a guess. */
export const OUTCOME_CLASS = Object.freeze({
  TP_BEFORE_SL:       'TP_BEFORE_SL',
  SL_BEFORE_TP:       'SL_BEFORE_TP',
  NEITHER:            'NEITHER',
  ORDER_AMBIGUOUS:    'ORDER_AMBIGUOUS',
  INSUFFICIENT_DATA:  'INSUFFICIENT_DATA',
})

/**
 * Legacy `outcome` vocabulary mapping — DIAGNOSTIC ONLY.
 *
 * v2 never writes the `outcome` column (it feeds the live expectancy engine).
 * This mapping exists so a shadow study can compare v2 against v1 apples-to-
 * apples without inventing a second meaning for WIN/LOSS.
 *
 * ORDER_AMBIGUOUS maps to INCONCLUSIVE on purpose: both barriers were touched
 * inside one M5 bar and no finer data can order them, so assigning WIN or LOSS
 * would be fabrication (Phase 5).
 */
export const LEGACY_OUTCOME_OF = Object.freeze({
  [OUTCOME_CLASS.TP_BEFORE_SL]:      'WIN',
  [OUTCOME_CLASS.SL_BEFORE_TP]:      'LOSS',
  [OUTCOME_CLASS.NEITHER]:           'INCONCLUSIVE',
  [OUTCOME_CLASS.ORDER_AMBIGUOUS]:   'INCONCLUSIVE',
  [OUTCOME_CLASS.INSUFFICIENT_DATA]: 'INCONCLUSIVE',
})

/** Diagnostic flags recorded per measurement (never used to drive anything). */
export const AMBIGUITY_FLAG = Object.freeze({
  PARTIAL_FIRST_CANDLE: 'PARTIAL_FIRST_CANDLE',
  SAME_CANDLE_BOTH:     'SAME_CANDLE_BOTH',
  NO_CANDLES_IN_WINDOW: 'NO_CANDLES_IN_WINDOW',
  GAP_IN_CANDLES:       'GAP_IN_CANDLES',
})

/**
 * The complete set of column names a v2 measurement is permitted to write.
 *
 * This is the machine-readable expression of Phase 2: v2 touches these and
 * nothing else. `assertNoLiveAffectingColumns()` enforces it in the test suite,
 * so a future edit cannot quietly start writing `outcome`, `mfe_pips`,
 * `mae_pips`, `r_multiple`, `time_to_tp_s` or `time_to_sl_s`.
 */
export const MEASUREMENT_COLUMNS = Object.freeze([
  'authoritative_mfe_pips',
  'authoritative_mae_pips',
  'strict_mfe_pips',
  'strict_mae_pips',
  'outcome_class',
  'resolution_source',
  'resolution_granularity',
  'measurement_version',
  'measurement_diag',
])

/**
 * Columns that belong to the LIVE path. v2 must never write these.
 * `mfe_pips` / `mae_pips` / `outcome` / `r_multiple` are read by
 * lib/expectancy-engine.ts; `time_to_*_s` are read by lib/counterfactual.ts.
 */
export const FORBIDDEN_LIVE_COLUMNS = Object.freeze([
  'outcome', 'mfe_pips', 'mae_pips', 'r_multiple',
  'time_to_tp_s', 'time_to_sl_s', 'resolved_at',
])

// ── internal helpers ────────────────────────────────────────────────────────

function toMs(v) {
  if (v == null) return null
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) return null
    // Mirrors the codebase convention (mt5direct.adapter does
    // `new Date(c.t * 1000)`): EA bar times are epoch SECONDS; anything already
    // large enough to be milliseconds is treated as such.
    return v > 1e12 ? v : v * 1000
  }
  const t = new Date(v).getTime()
  return Number.isFinite(t) ? t : null
}

const round2 = (n) => Math.round(n * 100) / 100

/**
 * Validate + normalise authoritative bars.
 *
 * Accepts BOTH shapes present in the codebase:
 *   EA compact { t, o, h, l, c, v }   (broker_configs.config.candleCache — `t` seconds)
 *   adapter    { time, open, high, low, close, volume }
 *
 * Bars failing validation are DROPPED rather than coerced, and duplicate bar
 * times are collapsed (last wins) so a duplicated bar cannot double-count.
 */
export function normaliseBars(candles) {
  if (!Array.isArray(candles)) return []
  const byTime = new Map()
  for (const raw of candles) {
    if (!raw || typeof raw !== 'object') continue
    const tMs = toMs(raw.t ?? raw.time ?? raw.tMs)
    const o = Number(raw.o ?? raw.open)
    const h = Number(raw.h ?? raw.high)
    const l = Number(raw.l ?? raw.low)
    const c = Number(raw.c ?? raw.close)
    const v = Number(raw.v ?? raw.volume ?? 0)
    if (tMs === null) continue
    if (![o, h, l, c].every(Number.isFinite)) continue
    if (!(h >= l)) continue
    if (!(h >= o && h >= c && l <= o && l <= c)) continue
    byTime.set(tMs, { tMs, o, h, l, c, v: Number.isFinite(v) ? v : 0 })
  }
  return [...byTime.values()].sort((a, b) => a.tMs - b.tMs)
}

/**
 * Split the window [fromMs, toMs] into the two observation bounds.
 *
 * Returns empty sets when nothing overlaps — the caller must then report
 * INSUFFICIENT_DATA rather than a fabricated zero.
 */
export function windowBars(candles, fromMs, toMsValue) {
  const bars = normaliseBars(candles)
  const from = toMs(fromMs)
  const to = toMs(toMsValue)
  if (!bars.length || from === null || to === null || !(to > from)) {
    return { inclusive: [], strict: [], partialFirstOverlapMs: null, gaps: [] }
  }
  const inclusive = bars.filter(b => b.tMs < to && b.tMs + M5_BAR_SECONDS * 1000 > from)
  const strict    = inclusive.filter(b => b.tMs >= from && b.tMs + M5_BAR_SECONDS * 1000 <= to)
  const partialFirstOverlapMs =
    inclusive.length > 0 && inclusive[0].tMs < from ? from - inclusive[0].tMs : 0

  // Interior gap detection — contiguous M5 coverage is an assumption worth
  // recording, because a missing bar could hide a barrier touch or excursion.
  const gaps = []
  for (let i = 1; i < inclusive.length; i++) {
    const delta = inclusive[i].tMs - inclusive[i - 1].tMs
    if (delta !== M5_BAR_SECONDS * 1000) {
      gaps.push({ afterMs: inclusive[i - 1].tMs, gapMs: delta })
    }
  }
  return { inclusive, strict, partialFirstOverlapMs, gaps }
}

/**
 * Excursion over a bar set, in pips, against the ORIGINAL prediction entry.
 *
 *   BUY :  MFE = max(high - entry, 0)   MAE = max(entry - low, 0)
 *   SELL:  MFE = max(entry - low, 0)    MAE = max(high - entry, 0)
 *
 * The formulas are unchanged from v1 (they were already correct) — only the
 * INPUT changes, from sweep samples to market highs/lows.
 */
export function excursionOverBars(bars, entry, direction, pip) {
  if (!bars.length) return null
  let hi = -Infinity
  let lo = Infinity
  for (const b of bars) {
    if (b.h > hi) hi = b.h
    if (b.l < lo) lo = b.l
  }
  const favourable = direction === 'BUY' ? hi - entry : entry - lo
  const adverse    = direction === 'BUY' ? entry - lo : hi - entry
  return {
    mfePips: round2(Math.max(0, favourable) / pip),
    maePips: round2(Math.max(0, adverse) / pip),
  }
}

/**
 * Bracket measurement for one prediction window.
 *
 * `inclusive` is the UPPER bound, `strict` the LOWER bound. When a bound has no
 * bars it is returned as null (measurement unavailable) — never as 0, because
 * 0 means "measured, and it was genuinely zero" (Phase 7).
 */
export function computeExcursion({ candles, entry, direction, fromTs, toTs, pip }) {
  const insufficient = (extra = {}) => ({
    inclusive: null, strict: null,
    partialFirstOverlapMs: null, barsInWindow: 0, strictBars: 0, gaps: [],
    flags: [AMBIGUITY_FLAG.NO_CANDLES_IN_WINDOW], insufficient: true, ...extra,
  })

  const entryNum = Number(entry)
  const pipNum   = Number(pip)
  if (!(entryNum > 0) || !(pipNum > 0)) return insufficient()
  if (direction !== 'BUY' && direction !== 'SELL') return insufficient()

  const { inclusive, strict, partialFirstOverlapMs, gaps } =
    windowBars(candles, fromTs, toTs)
  if (!inclusive.length) return insufficient()

  const flags = []
  if (partialFirstOverlapMs > 0) flags.push(AMBIGUITY_FLAG.PARTIAL_FIRST_CANDLE)
  if (gaps.length) flags.push(AMBIGUITY_FLAG.GAP_IN_CANDLES)

  return {
    inclusive: excursionOverBars(inclusive, entryNum, direction, pipNum),
    strict:    strict.length ? excursionOverBars(strict, entryNum, direction, pipNum) : null,
    partialFirstOverlapMs,
    barsInWindow: inclusive.length,
    strictBars: strict.length,
    gaps,
    flags,
    insufficient: false,
  }
}

/**
 * Resolve the outcome from candle high/low against the ORIGINAL SL/TP.
 *
 * Bars are walked chronologically and the FIRST decisive bar wins. A bar that
 * contains BOTH barriers with no finer data yields ORDER_AMBIGUOUS — the
 * function refuses to invent an ordering (Phase 5).
 *
 * A deciding bar that is ALSO the partial first bar is flagged, because the
 * touch may have occurred before the prediction existed. The flag is reported;
 * the classification is not silently changed.
 */
export function resolveOutcomeFromCandles({ candles, entry, direction, sl, tp, fromTs, toTs }) {
  const slNum = Number(sl)
  const tpNum = Number(tp)
  const { inclusive, partialFirstOverlapMs, gaps } = windowBars(candles, fromTs, toTs)

  const bailed = (flags) => ({
    outcomeClass: OUTCOME_CLASS.INSUFFICIENT_DATA,
    legacyOutcome: LEGACY_OUTCOME_OF[OUTCOME_CLASS.INSUFFICIENT_DATA],
    hitBarTimeMs: null, hitBarIndex: null, flags,
  })

  if (!inclusive.length) return bailed([AMBIGUITY_FLAG.NO_CANDLES_IN_WINDOW])
  if (direction !== 'BUY' && direction !== 'SELL') return bailed([AMBIGUITY_FLAG.NO_CANDLES_IN_WINDOW])

  const flags = []
  if (partialFirstOverlapMs > 0) flags.push(AMBIGUITY_FLAG.PARTIAL_FIRST_CANDLE)
  if (gaps.length) flags.push(AMBIGUITY_FLAG.GAP_IN_CANDLES)

  const haveSl = Number.isFinite(slNum) && slNum > 0
  const haveTp = Number.isFinite(tpNum) && tpNum > 0

  for (let i = 0; i < inclusive.length; i++) {
    const b = inclusive[i]
    const slHit = haveSl && (direction === 'BUY' ? b.l <= slNum : b.h >= slNum)
    const tpHit = haveTp && (direction === 'BUY' ? b.h >= tpNum : b.l <= tpNum)
    if (!slHit && !tpHit) continue

    const partial = partialFirstOverlapMs > 0 && i === 0
    if (slHit && tpHit) {
      return {
        outcomeClass: OUTCOME_CLASS.ORDER_AMBIGUOUS,
        legacyOutcome: LEGACY_OUTCOME_OF[OUTCOME_CLASS.ORDER_AMBIGUOUS],
        hitBarTimeMs: b.tMs, hitBarIndex: i,
        hitBarOpenIso: new Date(b.tMs).toISOString(),
        flags: [...flags, AMBIGUITY_FLAG.SAME_CANDLE_BOTH],
        partialFirstBarDecided: partial,
      }
    }
    const cls = slHit ? OUTCOME_CLASS.SL_BEFORE_TP : OUTCOME_CLASS.TP_BEFORE_SL
    return {
      outcomeClass: cls,
      legacyOutcome: LEGACY_OUTCOME_OF[cls],
      hitBarTimeMs: b.tMs, hitBarIndex: i,
      // BAR-LEVEL only. M5 cannot support second precision, so this is
      // diagnostic evidence and is never promoted into time_to_tp_s/sl_s.
      hitBarOpenIso: new Date(b.tMs).toISOString(),
      flags,
      partialFirstBarDecided: partial,
    }
  }

  return {
    outcomeClass: OUTCOME_CLASS.NEITHER,
    legacyOutcome: LEGACY_OUTCOME_OF[OUTCOME_CLASS.NEITHER],
    hitBarTimeMs: null, hitBarIndex: null, flags,
  }
}

/**
 * One-shot v2 measurement for a prediction, returning EXACTLY the additive
 * column payload. This is the only function the persistence layer should use.
 *
 * Never emits `outcome`, `mfe_pips`, `mae_pips`, `r_multiple` or
 * `time_to_*_s` — enforce with assertNoLiveAffectingColumns().
 *
 * `time_to_tp_s` / `time_to_sl_s` are deliberately NOT produced: M5 cannot
 * establish second-level ordering, and NULL is preferable to fabricated timing
 * (Phase 6). Bar-level hit evidence stays in measurement_diag.
 */
export function measurePrediction({
  candles, entry, direction, sl, tp,
  createdAt, windowMs, pip, nowMs = Date.now(),
}) {
  const fromMs = toMs(createdAt)
  const toMsValue = fromMs === null ? null : fromMs + Number(windowMs)
  if (fromMs === null || !Number.isFinite(toMsValue)) {
    return {
      outcome_class: OUTCOME_CLASS.INSUFFICIENT_DATA,
      resolution_source: RESOLUTION_SOURCE_BROKER_CANDLES,
      resolution_granularity: RESOLUTION_GRANULARITY_M5,
      measurement_version: MEASUREMENT_VERSION,
      authoritative_mfe_pips: null, authoritative_mae_pips: null,
      strict_mfe_pips: null, strict_mae_pips: null,
      measurement_diag: { reason: 'INVALID_WINDOW', createdAt, windowMs },
    }
  }

  const exc = computeExcursion({ candles, entry, direction, fromTs: fromMs, toTs: toMsValue, pip })
  const res = resolveOutcomeFromCandles({
    candles, entry, direction, sl, tp, fromTs: fromMs, toTs: toMsValue,
  })

  return {
    authoritative_mfe_pips: exc.inclusive ? exc.inclusive.mfePips : null,
    authoritative_mae_pips: exc.inclusive ? exc.inclusive.maePips : null,
    strict_mfe_pips: exc.strict ? exc.strict.mfePips : null,
    strict_mae_pips: exc.strict ? exc.strict.maePips : null,
    // When the EXCURSION could not be measured (no overlapping bars, invalid
    // entry or pip), the row as a whole cannot answer "what did the market do",
    // so it is reported INSUFFICIENT_DATA even if SL/TP alone would have
    // resolved. The candle-resolved class is kept in measurement_diag for
    // forensics rather than being promoted to a confident verdict.
    outcome_class: exc.insufficient ? OUTCOME_CLASS.INSUFFICIENT_DATA : res.outcomeClass,
    resolution_source: RESOLUTION_SOURCE_BROKER_CANDLES,
    resolution_granularity: RESOLUTION_GRANULARITY_M5,
    measurement_version: MEASUREMENT_VERSION,
    measurement_diag: {
      bounds: 'strict=LOWER(post-entry only), authoritative=UPPER(partial-aware)',
      partialFirstOverlapMs: exc.partialFirstOverlapMs,
      barsInWindow: exc.barsInWindow,
      strictBars: exc.strictBars,
      flags: [...new Set([...(exc.flags || []), ...(res.flags || [])])],
      hitBarOpenIso: res.hitBarOpenIso ?? null,
      hitBarIndex: res.hitBarIndex ?? null,
      partialFirstBarDecided: res.partialFirstBarDecided ?? null,
      legacyOutcomeEquivalent: res.legacyOutcome,
      outcomeClassFromCandles: res.outcomeClass,
      excursionMeasurable: !exc.insufficient,
      timeToLevel: 'NOT_DERIVED_M5_GRANULARITY',
      measuredAt: new Date(nowMs).toISOString(),
    },
  }
}

/**
 * Runtime guard used by the test suite (Phase 2 / Phase 9 safety assertions).
 * Throws if a payload would touch the live path or an undeclared column.
 */
export function assertNoLiveAffectingColumns(payload) {
  const keys = Object.keys(payload || {})
  const bad = keys.filter(k => FORBIDDEN_LIVE_COLUMNS.includes(k))
  if (bad.length) throw new Error(`v2 measurement attempted to write live column(s): ${bad.join(', ')}`)
  const unknown = keys.filter(k => !MEASUREMENT_COLUMNS.includes(k))
  if (unknown.length) throw new Error(`v2 measurement wrote undeclared column(s): ${unknown.join(', ')}`)
  return true
}

/**
 * Side-by-side comparison record for the Phase 13 shadow validation.
 * Diagnostic only — the result is never fed into any live gate.
 */
export function compareWithLegacy(v1, v2) {
  const n = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null)
  const v1Outcome = v1?.outcome ?? null
  const v2Equivalent = v2?.measurement_diag?.legacyOutcomeEquivalent ?? null
  const mfeDelta = n(v1?.mfe_pips) !== null && n(v2?.authoritative_mfe_pips) !== null
    ? round2(v2.authoritative_mfe_pips - v1.mfe_pips) : null
  const maeDelta = n(v1?.mae_pips) !== null && n(v2?.authoritative_mae_pips) !== null
    ? round2(v2.authoritative_mae_pips - v1.mae_pips) : null
  return {
    v1_mfe_pips: n(v1?.mfe_pips), v2_authoritative_mfe_pips: n(v2?.authoritative_mfe_pips), mfe_delta: mfeDelta,
    v1_mae_pips: n(v1?.mae_pips), v2_authoritative_mae_pips: n(v2?.authoritative_mae_pips), mae_delta: maeDelta,
    v1_outcome: v1Outcome,
    v2_outcome_class: v2?.outcome_class ?? null,
    v2_legacy_equivalent: v2Equivalent,
    outcome_disagreement: v1Outcome != null && v2Equivalent != null && v1Outcome !== v2Equivalent,
    // A v1 zero that v2 proves was a real excursion is exactly the production
    // defect class this repair exists to expose.
    v1_zero_mfe_but_v2_positive:
      n(v1?.mfe_pips) === 0 && (n(v2?.authoritative_mfe_pips) ?? 0) > 0,
  }
}
