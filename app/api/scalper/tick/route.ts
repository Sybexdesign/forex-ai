// app/api/scalper/tick/route.ts
export const dynamic = 'force-dynamic'  // live price data — must never be cached

import { NextRequest, NextResponse } from 'next/server'
import { getMarketCandles, getMarketPrices } from '@/lib/marketdata'
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

// ── Broker-timezone calibration (audit fix 2026-09-03) ───────────────────────
// The MT5 EA pushes MqlRates.time values in BROKER/server time (typically
// UTC+2/+3 for MT5 EET), not UTC. Candle times were compared directly against
// the UTC server clock, which skewed them ~3h into the future and made the
// candle-closed gate `Date.now() >= open + span` permanently false — so every
// signal was blocked as "candle not yet closed" and nothing was ever generated.
//
// MT5 always returns the in-progress candle as the last bar (CopyRates index
// 0), so exactly (len-1) of the returned candles must already be closed. We
// brute-force the fixed offset O (whole-minute candidates, ±14h) that satisfies
// this against the UTC clock — i.e. where time − O + span ≤ now for exactly
// len−1 candles. Whole-hour / half-hour offsets are preferred (real timezones),
// then the smallest magnitude. Cached 10 min per pair+timeframe.
const _offsetCache = new Map<string, { at: number; off: number }>()

function brokerOffsetMs(candles: any[], spanMs: number, now: number, cacheKey: string): number {
  if (!Array.isArray(candles) || candles.length < 2 || !(spanMs > 0)) return 0
  const times: number[] = []
  for (const c of candles) {
    const t = new Date(c?.time).getTime()
    if (Number.isFinite(t)) times.push(t)
  }
  if (times.length < 2) return 0
  const cached = _offsetCache.get(cacheKey)
  if (cached && now - cached.at < 10 * 60_000) return cached.off

  const lastOpen = times[times.length - 1]
  const maxOff = 14 * 3600_000
  let best = 0
  let bestScore = Number.MAX_SAFE_INTEGER
  for (let o = -maxOff; o <= maxOff; o += 60_000) {
    let closed = 0
    for (let i = 0; i < times.length; i++) {
      // UTC open time = broker time − offset; candle closed when open + span ≤ now
      if (times[i] - o + spanMs <= now) closed++
    }
    // Live EA feeds include the in-progress candle (len−1 closed). Some feeds /
    // stores only hold closed candles (all len closed). Both are valid.
    if (closed !== times.length - 1 && closed !== times.length) continue
    // Prefer: (1) live forming-candle shape, (2) whole-hour/half-hour offsets
    // (real timezone), (3) offset whose last-candle close is closest to "now"
    // (recently closed), which disambiguates whole-hour shifts.
    const formTier = closed === times.length - 1 ? 0 : 1
    const mod = ((o % 3600_000) + 3600_000) % 3600_000
    const hourTier = mod === 0 ? 0 : (mod === 1800_000 ? 1 : 2)
    const recency = Math.abs(now - (lastOpen - o + spanMs))
    // Timezone realism first (broker offsets are whole/half hours), then prefer a
    // live forming-candle shape, then the most recently consistent close.
    const score = hourTier * 1e18 + formTier * 1e15 + recency
    if (score < bestScore) { bestScore = score; best = o }
  }
  _offsetCache.set(cacheKey, { at: now, off: best })
  return best
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

  // ── Candle-closed detection (audit Phase 1.1) ─────────────────────────────
  // The last candle in the array may still be in progress. Signal generation
  // must NOT run against an unfinished candle — the indicator values change
  // every tick and produce flash predictions. Compute whether the candle has
  // closed by comparing the final candle's open time + timeframe span against
  // the server clock.
  const TF_SPAN_MS: Record<string, number> = {
    '1m': 60_000, '3m': 3 * 60_000, '5m': 5 * 60_000, '15m': 15 * 60_000,
    '30m': 30 * 60_000, '1H': 60 * 60_000, '1h': 60 * 60_000, '4H': 4 * 60 * 60_000,
    '4h': 4 * 60 * 60_000, '1D': 24 * 60 * 60_000, 'Daily': 24 * 60 * 60_000,
  }
  const spanMs = TF_SPAN_MS[timeframe]
  let candleClosed = false
  if (spanMs && candles.length > 0) {
    const lastCandleOpenMs = new Date(candles[candles.length - 1].time).getTime()
    if (isFinite(lastCandleOpenMs)) {
      // Correct for the broker/server-time offset the EA stamps on candle open
      // times (audit fix 2026-09-03) — otherwise candleClosed is permanently
      // false when the broker clock leads UTC and no signal can ever generate.
      const brokerOffset = brokerOffsetMs(candles, spanMs, Date.now(), `${pair}:${timeframe}`)
      candleClosed = Date.now() >= lastCandleOpenMs - brokerOffset + spanMs
    }
  }

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
    // Provenance for downstream integrity checks: how many bars the
    // indicators were computed on and the close time of the final bar.
    // `timestamp` is server time, NOT candle time — keep both.
    candleCount:    candles.length,
    lastCandleTime: candles[candles.length - 1]?.time ?? null,
    // Phase 1.1: authoritative "is the last candle COMPLETE?" flag.
    // Prediction pipelines MUST gate on this flag before emitting a signal.
    candleClosed,
    timestamp:      Date.now(),
  })
}
