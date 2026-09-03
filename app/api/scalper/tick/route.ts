// app/api/scalper/tick/route.ts
export const dynamic = 'force-dynamic'  // live price data — must never be cached

import { NextRequest, NextResponse } from 'next/server'
import { getMarketCandles, getMarketPrices } from '@/lib/marketdata'
import { calculateIndicators } from '@/lib/indicators'
import { evaluateMarketHealth, selectLatestClosedCandle } from '@/lib/market-health'

// eslint-disable-next-line @typescript-eslint/no-require-imports
const ti = require('technicalindicators')

const TF_SPAN_MS: Record<string, number> = {
  '1m': 60_000, '3m': 3 * 60_000, '5m': 5 * 60_000, '15m': 15 * 60_000,
  '30m': 30 * 60_000, '1H': 60 * 60_000, '1h': 60 * 60_000, '4H': 4 * 60 * 60_000,
  '4h': 4 * 60 * 60_000, '1D': 24 * 60 * 60_000, 'Daily': 24 * 60 * 60_000,
}

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

  // Fetch candles and live bid/ask quotes in parallel — the price feed is
  // independent of the OHLC series. The spread is advisory (gating input), so
  // the quote fetch is race'd against a 6s timeout: a slow broker feed must
  // never stall the tick endpoint the worker polls every 10s.
  const pricePromise = getMarketPrices(authToken, [pair]).catch(() => null)
  const timedPrices  = Promise.race([
    pricePromise,
    new Promise<null>(resolve => setTimeout(() => resolve(null), 6000)),
  ])
  const [{ candles, source: brokerName, simulated }, priceFeed] = await Promise.all([
    getMarketCandles(authToken, pair, timeframe, 200),
    timedPrices,
  ])
  const startedAt = Date.now()

  // ── Closed-candle data set (audit fix 2026-09-04) ──────────────────────────
  // The EA's newest bar is usually still forming. Signals must NEVER use the
  // forming bar (no lookahead). We select the latest fully closed candle using
  // the calibrated broker→UTC offset, then restrict the indicator/feature data
  // to closed candles only. A forming bar is normal and is not a failure —
  // it simply means we evaluate the previous closed candle.
  const spanMs = TF_SPAN_MS[timeframe] || 5 * 60_000
  const sel = selectLatestClosedCandle(candles, spanMs, Date.now(), `${pair}:${timeframe}`)
  let data: any[] = candles
  if (!sel.none && sel.closedCount > 1 && sel.closedCount <= candles.length) {
    data = candles.slice(0, sel.closedCount)
  }

  // Standard indicators (EMA20/50, RSI14, MACD, Bollinger, ADX) — closed candles only
  const ind = calculateIndicators(data)

  const closes = data.map((c: any) => c.close)
  const highs  = data.map((c: any) => c.high)
  const lows   = data.map((c: any) => c.low)

  // Scalper-specific extras (closed candles only)
  const rsi7Arr:     number[] = ti.RSI.calculate({ period: 7,  values: closes })
  const ema9Arr:     number[] = ti.EMA.calculate({ period: 9,  values: closes })
  const ema21Arr:    number[] = ti.EMA.calculate({ period: 21, values: closes })
  const atrArr:      number[] = ti.ATR.calculate({ period: 14, high: highs, low: lows, close: closes })
  const stochRsiArr: { k: number; d: number }[] = ti.StochasticRSI.calculate({
    values: closes, rsiPeriod: 14, stochasticPeriod: 14, kPeriod: 3, dPeriod: 3,
  })

  const rsi7      = rsi7Arr.length ? +rsi7Arr[rsi7Arr.length - 1].toFixed(2) : 50
  const ema9      = ema9Arr.length ? +ema9Arr[ema9Arr.length - 1].toFixed(6) : 0
  const ema21     = ema21Arr.length ? +ema21Arr[ema21Arr.length - 1].toFixed(6) : 0
  const atr       = atrArr.length ? +atrArr[atrArr.length - 1].toFixed(6) : 0.0001
  const stochLast = stochRsiArr.length ? stochRsiArr[stochRsiArr.length - 1] : { k: 50, d: 50 }
  const stochRsiK = +stochLast.k.toFixed(2)
  const stochRsiD = +stochLast.d.toFixed(2)

  // Buy pressure: ratio of bullish candles in last 20 closed candles
  const last20       = data.slice(-20)
  const bullishCount = last20.filter((c: any) => c.close >= c.open).length
  const buyPressure  = +(bullishCount / 20).toFixed(3)
  const tickVolume   = data.length ? data[data.length - 1]?.volume || 0 : 0

  // Volume SMA20 — used by worker pre-filter to reject below-average-volume breakouts
  const volumes  = last20.map((c: any) => c.volume || 0)
  const volSMA20 = volumes.length > 0
    ? +(volumes.reduce((a: number, b: number) => a + b, 0) / volumes.length).toFixed(1)
    : 0

  const pip        = pipSize(pair)

  // ── Real spread feed (audit Phase 1.4) ─────────────────────────────────────
  // Use the live bid/ask spread from the broker price feed when available.
  // `spreadSource` tells downstream gates whether the value is a real market
  // condition or a static per-instrument baseline — wide-spread gating must
  // only fire on live data, never on the default estimate.
  let spread      = defaultSpread(pair)
  let spreadSource: 'live' | 'default' = 'default'
  let bid: number | null = null
  let ask: number | null = null
  const quote = priceFeed?.prices.find((p: any) => p.pair === pair)
  if (quote && !priceFeed?.simulated && quote.bid > 0 && quote.ask >= quote.bid) {
    bid          = quote.bid
    ask          = quote.ask
    spread       = +(quote.ask - quote.bid).toFixed(6)
    spreadSource = 'live'
  }

  const spreadPips = +(spread / pip).toFixed(1)
  const atrPips    = +(atr    / pip).toFixed(1)

  // ── Market-data health + broker-clock watchdog (audit 2026-09-03) ──────────
  // Combines the self-calibrated broker→UTC offset with last-candle freshness.
  // When not HEALTHY the response carries dataSuspended=true so the signal
  // pipeline refuses to generate (protects against silent clock failures like
  // the original broker-timezone bug).
  const marketHealth = evaluateMarketHealth(candles, spanMs, Date.now(), {
    pair, timeframe,
    feedLatencyMs: Date.now() - startedAt,
  })
  // Phase 1.1 semantics kept for compatibility: candleClosed means "a fully
  // closed candle is available to evaluate". The forming bar is normal.
  const candleClosed = !sel.none
  const closedCloseMs = sel.closedCloseTime ? new Date(sel.closedCloseTime).getTime() : null
  const closedCandleAgeSec = closedCloseMs !== null
    ? Math.max(0, Math.round((Date.now() - (closedCloseMs - marketHealth.brokerOffsetSec * 1000)) / 1000))
    : null

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
    bid,
    ask,
    spreadSource,
    buyPressure,
    tickVolume,
    volSMA20,
    stochRsiK,
    stochRsiD,
    broker:         brokerName,
    simulated,
    // Provenance: how many CLOSED bars the indicators were computed on (the
    // forming bar is excluded), plus candle-state fields for the signal engine.
    candleCount:    data.length,
    lastCandleTime: sel.newestTime ?? null,           // newest bar (may be forming)
    currentCandleTime: sel.newestTime ?? null,
    candleClosed,                                     // a closed candle is available
    formingCandle:  sel.formingPresent,
    closedCandleCount: sel.closedCount,
    closedCandleTime:  sel.closedOpenTime,            // open of latest closed candle (broker frame)
    candleCloseTime:   sel.closedCloseTime,           // close of latest closed candle (broker frame)
    closedCandleAgeSec,                               // seconds since the closed candle's close
    // Audit 2026-09-03: explicit market-data health verdict. dataSuspended=true
    // tells downstream signal generation to REFUSE (protects against silent
    // broker-clock / stale-feed failures).
    marketHealth,
    dataSuspended: marketHealth.dataSuspended,
    timestamp:      Date.now(),
  })
}
