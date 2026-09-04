// lib/prediction-contract.d.mts — TS declarations for lib/prediction-contract.mjs
export const PREDICTION_TIMEFRAME: 'M5'
export const PREDICTION_CANDLE_TF: '5m'
export const PREDICTION_WINDOW_MS: 900000
export const PREDICTION_WINDOW_MINUTES: 15
export const PREDICTION_FUTURE_CANDLES: 3
export const PREDICTION_RESOLUTION_RULE: 'TP_BEFORE_SL'
export const PREDICTION_FALLBACK_OUTCOME: 'INCONCLUSIVE'
export const PREDICTION_MAX_AGE_MS: number

export interface PredictionMeta {
  timeframe: 'M5'
  windowMinutes: 15
  futureCandleCloses: 3
  startsAt: string
  expiresAt: string
  entryPrice: number | null
  resolutionRule: 'TP_BEFORE_SL'
  fallbackOutcome: 'INCONCLUSIVE'
}

export function predictionExpiresAt(start: string | Date | number): string | null
export function buildPredictionMeta(startsAtIso: string | Date | number, entryPrice?: number | null): PredictionMeta | null
export function resolveSampleOutcome(
  price: number, direction: 'BUY' | 'SELL', sl: number, tp: number,
): 'WIN' | 'LOSS' | null
export function isWithinPredictionWindow(expiresAtIso: string, nowMs: number): boolean
export function predictionIdentityKey(pair: string, candleCloseTimeIso: string): string
