// lib/advanced-indicators.ts
// Advanced technical analysis:
// 1. Fibonacci retracement levels
// 2. ATR (Average True Range) for dynamic TP/SL
// 3. Candlestick pattern detection
// 4. Support & Resistance auto-detection

import type { Candle } from './oanda'

// ─── 1. FIBONACCI RETRACEMENTS ───────────────────────────────────────────────

export interface FibLevel {
  ratio: number
  label: string
  price: number
  type: 'support' | 'resistance' | 'extension'
}

export interface FibResult {
  swing_high: number
  swing_low: number
  trend: 'BULLISH' | 'BEARISH'
  levels: FibLevel[]
  currentPriceZone: string
}

const FIB_RATIOS = [
  { ratio: 0,     label: '0%'    },
  { ratio: 0.236, label: '23.6%' },
  { ratio: 0.382, label: '38.2%' },
  { ratio: 0.5,   label: '50.0%' },
  { ratio: 0.618, label: '61.8%' },
  { ratio: 0.786, label: '78.6%' },
  { ratio: 1,     label: '100%'  },
  { ratio: 1.272, label: '127.2%' },
  { ratio: 1.618, label: '161.8%' },
]

export function calcFibonacci(candles: Candle[]): FibResult {
  // Find swing high and low over last 50 candles
  const slice = candles.slice(-50)
  let swingHigh = slice[0].high
  let swingLow  = slice[0].low
  let highIdx = 0
  let lowIdx  = 0

  slice.forEach((c, i) => {
    if (c.high > swingHigh) { swingHigh = c.high; highIdx = i }
    if (c.low  < swingLow)  { swingLow  = c.low;  lowIdx  = i }
  })

  // Determine trend: was high or low first?
  const trend: 'BULLISH' | 'BEARISH' = highIdx > lowIdx ? 'BULLISH' : 'BEARISH'
  const range = swingHigh - swingLow
  const currentPrice = candles[candles.length - 1].close

  const levels: FibLevel[] = FIB_RATIOS.map(fib => {
    // For bullish: retrace DOWN from high (0% = high, 100% = low)
    // For bearish: retrace UP from low
    const price = trend === 'BULLISH'
      ? +(swingHigh - fib.ratio * range).toFixed(6)
      : +(swingLow  + fib.ratio * range).toFixed(6)

    const isExtension = fib.ratio > 1
    return {
      ratio: fib.ratio,
      label: fib.label,
      price,
      type: isExtension ? 'extension'
        : (trend === 'BULLISH' ? 'support' : 'resistance'),
    }
  })

  // Find which fib zone price is currently in
  const sorted = [...levels].sort((a, b) => a.price - b.price)
  let currentPriceZone = 'Above all levels'
  for (let i = sorted.length - 1; i >= 0; i--) {
    if (currentPrice >= sorted[i].price) {
      const next = sorted[i + 1]
      currentPriceZone = next
        ? `Between ${sorted[i].label} ($${sorted[i].price.toFixed(4)}) and ${next.label} ($${next.price.toFixed(4)})`
        : `Above ${sorted[i].label} ($${sorted[i].price.toFixed(4)})`
      break
    }
  }

  return { swing_high: swingHigh, swing_low: swingLow, trend, levels, currentPriceZone }
}

// ─── 2. ATR (Average True Range) ─────────────────────────────────────────────

export interface ATRResult {
  atr: number
  atr14: number
  atr7: number
  volatility: 'HIGH' | 'MEDIUM' | 'LOW'
  suggestedSL: number   // in pips
  suggestedTP: number   // in pips (1.5R default)
  suggestedTP2: number  // in pips (2R)
  suggestedTP3: number  // in pips (3R)
  currentPrice: number
  slPrice: { buy: number; sell: number }
  tp1Price: { buy: number; sell: number }
  tp2Price: { buy: number; sell: number }
  tp3Price: { buy: number; sell: number }
}

function calcATR(candles: Candle[], period: number): number {
  const trs: number[] = []
  for (let i = 1; i < candles.length; i++) {
    const hl  = candles[i].high - candles[i].low
    const hcp = Math.abs(candles[i].high - candles[i - 1].close)
    const lcp = Math.abs(candles[i].low  - candles[i - 1].close)
    trs.push(Math.max(hl, hcp, lcp))
  }
  const slice = trs.slice(-period)
  return slice.reduce((a, b) => a + b, 0) / slice.length
}

export function calcATRIndicator(candles: Candle[], pair: string): ATRResult {
  const atr14 = calcATR(candles, 14)
  const atr7  = calcATR(candles, 7)
  const atr   = atr14

  // Pip conversion
  const pipSize = pair.includes('JPY') ? 0.01 : pair === 'XAU/USD' ? 0.1 : pair === 'XAG/USD' ? 0.01 : 0.0001
  const atrPips = Math.max(1, Math.round(atr / pipSize))

  // Volatility classification
  const volatility: 'HIGH' | 'MEDIUM' | 'LOW' =
    atrPips > 60 ? 'HIGH' : atrPips > 25 ? 'MEDIUM' : 'LOW'

  // ATR-based SL = 1.5x ATR, TP = multiples of SL (minimum 1 pip each)
  const suggestedSL  = Math.max(1, Math.round(atrPips * 1.5))
  const suggestedTP  = Math.max(1, Math.round(suggestedSL * 1.5))  // 1:1.5 R
  const suggestedTP2 = Math.max(1, Math.round(suggestedSL * 2))    // 1:2 R
  const suggestedTP3 = Math.max(1, Math.round(suggestedSL * 3))    // 1:3 R

  const currentPrice = candles[candles.length - 1].close
  const slDist  = suggestedSL  * pipSize
  const tp1Dist = suggestedTP  * pipSize
  const tp2Dist = suggestedTP2 * pipSize
  const tp3Dist = suggestedTP3 * pipSize

  return {
    atr: +atr.toFixed(6),
    atr14: +atr14.toFixed(6),
    atr7:  +atr7.toFixed(6),
    volatility,
    suggestedSL,
    suggestedTP,
    suggestedTP2,
    suggestedTP3,
    currentPrice,
    slPrice:  { buy: +(currentPrice - slDist).toFixed(5),  sell: +(currentPrice + slDist).toFixed(5) },
    tp1Price: { buy: +(currentPrice + tp1Dist).toFixed(5), sell: +(currentPrice - tp1Dist).toFixed(5) },
    tp2Price: { buy: +(currentPrice + tp2Dist).toFixed(5), sell: +(currentPrice - tp2Dist).toFixed(5) },
    tp3Price: { buy: +(currentPrice + tp3Dist).toFixed(5), sell: +(currentPrice - tp3Dist).toFixed(5) },
  }
}

// ─── 3. CANDLESTICK PATTERN DETECTION ────────────────────────────────────────

export type PatternSignal = 'BULLISH' | 'BEARISH' | 'NEUTRAL'
export type PatternStrength = 'STRONG' | 'MODERATE' | 'WEAK'

export interface CandlePattern {
  name: string
  signal: PatternSignal
  strength: PatternStrength
  description: string
  emoji: string
  candles: number  // how many candles form this pattern
}

export interface PatternResult {
  patterns: CandlePattern[]
  dominantSignal: PatternSignal
  summary: string
  bullishCount: number
  bearishCount: number
}

function bodySize(c: Candle) { return Math.abs(c.close - c.open) }
function candleRange(c: Candle) { return c.high - c.low }
function upperWick(c: Candle) { return c.high - Math.max(c.open, c.close) }
function lowerWick(c: Candle) { return Math.min(c.open, c.close) - c.low }
function isBullish(c: Candle) { return c.close > c.open }
function isBearish(c: Candle) { return c.close < c.open }
function bodyPct(c: Candle) { return bodySize(c) / (candleRange(c) || 1) }

export function detectCandlePatterns(candles: Candle[]): PatternResult {
  const patterns: CandlePattern[] = []
  const len = candles.length
  if (len < 3) return { patterns: [], dominantSignal: 'NEUTRAL', summary: 'Not enough data', bullishCount: 0, bearishCount: 0 }

  const c0 = candles[len - 1]  // current
  const c1 = candles[len - 2]  // previous
  const c2 = candles[len - 3]  // 2 back

  const avgBody = candles.slice(-20).reduce((s, c) => s + bodySize(c), 0) / 20

  // ── Single candle patterns ────────────────────────────────────────────────

  // Doji — open ≈ close, small body
  if (bodySize(c0) < candleRange(c0) * 0.1) {
    patterns.push({
      name: 'Doji', signal: 'NEUTRAL', strength: 'MODERATE', candles: 1,
      emoji: '➖',
      description: 'Indecision — buyers and sellers equal. Watch for breakout direction.',
    })
  }

  // Hammer (bullish) — small body at top, long lower wick, after downtrend
  if (
    lowerWick(c0) > bodySize(c0) * 2 &&
    upperWick(c0) < bodySize(c0) * 0.5 &&
    isBullish(c0)
  ) {
    patterns.push({
      name: 'Hammer', signal: 'BULLISH', strength: 'STRONG', candles: 1,
      emoji: '🔨',
      description: 'Bullish reversal — sellers pushed price down but buyers rejected the lows strongly.',
    })
  }

  // Shooting Star (bearish) — small body at bottom, long upper wick
  if (
    upperWick(c0) > bodySize(c0) * 2 &&
    lowerWick(c0) < bodySize(c0) * 0.5 &&
    isBearish(c0)
  ) {
    patterns.push({
      name: 'Shooting Star', signal: 'BEARISH', strength: 'STRONG', candles: 1,
      emoji: '⭐',
      description: 'Bearish reversal — buyers pushed price up but sellers rejected the highs strongly.',
    })
  }

  // Inverted Hammer (bullish after downtrend)
  if (
    upperWick(c0) > bodySize(c0) * 2 &&
    lowerWick(c0) < bodySize(c0) * 0.3 &&
    isBullish(c0)
  ) {
    patterns.push({
      name: 'Inverted Hammer', signal: 'BULLISH', strength: 'MODERATE', candles: 1,
      emoji: '🔁',
      description: 'Potential bullish reversal — buyers starting to push back.',
    })
  }

  // Pin Bar (long wick rejection — either direction)
  if (lowerWick(c0) > candleRange(c0) * 0.6 && isBullish(c0)) {
    patterns.push({
      name: 'Bullish Pin Bar', signal: 'BULLISH', strength: 'STRONG', candles: 1,
      emoji: '📌',
      description: 'Strong bullish rejection — price dipped low then snapped back up. Buy signal.',
    })
  }
  if (upperWick(c0) > candleRange(c0) * 0.6 && isBearish(c0)) {
    patterns.push({
      name: 'Bearish Pin Bar', signal: 'BEARISH', strength: 'STRONG', candles: 1,
      emoji: '📌',
      description: 'Strong bearish rejection — price spiked high then fell. Sell signal.',
    })
  }

  // Marubozu (strong momentum candle, no wicks)
  if (bodyPct(c0) > 0.9 && bodySize(c0) > avgBody * 1.5) {
    patterns.push({
      name: isBullish(c0) ? 'Bullish Marubozu' : 'Bearish Marubozu',
      signal: isBullish(c0) ? 'BULLISH' : 'BEARISH',
      strength: 'STRONG', candles: 1,
      emoji: isBullish(c0) ? '🟢' : '🔴',
      description: `Very strong ${isBullish(c0) ? 'bullish' : 'bearish'} momentum — almost no wicks. Continuation likely.`,
    })
  }

  // Spinning Top — small body, equal wicks
  if (
    bodyPct(c0) < 0.3 &&
    upperWick(c0) > bodySize(c0) &&
    lowerWick(c0) > bodySize(c0)
  ) {
    patterns.push({
      name: 'Spinning Top', signal: 'NEUTRAL', strength: 'WEAK', candles: 1,
      emoji: '🌀',
      description: 'Market indecision — neither buyers nor sellers in control. Wait for direction.',
    })
  }

  // ── Two candle patterns ───────────────────────────────────────────────────

  // Bullish Engulfing
  if (
    isBearish(c1) && isBullish(c0) &&
    c0.open < c1.close &&
    c0.close > c1.open &&
    bodySize(c0) > bodySize(c1)
  ) {
    patterns.push({
      name: 'Bullish Engulfing', signal: 'BULLISH', strength: 'STRONG', candles: 2,
      emoji: '🔥',
      description: 'Strong bullish reversal — current candle completely engulfs previous bearish candle.',
    })
  }

  // Bearish Engulfing
  if (
    isBullish(c1) && isBearish(c0) &&
    c0.open > c1.close &&
    c0.close < c1.open &&
    bodySize(c0) > bodySize(c1)
  ) {
    patterns.push({
      name: 'Bearish Engulfing', signal: 'BEARISH', strength: 'STRONG', candles: 2,
      emoji: '🔥',
      description: 'Strong bearish reversal — current candle completely engulfs previous bullish candle.',
    })
  }

  // Bullish Harami (inside bar, bullish)
  if (
    isBearish(c1) && isBullish(c0) &&
    c0.high < c1.open && c0.low > c1.close
  ) {
    patterns.push({
      name: 'Bullish Harami', signal: 'BULLISH', strength: 'MODERATE', candles: 2,
      emoji: '🤰',
      description: 'Inside bar after bearish candle — momentum slowing, potential reversal up.',
    })
  }

  // Bearish Harami
  if (
    isBullish(c1) && isBearish(c0) &&
    c0.high < c1.close && c0.low > c1.open
  ) {
    patterns.push({
      name: 'Bearish Harami', signal: 'BEARISH', strength: 'MODERATE', candles: 2,
      emoji: '🤰',
      description: 'Inside bar after bullish candle — momentum slowing, potential reversal down.',
    })
  }

  // Tweezer Tops (bearish)
  if (
    Math.abs(c0.high - c1.high) < candleRange(c0) * 0.05 &&
    isBullish(c1) && isBearish(c0)
  ) {
    patterns.push({
      name: 'Tweezer Top', signal: 'BEARISH', strength: 'MODERATE', candles: 2,
      emoji: '🪡',
      description: 'Double rejection at same high — strong resistance confirmed. Bearish reversal signal.',
    })
  }

  // Tweezer Bottoms (bullish)
  if (
    Math.abs(c0.low - c1.low) < candleRange(c0) * 0.05 &&
    isBearish(c1) && isBullish(c0)
  ) {
    patterns.push({
      name: 'Tweezer Bottom', signal: 'BULLISH', strength: 'MODERATE', candles: 2,
      emoji: '🪡',
      description: 'Double rejection at same low — strong support confirmed. Bullish reversal signal.',
    })
  }

  // ── Three candle patterns ─────────────────────────────────────────────────

  // Morning Star (bullish reversal)
  if (
    isBearish(c2) && bodySize(c2) > avgBody &&
    bodySize(c1) < avgBody * 0.5 &&
    isBullish(c0) && c0.close > (c2.open + c2.close) / 2
  ) {
    patterns.push({
      name: 'Morning Star', signal: 'BULLISH', strength: 'STRONG', candles: 3,
      emoji: '🌅',
      description: 'Classic 3-candle bullish reversal — big bearish, small doji, big bullish.',
    })
  }

  // Evening Star (bearish reversal)
  if (
    isBullish(c2) && bodySize(c2) > avgBody &&
    bodySize(c1) < avgBody * 0.5 &&
    isBearish(c0) && c0.close < (c2.open + c2.close) / 2
  ) {
    patterns.push({
      name: 'Evening Star', signal: 'BEARISH', strength: 'STRONG', candles: 3,
      emoji: '🌇',
      description: 'Classic 3-candle bearish reversal — big bullish, small doji, big bearish.',
    })
  }

  // Three White Soldiers (bullish continuation)
  if (
    isBullish(c2) && isBullish(c1) && isBullish(c0) &&
    c0.close > c1.close && c1.close > c2.close &&
    bodySize(c0) > avgBody && bodySize(c1) > avgBody && bodySize(c2) > avgBody
  ) {
    patterns.push({
      name: 'Three White Soldiers', signal: 'BULLISH', strength: 'STRONG', candles: 3,
      emoji: '⚔️',
      description: 'Three consecutive strong bullish candles — powerful uptrend continuation.',
    })
  }

  // Three Black Crows (bearish continuation)
  if (
    isBearish(c2) && isBearish(c1) && isBearish(c0) &&
    c0.close < c1.close && c1.close < c2.close &&
    bodySize(c0) > avgBody && bodySize(c1) > avgBody && bodySize(c2) > avgBody
  ) {
    patterns.push({
      name: 'Three Black Crows', signal: 'BEARISH', strength: 'STRONG', candles: 3,
      emoji: '🦅',
      description: 'Three consecutive strong bearish candles — powerful downtrend continuation.',
    })
  }

  // Summary
  const bullishCount = patterns.filter(p => p.signal === 'BULLISH').length
  const bearishCount = patterns.filter(p => p.signal === 'BEARISH').length
  const dominantSignal: PatternSignal =
    bullishCount > bearishCount ? 'BULLISH'
    : bearishCount > bullishCount ? 'BEARISH'
    : 'NEUTRAL'

  const summary = patterns.length === 0
    ? 'No significant patterns detected on current candle'
    : `${patterns.length} pattern${patterns.length > 1 ? 's' : ''} detected — ${bullishCount} bullish, ${bearishCount} bearish`

  return { patterns, dominantSignal, summary, bullishCount, bearishCount }
}

// ─── 4. SUPPORT & RESISTANCE AUTO-DETECTION ──────────────────────────────────

export interface SRLevel {
  price: number
  type: 'RESISTANCE' | 'SUPPORT'
  strength: number     // 1–5 (how many times touched)
  lastTouch: string    // candle timestamp
  distancePips: number // distance from current price in pips
  zone: { upper: number; lower: number }
}

export interface SRResult {
  levels: SRLevel[]
  nearestResistance: SRLevel | null
  nearestSupport: SRLevel | null
  currentPrice: number
  priceAction: string
}

export function detectSupportResistance(candles: Candle[], pair: string): SRResult {
  const pipSize = pair.includes('JPY') ? 0.01 : pair === 'XAU/USD' ? 0.5 : pair === 'XAG/USD' ? 0.05 : 0.0001
  const zonePips = pair === 'XAU/USD' ? 3 : pair.includes('JPY') ? 15 : 5
  const zoneSize = zonePips * pipSize

  const currentPrice = candles[candles.length - 1].close

  // Find swing highs and lows (pivot points)
  const pivots: Array<{ price: number; type: 'high' | 'low'; time: string }> = []

  for (let i = 2; i < candles.length - 2; i++) {
    const c = candles[i]
    // Swing high: higher than 2 candles on each side
    if (
      c.high > candles[i-1].high && c.high > candles[i-2].high &&
      c.high > candles[i+1].high && c.high > candles[i+2].high
    ) {
      pivots.push({ price: c.high, type: 'high', time: c.time })
    }
    // Swing low: lower than 2 candles on each side
    if (
      c.low < candles[i-1].low && c.low < candles[i-2].low &&
      c.low < candles[i+1].low && c.low < candles[i+2].low
    ) {
      pivots.push({ price: c.low, type: 'low', time: c.time })
    }
  }

  // Cluster nearby pivots into zones
  const clusters: Array<{ prices: number[]; type: 'high' | 'low'; times: string[] }> = []

  pivots.forEach(pivot => {
    const existing = clusters.find(
      cl => Math.abs(cl.prices[0] - pivot.price) < zoneSize && cl.type === pivot.type
    )
    if (existing) {
      existing.prices.push(pivot.price)
      existing.times.push(pivot.time)
    } else {
      clusters.push({ prices: [pivot.price], type: pivot.type, times: [pivot.time] })
    }
  })

  // Convert clusters to S/R levels
  const levels: SRLevel[] = clusters
    .filter(cl => cl.prices.length >= 1)
    .map(cl => {
      const avgPrice = cl.prices.reduce((a, b) => a + b, 0) / cl.prices.length
      const strength = Math.min(5, cl.prices.length)
      const distancePips = Math.abs(avgPrice - currentPrice) / pipSize

      return {
        price: +avgPrice.toFixed(pair === 'XAU/USD' ? 2 : pair.includes('JPY') ? 3 : 5),
        type: (cl.type === 'high' ? 'RESISTANCE' : 'SUPPORT') as SRLevel['type'],
        strength,
        lastTouch: cl.times[cl.times.length - 1],
        distancePips: +distancePips.toFixed(0),
        zone: {
          upper: +(avgPrice + zoneSize / 2).toFixed(5),
          lower: +(avgPrice - zoneSize / 2).toFixed(5),
        },
      }
    })
    .sort((a, b) => a.distancePips - b.distancePips)
    .slice(0, 8) // top 8 nearest levels

  const resistances = levels.filter(l => l.type === 'RESISTANCE' && l.price > currentPrice)
    .sort((a, b) => a.price - b.price)
  const supports = levels.filter(l => l.type === 'SUPPORT' && l.price < currentPrice)
    .sort((a, b) => b.price - a.price)

  const nearestResistance = resistances[0] || null
  const nearestSupport = supports[0] || null

  let priceAction = 'Price in open range'
  if (nearestResistance && nearestResistance.distancePips < 20) {
    priceAction = `⚠️ Approaching resistance at $${nearestResistance.price} (${nearestResistance.distancePips} pips away)`
  } else if (nearestSupport && nearestSupport.distancePips < 20) {
    priceAction = `✅ Near support at $${nearestSupport.price} (${nearestSupport.distancePips} pips away)`
  } else if (nearestResistance && nearestSupport) {
    priceAction = `Range: Support $${nearestSupport.price} → Resistance $${nearestResistance.price}`
  }

  return { levels, nearestResistance, nearestSupport, currentPrice, priceAction }
}

// ─── COMBINED ADVANCED ANALYSIS ──────────────────────────────────────────────

export interface AdvancedAnalysis {
  fibonacci: FibResult
  atr: ATRResult
  patterns: PatternResult
  supportResistance: SRResult
  overallBias: 'STRONGLY_BULLISH' | 'BULLISH' | 'NEUTRAL' | 'BEARISH' | 'STRONGLY_BEARISH'
  confluenceScore: number  // 0–100
  confluenceNotes: string[]
}

export function runAdvancedAnalysis(candles: Candle[], pair: string): AdvancedAnalysis {
  const fibonacci = calcFibonacci(candles)
  const atr       = calcATRIndicator(candles, pair)
  const patterns  = detectCandlePatterns(candles)
  const sr        = detectSupportResistance(candles, pair)

  // Score confluence
  let score = 50
  const notes: string[] = []

  // Fibonacci confluence
  const nearFib = fibonacci.levels.find(l =>
    Math.abs(l.price - atr.currentPrice) < atr.atr * 0.5
  )
  if (nearFib) {
    score += fibonacci.trend === 'BULLISH' ? 8 : -8
    notes.push(`Price near Fibonacci ${nearFib.label} level ($${nearFib.price.toFixed(4)})`)
  }

  // Candlestick pattern confluence
  if (patterns.bullishCount > 0) {
    score += patterns.bullishCount * 6
    notes.push(`${patterns.bullishCount} bullish pattern(s): ${patterns.patterns.filter(p => p.signal === 'BULLISH').map(p => p.name).join(', ')}`)
  }
  if (patterns.bearishCount > 0) {
    score -= patterns.bearishCount * 6
    notes.push(`${patterns.bearishCount} bearish pattern(s): ${patterns.patterns.filter(p => p.signal === 'BEARISH').map(p => p.name).join(', ')}`)
  }

  // S&R confluence
  if (sr.nearestSupport && sr.nearestSupport.distancePips < 15) {
    score += sr.nearestSupport.strength * 3
    notes.push(`Strong support nearby: $${sr.nearestSupport.price} (touched ${sr.nearestSupport.strength}x)`)
  }
  if (sr.nearestResistance && sr.nearestResistance.distancePips < 15) {
    score -= sr.nearestResistance.strength * 3
    notes.push(`Strong resistance nearby: $${sr.nearestResistance.price} (touched ${sr.nearestResistance.strength}x)`)
  }

  // ATR volatility note
  notes.push(`ATR volatility: ${atr.volatility} (${atr.suggestedSL}p SL / ${atr.suggestedTP2}p TP recommended)`)

  score = Math.max(0, Math.min(100, score))

  const overallBias =
    score >= 75 ? 'STRONGLY_BULLISH' :
    score >= 60 ? 'BULLISH' :
    score >= 40 ? 'NEUTRAL' :
    score >= 25 ? 'BEARISH' :
    'STRONGLY_BEARISH'

  return { fibonacci, atr, patterns, supportResistance: sr, overallBias, confluenceScore: score, confluenceNotes: notes }
}
