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

/** Stable per-candle prediction identity key (pair + broker-frame candle close). */
export function predictionIdentityKey(pair, candleCloseTimeIso) {
  return `${pair}|${candleCloseTimeIso}`
}

