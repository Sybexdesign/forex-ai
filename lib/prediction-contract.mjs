// lib/prediction-contract.mjs
// ─────────────────────────────────────────────────────────────────────────────
// SybexForexAI CANONICAL PREDICTION CONTRACT (Phase 2, audit 2026-09-10)
//
// This is the SINGLE source of truth for what a scalper prediction means.
// The API, the worker, the UI and the tests all consume these values. Do NOT
// define a second competing prediction definition anywhere else.
//
// Contract (unchanged from the audited implementation — made explicit):
//   signal timeframe       = M5
//   evaluation candle      = latest fully closed M5 candle (forming excluded)
//   entry/reference price  = close of the evaluation candle
//   prediction window      = 15 minutes after prediction start
//   future candle closes   = up to 3 (the M5 closes at +5 / +10 / +15 min)
//   WIN                    = TP reached before SL (sampled on closed M5 closes)
//   LOSS                   = SL reached before TP
//   INCONCLUSIVE           = neither TP nor SL reached within the window
// ─────────────────────────────────────────────────────────────────────────────

export const PREDICTION_TIMEFRAME      = 'M5'           // display + contract id
export const PREDICTION_CANDLE_TF      = '5m'           // tick/worker candle key
export const PREDICTION_WINDOW_MS      = 15 * 60 * 1000 // 900_000 ms
export const PREDICTION_WINDOW_MINUTES = 15
export const PREDICTION_FUTURE_CANDLES = 3              // next 3 M5 closes
export const PREDICTION_RESOLUTION_RULE = 'TP_BEFORE_SL'
export const PREDICTION_FALLBACK_OUTCOME = 'INCONCLUSIVE'
// Worker tracker margin: resolution must happen at (or just after) the end of
// the window so the final M5 close can still be sampled.
export const PREDICTION_MAX_AGE_MS = PREDICTION_WINDOW_MS + 60_000

/** End-of-window ISO timestamp for a prediction that starts at `start`. */
export function predictionExpiresAt(start) {
  const t = new Date(start)
  if (Number.isNaN(t.getTime())) return null
  return new Date(t.getTime() + PREDICTION_WINDOW_MS).toISOString()
}

/** Build the machine-readable prediction metadata block used by the API/UI. */
export function buildPredictionMeta(startsAtIso, entryPrice) {
  const expiresAt = predictionExpiresAt(startsAtIso)
  if (!expiresAt) return null
  return {
    timeframe:        PREDICTION_TIMEFRAME,
    windowMinutes:    PREDICTION_WINDOW_MINUTES,
    futureCandleCloses: PREDICTION_FUTURE_CANDLES,
    startsAt:         new Date(startsAtIso).toISOString(),
    expiresAt,
    entryPrice:       typeof entryPrice === 'number' && Number.isFinite(entryPrice) ? entryPrice : null,
    resolutionRule:   PREDICTION_RESOLUTION_RULE,
    fallbackOutcome:  PREDICTION_FALLBACK_OUTCOME,
  }
}

/**
 * Grade ONE sampled (closed-M5) price against the SL/TP levels.
 * SL is checked first — the same priority the label pipeline uses when a single
 * candle prints through both levels. Returns 'WIN' | 'LOSS' | null.
 * This is THE resolution rule; the worker and the tests consume this function.
 */
export function resolveSampleOutcome(price, direction, sl, tp) {
  if (!(price > 0)) return null
  if (sl > 0 && tp > 0 && price === sl && price === tp) return null
  if (direction === 'BUY') {
    if (price <= sl) return 'LOSS'
    if (price >= tp) return 'WIN'
    return null
  }
  if (direction === 'SELL') {
    if (price >= sl) return 'LOSS'
    if (price <= tp) return 'WIN'
    return null
  }
  return null
}

/** True when `nowMs` is still before the prediction expiry (monitoring should continue). */
export function isWithinPredictionWindow(expiresAtIso, nowMs) {
  const t = new Date(expiresAtIso).getTime()
  if (!Number.isFinite(t)) return false
  return nowMs < t
}

// ── Resolution-input guards (production defect, 2026-11-04) ──────────────────
// The worker resolves a prediction against ANY tick it is handed, without a
// freshness or plausibility check. On 2026-11-04 00:10–00:16 UTC that produced
// provably false outcomes on XAU/USD and XAG/USD: the 15-minute sample came back
// as 4184.354 / 57.375 — quotes from a stale series weeks out of date — while
// entry was 3930 / 49.8. The jump cleared TP on the first sample, so the rows
// were written as WIN with mfe_pips 2471–2553 on targets of 58–104 pips.
// Candles later contradicted every one of them (SL touched first).
//
// A price that is stale, or that moves further than `maxExcursionR` × the trade's
// own risk during a single 15-minute window, is not a price the prediction can be
// graded against. Refusing it leaves the row pending; the worker's max-age ceiling
// then writes INCONCLUSIVE — honest, and never a fabricated WIN.
export const PREDICTION_MAX_TICK_AGE_SEC  = 150   // mirrors SIGNAL_MAX_AGE_SECONDS
export const PREDICTION_MAX_EXCURSION_R   = 10    // 10 × the SL distance in 15 min

/**
 * May `price` be used to grade this prediction?
 * @returns {{ ok: boolean, reason: null|'NO_PRICE'|'STALE_FEED'|'IMPLAUSIBLE_PRICE' }}
 */
export function isResolvableTick({
  price, entry, sl, closedCandleAgeSec,
  maxAgeSec = PREDICTION_MAX_TICK_AGE_SEC,
  maxExcursionR = PREDICTION_MAX_EXCURSION_R,
} = {}) {
  const p = Number(price)
  if (!Number.isFinite(p) || p <= 0) return { ok: false, reason: 'NO_PRICE' }

  // A feed older than the signal TTL cannot describe the current window. This is
  // the same guard /api/scalper/signal applies before it will generate at all.
  const age = Number(closedCandleAgeSec)
  if (Number.isFinite(age) && age > maxAgeSec) return { ok: false, reason: 'STALE_FEED' }

  // Move must stay inside a plausible multiple of the prediction's own risk.
  const e = Number(entry), s = Number(sl)
  const risk = Math.abs(e - s)
  if (Number.isFinite(risk) && risk > 0 && Math.abs(p - e) > maxExcursionR * risk) {
    return { ok: false, reason: 'IMPLAUSIBLE_PRICE' }
  }
  return { ok: true, reason: null }
}

/** Stable per-candle prediction identity key (pair + broker-frame candle close). */
export function predictionIdentityKey(pair, candleCloseTimeIso) {
  return `${pair}|${candleCloseTimeIso}`
}

