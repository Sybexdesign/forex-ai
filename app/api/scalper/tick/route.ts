// app/api/scalper/tick/route.ts
import { NextRequest, NextResponse } from 'next/server'
import { getMarketCandles } from '@/lib/marketdata'
import { calculateIndicators } from '@/lib/indicators'

// eslint-disable-next-line @typescript-eslint/no-require-imports
const ti = require('technicalindicators')

function pipSize(pair: string): number {
  if (pair.includes('JPY'))    return 0.01
  if (pair.startsWith('XAU'))  return 0.1
  if (pair.startsWith('XAG'))  return 0.01
  return 0.0001
}

function defaultSpread(pair: string): number {
  if (pair.startsWith('XAU')) return 0.35
  if (pair.startsWith('XAG')) return 0.03
  if (pair.includes('JPY')) return 0.012
  return 0.00012
}

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const pair      = searchParams.get('pair')      || 'XAU/USD'
  const timeframe = searchParams.get('timeframe') || '5m'
  const authToken = req.headers.get('Authorization')?.replace('Bearer ', '') || undefined

  const { candles, source: brokerName, simulated } = await getMarketCandles(authToken, pair, timeframe, 200)

  // Standard indicators (EMA20/50, RSI14, MACD, Bollinger, ADX)
  const ind = calculateIndicators(candles)

  const closes = candles.map((c: any) => c.close)
  const highs  = candles.map((c: any) => c.high)
  const lows   = candles.map((c: any) => c.low)

  // Scalper-specific extras
  const rsi7Arr:     number[] = ti.RSI.calculate({ period: 7,  values: closes })
  const ema9Arr:     number[] = ti.EMA.calculate({ period: 9,  values: closes })
  const ema21Arr:    number[] = ti.EMA.calculate({ period: 21, values: closes })
  const atrArr:      number[] = ti.ATR.calculate({ period: 14, high: highs, low: lows, close: closes })
  const stochRsiArr: { k: number; d: number }[] = ti.StochasticRSI.calculate({
    values: closes, rsiPeriod: 14, stochasticPeriod: 14, kPeriod: 3, dPeriod: 3,
  })

  const rsi7      = +rsi7Arr[rsi7Arr.length     - 1].toFixed(2)
  const ema9      = +ema9Arr[ema9Arr.length     - 1].toFixed(6)
  const ema21     = +ema21Arr[ema21Arr.length   - 1].toFixed(6)
  const atr       = +atrArr[atrArr.length       - 1].toFixed(6)
  const stochLast = stochRsiArr[stochRsiArr.length - 1] ?? { k: 50, d: 50 }
  const stochRsiK = +stochLast.k.toFixed(2)
  const stochRsiD = +stochLast.d.toFixed(2)

  // Buy pressure: ratio of bullish candles in last 20
  const last20       = candles.slice(-20)
  const bullishCount = last20.filter((c: any) => c.close >= c.open).length
  const buyPressure  = +(bullishCount / 20).toFixed(3)
  const tickVolume   = candles[candles.length - 1]?.volume || 0

  // Volume SMA20 — used by worker pre-filter to reject below-average-volume breakouts
  const volumes  = last20.map((c: any) => c.volume || 0)
  const volSMA20 = volumes.length > 0
    ? +(volumes.reduce((a: number, b: number) => a + b, 0) / volumes.length).toFixed(1)
    : 0

  const pip        = pipSize(pair)
  const spread     = defaultSpread(pair)
  const spreadPips = +(spread / pip).toFixed(1)
  const atrPips    = +(atr    / pip).toFixed(1)

  return NextResponse.json({
    price:          ind.currentPrice,
    rsi14:          +ind.rsi.toFixed(2),
    rsi7,
    ema9,
    ema21,
    ema20:          +ind.ema20.toFixed(6),
    ema50:          +ind.ema50.toFixed(6),
    macdLine:       +ind.macdLine.toFixed(6),
    macdSignal:     +ind.macdSignal.toFixed(6),
    macdHistogram:  +ind.macdHistogram.toFixed(6),
    bbUpper:        +ind.bbUpper.toFixed(6),
    bbMiddle:       +ind.bbMiddle.toFixed(6),
    bbLower:        +ind.bbLower.toFixed(6),
    bbWidth:        +ind.bbWidth.toFixed(6),
    adx:            +ind.adx.toFixed(1),
    emaCrossSignal: ind.emaCrossSignal,
    atr,
    atrPips,
    spread,
    spreadPips,
    buyPressure,
    tickVolume,
    volSMA20,
    stochRsiK,
    stochRsiD,
    broker:         brokerName,
    simulated,
    timestamp:      Date.now(),
  })
}
