// lib/indicators.ts
// All technical indicators — server-side only

// eslint-disable-next-line @typescript-eslint/no-require-imports
const ti = require('technicalindicators')

import type { Candle } from './brokers/interface'

export interface IndicatorValues {
  ema20: number
  ema50: number
  emaCrossed: boolean
  emaCrossSignal: 'BULLISH' | 'BEARISH' | 'FLAT'
  rsi: number
  rsiZone: 'OVERBOUGHT' | 'OVERSOLD' | 'NEUTRAL'
  macdLine: number
  macdSignal: number
  macdHistogram: number
  macdCrossover: 'BULLISH' | 'BEARISH' | 'FLAT'
  adx: number
  adxStrength: 'STRONG' | 'MODERATE' | 'WEAK'
  bbUpper: number
  bbMiddle: number
  bbLower: number
  bbWidth: number
  priceVsBB: 'ABOVE_UPPER' | 'NEAR_UPPER' | 'MIDDLE' | 'NEAR_LOWER' | 'BELOW_LOWER'
  currentPrice: number
  timestamp: string
}

export interface ChecklistResult {
  emaCross: boolean
  rsiConfirmed: boolean     // RSI confirms direction (not just neutral)
  macdConfirmed: boolean
  priceAtLevel: boolean
  noNews: boolean
  trendStrong: boolean      // ADX >= 20 (real trend strength, not hardcoded)
  openPositionsOk: boolean
  dailyLossOk: boolean
  passCount: number
  canTrade: boolean
}

export function calculateIndicators(candles: Candle[]): IndicatorValues {
  if (candles.length < 60) {
    throw new Error(`Need at least 60 candles, got ${candles.length}`)
  }

  const closes = candles.map(c => c.close)
  const highs  = candles.map(c => c.high)
  const lows   = candles.map(c => c.low)

  // ─── EMA ──────────────────────────────────────────────────────────────────
  const ema20Arr: number[] = ti.EMA.calculate({ period: 20, values: closes })
  const ema50Arr: number[] = ti.EMA.calculate({ period: 50, values: closes })

  const ema20 = +ema20Arr[ema20Arr.length - 1].toFixed(6)
  const ema50 = +ema50Arr[ema50Arr.length - 1].toFixed(6)
  const prevEma20 = ema20Arr[ema20Arr.length - 2]
  const prevEma50 = ema50Arr[ema50Arr.length - 2]
  const emaCrossed = ema20 > ema50
  const justCrossedBullish = ema20 > ema50 && prevEma20 <= prevEma50
  const justCrossedBearish = ema20 < ema50 && prevEma20 >= prevEma50
  const emaCrossSignal: 'BULLISH' | 'BEARISH' | 'FLAT' =
    justCrossedBullish ? 'BULLISH' : justCrossedBearish ? 'BEARISH' : 'FLAT'

  // ─── RSI ──────────────────────────────────────────────────────────────────
  const rsiArr: number[] = ti.RSI.calculate({ period: 14, values: closes })
  const rsi = +rsiArr[rsiArr.length - 1].toFixed(2)
  const rsiZone: 'OVERBOUGHT' | 'OVERSOLD' | 'NEUTRAL' =
    rsi > 70 ? 'OVERBOUGHT' : rsi < 30 ? 'OVERSOLD' : 'NEUTRAL'

  // ─── MACD ─────────────────────────────────────────────────────────────────
  const macdArr: Array<{ MACD: number; signal: number; histogram: number }> = ti.MACD.calculate({
    values: closes,
    fastPeriod: 12, slowPeriod: 26, signalPeriod: 9,
    SimpleMAOscillator: false, SimpleMASignal: false,
  })
  const lastMacd  = macdArr[macdArr.length - 1]
  const prevMacd  = macdArr[macdArr.length - 2]
  const macdLine      = +(lastMacd?.MACD      ?? 0).toFixed(6)
  const macdSignal    = +(lastMacd?.signal    ?? 0).toFixed(6)
  const macdHistogram = +(lastMacd?.histogram ?? 0).toFixed(6)
  const prevHistogram = prevMacd?.histogram ?? 0
  const macdCrossover: 'BULLISH' | 'BEARISH' | 'FLAT' =
    macdHistogram > 0 && prevHistogram <= 0 ? 'BULLISH'
    : macdHistogram < 0 && prevHistogram >= 0 ? 'BEARISH'
    : 'FLAT'

  // ─── ADX ──────────────────────────────────────────────────────────────────
  const adxArr: Array<{ adx: number }> = ti.ADX.calculate({
    close: closes, high: highs, low: lows, period: 14,
  })
  const adx = +(adxArr[adxArr.length - 1]?.adx ?? 20).toFixed(1)
  const adxStrength: 'STRONG' | 'MODERATE' | 'WEAK' =
    adx > 25 ? 'STRONG' : adx > 15 ? 'MODERATE' : 'WEAK'

  // ─── Bollinger Bands ──────────────────────────────────────────────────────
  const bbArr: Array<{ upper: number; middle: number; lower: number }> = ti.BollingerBands.calculate({
    period: 20, values: closes, stdDev: 2,
  })
  const lastBB   = bbArr[bbArr.length - 1]
  const bbUpper  = +(lastBB?.upper  ?? 0).toFixed(6)
  const bbMiddle = +(lastBB?.middle ?? 0).toFixed(6)
  const bbLower  = +(lastBB?.lower  ?? 0).toFixed(6)
  const bbWidth  = +(bbUpper - bbLower).toFixed(6)

  const currentPrice = closes[closes.length - 1]
  const bbZone = bbUpper - bbLower
  const distFromMiddle = currentPrice - bbMiddle
  let priceVsBB: IndicatorValues['priceVsBB'] = 'MIDDLE'
  if (currentPrice > bbUpper)              priceVsBB = 'ABOVE_UPPER'
  else if (distFromMiddle > bbZone * 0.3)  priceVsBB = 'NEAR_UPPER'
  else if (distFromMiddle < -bbZone * 0.3) priceVsBB = 'NEAR_LOWER'
  else if (currentPrice < bbLower)         priceVsBB = 'BELOW_LOWER'

  return {
    ema20, ema50, emaCrossed, emaCrossSignal,
    rsi, rsiZone,
    macdLine, macdSignal, macdHistogram, macdCrossover,
    adx, adxStrength,
    bbUpper, bbMiddle, bbLower, bbWidth, priceVsBB,
    currentPrice,
    timestamp: candles[candles.length - 1].time,
  }
}

export function evaluateChecklist(
  indicators: IndicatorValues,
  direction: 'BUY' | 'SELL',
  options: {
    newsInWindow: boolean
    signalStrength: number
    minStrength: number
    openPositions: number
    maxPositions: number
    todayPL: number
    balance: number
    maxLossPct: number
  }
): ChecklistResult {
  const isBuy = direction === 'BUY'

  const emaCross = isBuy ? indicators.emaCrossed : !indicators.emaCrossed

  // RSI confirms DIRECTION — not just neutral. BUY needs upward momentum (>45, not overbought <70).
  // SELL needs downward momentum (<55, not oversold >30).
  const rsiConfirmed = isBuy
    ? indicators.rsi > 45 && indicators.rsi < 70
    : indicators.rsi < 55 && indicators.rsi > 30

  // MACD must confirm direction AND histogram must be positive (momentum present, not fading)
  const macdConfirmed = isBuy
    ? indicators.macdLine > indicators.macdSignal && indicators.macdHistogram > 0
    : indicators.macdLine < indicators.macdSignal && indicators.macdHistogram < 0

  const priceAtLevel =
    indicators.priceVsBB === 'MIDDLE' ||
    (isBuy  && (indicators.priceVsBB === 'NEAR_LOWER' || indicators.priceVsBB === 'BELOW_LOWER')) ||
    (!isBuy && (indicators.priceVsBB === 'NEAR_UPPER' || indicators.priceVsBB === 'ABOVE_UPPER'))

  const noNews        = !options.newsInWindow
  // ADX >= 20 confirms a real trend exists — replaces the hardcoded signalStrength=70 check that always passed
  const trendStrong   = indicators.adx >= 20
  const openPositionsOk = options.openPositions < options.maxPositions
  const maxLossUSD    = options.balance * (options.maxLossPct / 100)
  const dailyLossOk   = options.todayPL > -maxLossUSD

  const results = [emaCross, rsiConfirmed, macdConfirmed, priceAtLevel, noNews, trendStrong, openPositionsOk, dailyLossOk]
  const passCount = results.filter(Boolean).length

  return {
    emaCross, rsiConfirmed, macdConfirmed, priceAtLevel,
    noNews, trendStrong, openPositionsOk, dailyLossOk,
    passCount,
    canTrade: passCount >= 6,
  }
}

export function buildIndicatorPrompt(
  pair: string,
  timeframe: string,
  indicators: IndicatorValues,
  checklist: ChecklistResult,
  direction: 'BUY' | 'SELL'
): string {
  return `
PAIR: ${pair} | TIMEFRAME: ${timeframe} | DIRECTION BEING EVALUATED: ${direction}
CURRENT PRICE: ${indicators.currentPrice}

TREND INDICATORS:
- EMA 20: ${indicators.ema20} | EMA 50: ${indicators.ema50}
- EMA Relationship: ${indicators.emaCrossed ? 'EMA20 ABOVE EMA50 (BULLISH)' : 'EMA20 BELOW EMA50 (BEARISH)'}
- Recent EMA Cross Signal: ${indicators.emaCrossSignal}

MOMENTUM:
- RSI (14): ${indicators.rsi} → Zone: ${indicators.rsiZone}
- MACD Line: ${indicators.macdLine} | Signal: ${indicators.macdSignal} | Histogram: ${indicators.macdHistogram}
- MACD Crossover: ${indicators.macdCrossover}

TREND STRENGTH:
- ADX (14): ${indicators.adx} → ${indicators.adxStrength} trend

VOLATILITY:
- Bollinger Upper: ${indicators.bbUpper}
- Bollinger Middle: ${indicators.bbMiddle}
- Bollinger Lower: ${indicators.bbLower}
- Price Position vs BB: ${indicators.priceVsBB}
- BB Width: ${indicators.bbWidth}

ENTRY CHECKLIST (${checklist.passCount}/8):
1. EMA20 vs EMA50 trend direction aligned: ${checklist.emaCross ? 'PASS ✓' : 'FAIL ✗'}
2. RSI confirms direction (BUY: 45-70, SELL: 30-55, current: ${indicators.rsi}): ${checklist.rsiConfirmed ? 'PASS ✓' : 'FAIL ✗'}
3. MACD line + histogram confirm direction: ${checklist.macdConfirmed ? 'PASS ✓' : 'FAIL ✗'}
4. Price at favourable BB zone: ${checklist.priceAtLevel ? 'PASS ✓' : 'FAIL ✗'}
5. No high-impact news in 30min: ${checklist.noNews ? 'PASS ✓' : 'FAIL ✗'}
6. ADX >= 20 real trend exists (current: ${indicators.adx}): ${checklist.trendStrong ? 'PASS ✓' : 'FAIL ✗'}
7. Open positions below max: ${checklist.openPositionsOk ? 'PASS ✓' : 'FAIL ✗'}
8. Daily loss limit not reached: ${checklist.dailyLossOk ? 'PASS ✓' : 'FAIL ✗'}
`.trim()
}
