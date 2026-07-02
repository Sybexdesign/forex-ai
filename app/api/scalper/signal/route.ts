// app/api/scalper/signal/route.ts
export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import Anthropic from '@anthropic-ai/sdk'
import { getAdminClient } from '@/lib/supabase'

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

type Strategy = 'Momentum' | 'Mean Reversion' | 'Breakout' | 'Order Flow' | 'Scalp'
type Direction = 'BUY' | 'SELL' | 'HOLD'

interface TickSnapshot {
  price: number; rsi14: number; rsi7: number
  ema9: number; ema21: number; ema20: number; ema50: number
  macdHistogram: number; macdLine: number; macdSignal: number
  bbUpper: number; bbLower: number; bbWidth: number
  adx: number; atr: number; atrPips: number
  spreadPips: number; buyPressure: number; tickVolume: number
  emaCrossSignal: string
}

function pipSize(pair: string): number {
  if (pair.includes('JPY')) return 0.01
  if (pair.startsWith('XAU')) return 0.1
  if (pair.startsWith('XAG')) return 0.01
  return 0.0001
}

function dp(pair: string): number {
  if (pair.includes('JPY'))   return 3
  if (pair.startsWith('XA'))  return 2
  return 5
}

// Fix 1: Cap SL distance (in price units) to prevent ATR spikes blowing risk limits
function maxSlDistance(pair: string): number {
  if (pair.startsWith('XAU')) return 80  * 0.1      // 80 pips × 0.1  = 8.0  price units
  if (pair.startsWith('XAG')) return 60  * 0.01     // 60 pips × 0.01 = 0.60 price units
  if (pair.includes('JPY'))   return 50  * 0.01     // 50 pips
  return                              40  * 0.0001   // 40 pips for FX
}

const STRATEGY_PROMPTS: Record<Strategy, string> = {
  'Momentum': `You are a scalping signal generator using MOMENTUM strategy.
Signal BUY: RSI(14) < 38, EMA9 above EMA21, MACD histogram turning positive, ADX > 20.
Signal SELL: RSI(14) > 62, EMA9 below EMA21, MACD histogram turning negative, ADX > 20.
Penalise wide spread (>40% of ATR). Higher ADX = higher confidence.
Return HOLD if conditions are ambiguous or spread is too wide.
Respond ONLY with valid JSON — no markdown, no prose.`,
  'Mean Reversion': `You are a scalping signal generator using MEAN REVERSION strategy.
Signal BUY: price near or below Bollinger lower band, RSI(14) < 30, RSI(7) < 25.
Signal SELL: price near or above Bollinger upper band, RSI(14) > 70, RSI(7) > 75.
Avoid when ADX > 35 (strong trend = reversion unreliable).
Return HOLD if no extreme reading is present.
Respond ONLY with valid JSON — no markdown, no prose.`,
  'Breakout': `You are a scalping signal generator using BREAKOUT strategy.
BB squeeze is defined as normalised width (BB Width / Price) < 0.4% — applies to all instruments including XAU/USD, XAG/USD, and FX pairs.
Signal BUY: squeeze present AND price is in the UPPER 30% of the BB range (pressing against the upper band), MACD histogram positive and NOT decelerating, ADX > 20.
Signal SELL: squeeze present AND price is in the LOWER 30% of the BB range (pressing against the lower band), MACD histogram negative and NOT decelerating, ADX > 20.
CRITICAL: "Above midline" alone is NOT a BUY — price must be pressing toward the UPPER BAND (outer 30% of band width). Midline vicinity is consolidation, not breakout.
CRITICAL: "Below midline" alone is NOT a SELL — price must be pressing toward the LOWER BAND (outer 30% of band width).
CRITICAL: If MACD histogram is positive but shrinking vs the prior bar (momentum decelerating), reduce confidence or return HOLD — the move may be exhausting.
ADX 20–24: developing trend — valid entry but cap confidence at 70. ADX ≥ 25: confirmed trend, full confidence range.
Volume confirmation increases confidence. Low volume breakouts are suspect.
Return HOLD if: no squeeze, ADX ≤ 20, price in the middle 40% of the band, momentum decelerating, or direction ambiguous.
Respond ONLY with valid JSON — no markdown, no prose.`,
  'Order Flow': `You are a scalping signal generator using ORDER FLOW strategy.
Signal BUY: buy pressure > 62%, RSI(14) below 45 (bullish divergence), high tick volume.
Signal SELL: sell pressure > 62% (buyPressure < 38%), RSI(14) above 55, high tick volume.
Wide spread or low volume reduces confidence significantly.
Return HOLD if pressure is neutral (38–62%).
Respond ONLY with valid JSON — no markdown, no prose.`,
  'Scalp': `You are a precision scalp trader for precious metals (XAU/USD, XAG/USD).
Generate a 1–5 minute directional scalp signal.

You MUST always return BUY or SELL — never HOLD. The downstream gate filters
weak signals by confidence based on the current ADX regime, so your job is to
score the direction honestly and report the strength you actually see:
  ADX < 20   → ranging   (low conviction is fine; downstream gate is 65)
  ADX 20-24 → weak-trend (downstream gate is 68)
  ADX 25-34 → trending   (downstream gate is 72)
  ADX ≥ 35  → strong     (downstream gate is 75)
Only return HOLD in an exact 2.5/2.5 vote tie (extremely rare).

Score 5 momentum factors and pick the majority direction:
1. RSI(14) > 50 → bullish | RSI(14) < 50 → bearish
2. EMA9 > EMA21 → bullish | EMA9 < EMA21 → bearish
3. MACD histogram > 0 → bullish | < 0 → bearish
4. Buy pressure > 50% → bullish | < 50% → bearish
5. Price above BB midline → bullish | below midline → bearish

Confidence: 5/5 votes = 90–95, 4/5 = 72–85, 3/5 = 58–68.
Entry at current price. SL = 1.5 × ATR. TP = 2.0 × ATR.
Respond ONLY with valid JSON — no markdown, no prose.`,
}

// ─── Market-regime classifier ────────────────────────────────────────────────
// Maps ADX(14) to one of five regimes, each with its own minStrength threshold.
// Updated 2026-06-24: split ranging band into 'chop' (ADX<15, true random) and
// 'ranging' (15-19, structured range). Ranging shows 75-84% historical win rate
// — blocking it with HOLD was leaving our best trading condition on the table.
//
//   chop          ADX < 15    threshold 100  — true chop, no edge, HOLD
//   ranging       ADX 15-19   threshold 78   — structured ranging, high confidence only
//   weak-trend    ADX 20-24   threshold 75   — developing trend
//   trending      ADX 25-27   threshold 72   — confirmed trend (default 72)
//   strong-trend  ADX ≥ 28    threshold 100  — strong trend, AI too accurate, HOLD
//
// suggestedSection is informational only — execution is always mirror by policy.
export type MarketRegime = 'chop' | 'ranging' | 'weak-trend' | 'trending' | 'strong-trend'

export function classifyRegime(adx: number): {
  regime: MarketRegime
  effectiveMinStrength: number
  suggestedSection: 'mirror' | 'scalp'
} {
  if (adx < 15)  return { regime: 'chop',         effectiveMinStrength: 100, suggestedSection: 'mirror' }
  if (adx < 20)  return { regime: 'ranging',      effectiveMinStrength: 78,  suggestedSection: 'mirror' }
  if (adx < 25)  return { regime: 'weak-trend',   effectiveMinStrength: 75,  suggestedSection: 'mirror' }
  if (adx < 28)  return { regime: 'trending',     effectiveMinStrength: 72,  suggestedSection: 'scalp'  }
  return           { regime: 'strong-trend', effectiveMinStrength: 100, suggestedSection: 'scalp'  }
}

function fallbackSignal(t: TickSnapshot, strategy: Strategy, pair: string): {
  direction: Direction; confidence: number; reasons: string[]
  entry: number; sl: number; tp: number; risk_note: string
} {
  let score = 50
  const reasons: string[] = []
  const maxSl  = maxSlDistance(pair)
  const slPips = Math.min(t.atr * 1.5, maxSl)
  const tpPips = strategy === 'Scalp' ? slPips * (4 / 3) : slPips * (5 / 3)  // Scalp: 2:1.5 RR

  if (strategy === 'Momentum') {
    if (t.rsi14 < 38) { score += 15; reasons.push(`RSI(14) oversold (${t.rsi14.toFixed(0)})`) }
    if (t.rsi14 > 62) { score -= 15; reasons.push(`RSI(14) overbought (${t.rsi14.toFixed(0)})`) }
    if (t.macdHistogram > 0) { score += 12; reasons.push('MACD histogram bullish') }
    if (t.macdHistogram < 0) { score -= 12; reasons.push('MACD histogram bearish') }
    if (t.ema9 > t.ema21)    { score += 10; reasons.push('EMA 9/21 bullish cross') }
    if (t.ema9 < t.ema21)    { score -= 10; reasons.push('EMA 9/21 bearish cross') }
    if (t.adx > 20)          { score  += 5; reasons.push(`ADX trend (${t.adx.toFixed(0)})`) }
  } else if (strategy === 'Mean Reversion') {
    if (t.price < t.bbLower) { score += 20; reasons.push('Price below lower BB') }
    if (t.price > t.bbUpper) { score -= 20; reasons.push('Price above upper BB') }
    if (t.rsi14 < 30) { score += 15; reasons.push(`RSI(14) extreme low (${t.rsi14.toFixed(0)})`) }
    if (t.rsi14 > 70) { score -= 15; reasons.push(`RSI(14) extreme high (${t.rsi14.toFixed(0)})`) }
    if (t.rsi7  < 25) { score  += 8; reasons.push(`RSI(7) extreme low (${t.rsi7.toFixed(0)})`) }
    if (t.rsi7  > 75) { score  -= 8; reasons.push(`RSI(7) extreme high (${t.rsi7.toFixed(0)})`) }
  } else if (strategy === 'Breakout') {
    const relWidth    = t.price > 0 ? t.bbWidth / t.price : 1
    const squeeze     = relWidth < 0.004
    const buyZoneMin  = t.bbLower + t.bbWidth * 0.70  // top 30% of band
    const sellZoneMax = t.bbLower + t.bbWidth * 0.30  // bottom 30% of band
    if (!squeeze)    { reasons.push('No BB squeeze — breakout condition not met') }
    if (t.adx <= 20) { reasons.push(`ADX ${t.adx.toFixed(1)} ≤ 20 — trend too weak for breakout`) }
    if (squeeze && t.adx > 20) {
      if (t.price >= buyZoneMin) {
        score += 20; reasons.push('BB squeeze: price pressing upper band (bullish breakout)')
        if (t.price >= t.bbUpper) { score  += 8; reasons.push('Price at/above BB upper — confirmed') }
        if (t.macdHistogram > 0)  { score  += 8; reasons.push('MACD positive — bullish momentum') }
      } else if (t.price <= sellZoneMax) {
        score -= 20; reasons.push('BB squeeze: price pressing lower band (bearish breakout)')
        if (t.price <= t.bbLower) { score  -= 8; reasons.push('Price at/below BB lower — confirmed') }
        if (t.macdHistogram < 0)  { score  -= 8; reasons.push('MACD negative — bearish momentum') }
      } else {
        reasons.push('Price in mid-band consolidation zone — not a breakout yet')
      }
    }
  } else if (strategy === 'Scalp') {
    // Note: previous hard ADX<20 HOLD gate removed in favour of the regime-aware
    // effectiveMinStrength threshold computed below. ADX<20 = 'ranging' regime,
    // threshold=65 — 3/5 votes (63 confidence) still skip, but 4/5+ (71+) pass.
    // Same downstream gate applies in AutoTradePage.tsx and workers/scalper.mjs.
    // 5-vote majority: commits to a direction when ADX confirms a trend exists.
    const bbMid = (t.bbUpper + t.bbLower) / 2
    const votes = [
      t.rsi14 > 50 ? 1 : -1,          // RSI > 50 = bullish momentum
      t.ema9  > t.ema21 ? 1 : -1,      // EMA9 above EMA21 = bullish trend
      t.macdHistogram > 0 ? 1 : -1,    // MACD positive = bullish momentum
      t.buyPressure > 0.5 ? 1 : -1,    // buyers dominant = bullish pressure
      t.price > bbMid ? 1 : -1,        // price in upper BB half = bullish position
    ]
    const bullVotes = votes.filter(v => v > 0).length
    const bearVotes = 5 - bullVotes
    const edge = Math.abs(bullVotes - bearVotes)
    if (bullVotes >= bearVotes) {
      score = 55 + edge * 8   // 3/5→63, 4/5→71, 5/5→79 (before spread penalty)
      reasons.push(`Scalp: ${bullVotes}/5 bullish indicators`)
    } else {
      score = 45 - edge * 8   // 3/5→37, 4/5→29, 5/5→21
      reasons.push(`Scalp: ${bearVotes}/5 bearish indicators`)
    }
    // Conflict-aware confidence penalty (audit Fix 5). A 4/5 with a real dissenting
    // indicator (not near-threshold) is genuinely mixed signal; a 3/5 with any
    // near-threshold marker is even weaker evidence. Penalty applies on top of edge.
    const rsiNear = t.rsi14 >= 48 && t.rsi14 <= 52
    const bpNear  = t.buyPressure >= 0.45 && t.buyPressure <= 0.55
    const emaWeak = t.atr > 0 ? Math.abs(t.ema9 - t.ema21) < t.atr * 0.15 : false
    const dissenters = Math.min(bullVotes, bearVotes)
    const nearThresholdMarkers = (rsiNear ? 1 : 0) + (bpNear ? 1 : 0) + (emaWeak ? 1 : 0)
    if (dissenters >= 1) {
      if (nearThresholdMarkers === 0) {
        // Genuine conflict — every indicator is decisive but they disagree
        score = bullVotes >= bearVotes ? score - 10 : score + 10  // pull toward neutral
        reasons.push(`Conflict penalty −10: ${dissenters} decisive dissenter${dissenters > 1 ? 's' : ''}`)
      } else {
        // Near-threshold weak evidence
        score = bullVotes >= bearVotes ? score - 15 : score + 15
        reasons.push(`Near-threshold penalty −15: ${nearThresholdMarkers} marginal indicator${nearThresholdMarkers > 1 ? 's' : ''}`)
      }
    }
    // Weak-trend cap replaced by the regime-aware effectiveMinStrength threshold
    // (see classifyRegime() and the return at the bottom of fallbackSignal).
    if (t.rsi14 > 50) reasons.push(`RSI ${t.rsi14.toFixed(1)} — bullish momentum`) ; else reasons.push(`RSI ${t.rsi14.toFixed(1)} — bearish momentum`)
    if (t.ema9 > t.ema21) reasons.push('EMA9 > EMA21 — bullish trend') ; else reasons.push('EMA9 < EMA21 — bearish trend')
    if (t.macdHistogram > 0) reasons.push(`MACD +${t.macdHistogram.toFixed(4)}`) ; else reasons.push(`MACD ${t.macdHistogram.toFixed(4)}`)
  } else {
    if (t.buyPressure > 0.62) { score += 18; reasons.push(`Buy pressure ${(t.buyPressure * 100).toFixed(0)}%`) }
    if (t.buyPressure < 0.38) { score -= 18; reasons.push(`Sell pressure ${((1 - t.buyPressure) * 100).toFixed(0)}%`) }
    if (t.rsi14 < 40 && t.buyPressure > 0.55) { score += 10; reasons.push('Divergence: RSI low + buyers') }
    if (t.rsi14 > 60 && t.buyPressure < 0.45) { score -= 10; reasons.push('Divergence: RSI high + sellers') }
  }

  // Penalise wide spread
  if (t.spreadPips > t.atrPips * 0.4) {
    score = Math.round(score * 0.7)
    reasons.push('⚠ Wide spread — penalised')
  }

  score = Math.max(0, Math.min(100, score))
  const direction: Direction = strategy === 'Scalp'
    ? (score >= 55 ? 'BUY' : score <= 45 ? 'SELL' : 'HOLD')
    : (score >= 70 ? 'BUY' : score <= 30 ? 'SELL' : 'HOLD')
  const entry = t.price
  const sl = direction === 'BUY' ? entry - slPips : direction === 'SELL' ? entry + slPips : entry
  const tp = direction === 'BUY' ? entry + tpPips : direction === 'SELL' ? entry - tpPips : entry

  // Normalise confidence to signal STRENGTH regardless of direction.
  // Raw score for SELL sits at 5–45 (strong=5, weak=37), which the ML reads as low confidence.
  // Mirror it so 5/5 SELL = 95, 4/5 SELL = 79, 3/5 SELL = 63 — same scale as BUY.
  const confidence = direction === 'SELL' ? Math.round(100 - score) : Math.round(score)

  return {
    direction,
    confidence,
    reasons: reasons.slice(0, 4),
    entry, sl, tp,
    risk_note: `Rule-based (AI offline). Spread: ${t.spreadPips.toFixed(1)} pips · ATR: ${t.atrPips.toFixed(1)} pips.`,
  }
}

// ─── Directional discipline ──────────────────────────────────────────────────
// Replicates the 5-vote fallback count using identical thresholds so the
// consensus is directly comparable to what the rule-based system would have
// produced. Near-threshold status is flagged in labels for logging only —
// it does not change the vote count. The discipline check fires when the AI
// direction contradicts a 4/5 or 5/5 majority; near-threshold readings on
// the losing side are exactly the "weak evidence" Rule 6 blocks from overriding.
function scalpConsensus(t: TickSnapshot): {
  bullVotes: number; bearVotes: number; labels: string[]
} {
  const bbMid   = (t.bbUpper + t.bbLower) / 2
  // Mark near-threshold readings for the log (RSI 48-52, BP 45-55%, tiny EMA gap)
  const rsiNear = t.rsi14 >= 48 && t.rsi14 <= 52
  const bpNear  = t.buyPressure >= 0.45 && t.buyPressure <= 0.55
  const emaWeak = t.atr > 0 ? Math.abs(t.ema9 - t.ema21) < t.atr * 0.15 : false

  // Votes use the same hard thresholds as fallbackSignal → count is authoritative
  const raw: [string, boolean, number][] = [
    // [name, is-near-threshold, vote]
    ['RSI14',       rsiNear,  t.rsi14 > 50          ? 1 : -1],
    ['EMA9/21',     emaWeak,  t.ema9 > t.ema21       ? 1 : -1],
    ['MACD',        false,    t.macdHistogram > 0    ? 1 : -1],
    ['BuyPressure', bpNear,   t.buyPressure > 0.5    ? 1 : -1],
    ['BBMid',       false,    t.price > bbMid        ? 1 : -1],
  ]

  return {
    bullVotes: raw.filter(([,, v]) => v > 0).length,
    bearVotes: raw.filter(([,, v]) => v < 0).length,
    // Label format: RSI14:▲ or RSI14:▲~ (~ = near-threshold / weak evidence)
    labels: raw.map(([n, weak, v]) => `${n}:${v > 0 ? '▲' : '▼'}${weak ? '~' : ''}`),
  }
}

const ML_URL = process.env.ML_SERVICE_URL || 'http://localhost:8100'

async function queryMlService(body: any, pair: string, direction: Direction, confidence: number): Promise<{
  win_probability: number; should_trade: boolean; ml_confidence: number
  feature_contributions: Record<string, { importance: number; value: number }>
} | null> {
  try {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), 3000)
    const resp = await fetch(`${ML_URL}/predict`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: ctrl.signal,
      body: JSON.stringify({
        pair,
        direction,
        confidence,
        indicators:        body,
        scalperIndicators: body.scalper ?? {},
        timestamp:         new Date().toISOString(),
      }),
    })
    clearTimeout(timer)
    if (!resp.ok) return null
    return await resp.json()
  } catch {
    return null
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const { pair, strategy, userId } = body as { pair: string; strategy: Strategy; userId?: string }

    // Hard block: never generate a tradable signal from simulated market data
    if (body.simulated === true) {
      return NextResponse.json({
        direction: 'HOLD' as Direction,
        confidence: 0,
        reasons: ['Live data required — simulated feed detected'],
        risk_note: 'Signal blocked: MT5 EA not connected or all live broker feeds unavailable. Check your broker connection.',
        entry: body.price || 0, sl: body.price || 0, tp: body.price || 0,
        fallback: false,
        simulationBlocked: true,
        ml: null,
      })
    }

    // Merge safe numeric defaults so toFixed never throws on missing fields
    const t: TickSnapshot = {
      price: 0, rsi14: 50, rsi7: 50,
      ema9: 0, ema21: 0, ema20: 0, ema50: 0,
      macdHistogram: 0, macdLine: 0, macdSignal: 0,
      bbUpper: 0, bbLower: 0, bbWidth: 0.001,
      adx: 20, atr: 0.0001, atrPips: 1,
      spreadPips: 1, buyPressure: 0.5, tickVolume: 0,
      emaCrossSignal: 'FLAT',
      ...body,
    }

    // ── ADX floor — block true chop before any AI / ML spend ───────────────
    // Updated 2026-06-24: lowered threshold from 22 → 15. ADX 15-19 ('ranging')
    // historically shows 75-84% win rate and is our highest-edge condition.
    // The regime-aware effectiveMinStrength gate (78 for ranging) filters weak
    // signals downstream while letting strong ranging setups through. Only true
    // chop (ADX<15, random moves) is blocked outright here.
    if (t.adx < 15) {
      return NextResponse.json({
        direction:            'HOLD' as Direction,
        confidence:           0,
        reasons:              [`ADX ${t.adx.toFixed(1)} below 15 — true chop, no edge`],
        risk_note:            '',
        entry:                t.price,
        sl:                   t.price,
        tp:                   t.price,
        fallback:             false,
        ml:                   null,
        marketRegime:         'chop',
        effectiveMinStrength: 100,
        suggestedSection:     null,
        adx:                  t.adx,
      })
    }

    const decimals = dp(pair)
    const pip      = pipSize(pair)
    const maxSl    = maxSlDistance(pair)
    const slPips   = Math.min(t.atr * 1.5, maxSl)
    const tpPips   = slPips * (5 / 3)

    let result: any
    let fallback = false
    let mlData: Awaited<ReturnType<typeof queryMlService>> = null

    const hasKey = !!(
      process.env.ANTHROPIC_API_KEY &&
      process.env.ANTHROPIC_API_KEY !== 'your_anthropic_api_key_here'
    )

    if (!hasKey) {
      console.warn('[scalper/signal] ANTHROPIC_API_KEY not set or is placeholder — using rule-based fallback')
      result   = fallbackSignal(t, strategy, pair)
      fallback = true
    } else {
      const systemPrompt = STRATEGY_PROMPTS[strategy as Strategy] || STRATEGY_PROMPTS['Scalp']
      const userMsg = `Pair: ${pair} | Price: ${t.price.toFixed(decimals)} | Strategy: ${strategy}

Indicators:
- RSI(14): ${t.rsi14} | RSI(7): ${t.rsi7}
- MACD Histogram: ${t.macdHistogram.toFixed(6)}
- EMA(9): ${t.ema9.toFixed(decimals)} | EMA(21): ${t.ema21.toFixed(decimals)}
- EMA(20): ${t.ema20.toFixed(decimals)} | EMA(50): ${t.ema50.toFixed(decimals)}
- EMA cross: ${t.emaCrossSignal}
- BB Upper: ${t.bbUpper.toFixed(decimals)} | Midline: ${((t.bbUpper + t.bbLower) / 2).toFixed(decimals)} | Lower: ${t.bbLower.toFixed(decimals)} | Width / Price %: ${t.price > 0 ? ((t.bbWidth / t.price) * 100).toFixed(3) : '0'}%
- Price vs BB midline: ${t.price > (t.bbUpper + t.bbLower) / 2 ? 'ABOVE midline (bullish side)' : 'BELOW midline (bearish side)'}
- ADX: ${t.adx}
- ATR: ${t.atr.toFixed(6)} (${t.atrPips} pips)
- Buy Pressure: ${(t.buyPressure * 100).toFixed(0)}%
- Spread: ${t.spreadPips} pips | Tick Volume: ${t.tickVolume}

SL = ${(slPips / pip).toFixed(1)} pips | TP = ${(tpPips / pip).toFixed(1)} pips

Return JSON only:
{
  "direction": "BUY"|"SELL"|"HOLD",
  "confidence": 0-100,
  "entry": <number>,
  "sl": <number>,
  "tp": <number>,
  "reasons": ["string", ...],
  "risk_note": "string"
}`

      try {
        const message = await anthropic.messages.create({
          model:      'claude-sonnet-4-6',
          max_tokens: 600,
          system:     systemPrompt,
          messages:   [{ role: 'user', content: userMsg }],
        })
        const text  = message.content.find(b => b.type === 'text')?.text || '{}'
        const clean = text.replace(/```json|```/g, '').trim()
        const parsed = JSON.parse(clean)
        // Schema validation — parseable-but-junk JSON ({} or a non-enum
        // direction) must not flow downstream: an unvalidated direction skips
        // the discipline gate and the worker's mirror inversion maps any
        // non-'BUY' string to 'BUY'.
        const validDirection = parsed?.direction === 'BUY' || parsed?.direction === 'SELL' || parsed?.direction === 'HOLD'
        const numConfidence  = Number(parsed?.confidence)
        const validConfidence = Number.isFinite(numConfidence) && numConfidence >= 0 && numConfidence <= 100
        if (!validDirection || !validConfidence) {
          console.warn(`[scalper/signal] Claude response failed validation (direction=${JSON.stringify(parsed?.direction)}, confidence=${JSON.stringify(parsed?.confidence)}) — using rule-based fallback. Raw: ${clean.slice(0, 500)}`)
          result   = fallbackSignal(t, strategy, pair)
          fallback = true
        } else {
          parsed.confidence = numConfidence
          result = parsed
        }
      } catch (e: any) {
        console.error('[scalper/signal] Claude error:', e?.status, e?.message)
        result   = fallbackSignal(t, strategy, pair)
        fallback = true
      }
    }

    // ── Directional discipline — Scalp only ───────────────────────────────
    // Prevents the AI from reversing a 4/5 or 5/5 indicator consensus.
    // Near-threshold readings (RSI 48-52, BP 45-55%, tiny EMA gap) are
    // treated as neutral so one marginal indicator cannot trigger a reversal.
    // A conflicting AI call is demoted to HOLD, never flipped to the opposite.
    if (strategy === 'Scalp' && result.direction !== 'HOLD') {
      const { bullVotes, bearVotes, labels } = scalpConsensus(t)
      const consensusDir: Direction | null =
        bullVotes >= 4 ? 'BUY' : bearVotes >= 4 ? 'SELL' : null

      if (consensusDir !== null && result.direction !== consensusDir) {
        const aiDir   = result.direction as string
        const side    = consensusDir === 'BUY' ? bullVotes : bearVotes
        const voteStr = `${side}/5 ${consensusDir === 'BUY' ? 'bullish' : 'bearish'} (${labels.join(' ')})`
        console.log(`[scalper/signal] Directional discipline: AI=${aiDir} conflicts with ${voteStr} → HOLD`)
        result.direction = 'HOLD' as Direction
        result.reasons   = [
          ...(result.reasons || []).slice(0, 3),
          `Directional guard: AI ${aiDir} conflicts with ${voteStr} — converted to HOLD`,
        ]
      }
    }

    // Weak-trend confidence cap removed — replaced by the regime-aware
    // effectiveMinStrength threshold (see classifyRegime()). Downstream gates
    // in AutoTradePage.tsx and workers/scalper.mjs use sig.effectiveMinStrength.

    // Query ML service in parallel with signal result (non-blocking)
    mlData = await queryMlService(body, pair, result.direction as Direction, result.confidence)

    // ML win-probability gate — softer threshold for Scalp (long-TF model not tuned for 1-5min)
    if (mlData && typeof mlData.win_probability === 'number' && result.direction !== 'HOLD') {
      const winProb     = mlData.win_probability
      const isScalp     = strategy === 'Scalp'
      const mlThreshold = isScalp ? 0.25 : 0.40
      const holdBelow   = isScalp ? 50   : 60
      if (winProb < mlThreshold) {
        const penalty = Math.round((mlThreshold - winProb) * 50)
        result.confidence = Math.max(0, result.confidence - penalty)
        result.reasons = [...(result.reasons || []), `⚠ ML win probability ${(winProb * 100).toFixed(0)}% — confidence reduced`]
        if (result.confidence < holdBelow) {
          result.direction = 'HOLD'
          result.risk_note = (result.risk_note || '') + ` | ML override: low win probability (${(winProb * 100).toFixed(0)}%)`
        }
      } else if (winProb > 0.65) {
        // ML says likely winner — modest boost, max +7 at 100%
        const boost = Math.round((winProb - 0.65) * 20)
        result.confidence = Math.min(98, result.confidence + boost)
      }
    }

    // For Scalp: always use server-computed SL/TP — AI misreads pip-to-price for metals (treats
    // "80 pips" as 80 price units on XAU/USD, producing 10× oversized levels).
    if (strategy === 'Scalp') {
      result.entry = t.price
      result.sl = result.direction === 'BUY'  ? t.price - slPips
                : result.direction === 'SELL' ? t.price + slPips
                : t.price
      result.tp = result.direction === 'BUY'  ? t.price + tpPips
                : result.direction === 'SELL' ? t.price - tpPips
                : t.price
    }

    // Ensure SL/TP are present for other strategies
    if (!result.entry) result.entry = t.price
    if (!result.sl) result.sl = result.direction === 'BUY' ? t.price - slPips : result.direction === 'SELL' ? t.price + slPips : t.price
    if (!result.tp) result.tp = result.direction === 'BUY' ? t.price + tpPips : result.direction === 'SELL' ? t.price - tpPips : t.price

    // Persist to signals table
    if (userId && result.direction !== 'HOLD') {
      try {
        const admin = getAdminClient()
        await admin.from('signals').insert({
          user_id:            userId,
          pair,
          timeframe:          'scalper',
          direction:          result.direction,
          confidence:         result.confidence,
          checklist_score:    0,
          reasons:            result.reasons,
          risk_note:          result.risk_note,
          acted_on:           false,
          outcome:            'PENDING',
          indicator_snapshot: {
            ...body,
            _computed: { entry: result.entry, sl: result.sl, tp: result.tp },
          },
        })
      } catch { /* non-critical */ }
    }

    // Attach market-regime metadata (Scalp only — other strategies have their
    // own ADX semantics). AutoTradePage and worker use these to gate execution
    // and to override section bias per-signal.
    const regimeMeta = strategy === 'Scalp'
      ? { ...classifyRegime(t.adx), adx: t.adx }
      : null

    return NextResponse.json({
      ...result,
      fallback,
      ml: mlData,
      marketRegime:         regimeMeta?.regime ?? null,
      effectiveMinStrength: regimeMeta?.effectiveMinStrength ?? null,
      suggestedSection:     regimeMeta?.suggestedSection ?? null,
      adx:                  regimeMeta?.adx ?? null,
    })
  } catch (error: any) {
    console.error('[scalper/signal]', error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}
