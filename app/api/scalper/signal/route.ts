// app/api/scalper/signal/route.ts
import { NextRequest, NextResponse } from 'next/server'
import Anthropic from '@anthropic-ai/sdk'
import { getAdminClient } from '@/lib/supabase'

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

type Strategy = 'Momentum' | 'Mean Reversion' | 'Breakout' | 'Order Flow'
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
Signal BUY: squeeze present AND price is ABOVE BB midline AND price is at or near BB upper band, MACD histogram positive, ADX > 20.
Signal SELL: squeeze present AND price is BELOW BB midline AND price is at or near BB lower band, MACD histogram negative, ADX > 20.
CRITICAL: Do NOT signal BUY if price is below BB midline — that is a breakdown, not a breakout.
CRITICAL: Do NOT signal SELL if price is above BB midline — that is a breakout, not a breakdown.
ADX 20–24 is a developing trend — valid for breakout entries but cap confidence at 70. ADX ≥ 25 is confirmed trend — full confidence range applies.
Use the "BB Width / Price %" and "BB Midline" values provided. Volume confirmation increases confidence.
Return HOLD if: no squeeze, ADX ≤ 20, price on the wrong side of BB midline, or direction is ambiguous.
Respond ONLY with valid JSON — no markdown, no prose.`,
  'Order Flow': `You are a scalping signal generator using ORDER FLOW strategy.
Signal BUY: buy pressure > 62%, RSI(14) below 45 (bullish divergence), high tick volume.
Signal SELL: sell pressure > 62% (buyPressure < 38%), RSI(14) above 55, high tick volume.
Wide spread or low volume reduces confidence significantly.
Return HOLD if pressure is neutral (38–62%).
Respond ONLY with valid JSON — no markdown, no prose.`,
}

function fallbackSignal(t: TickSnapshot, strategy: Strategy, pair: string): {
  direction: Direction; confidence: number; reasons: string[]
  entry: number; sl: number; tp: number; risk_note: string
} {
  let score = 50
  const reasons: string[] = []
  const slPips = t.atr * 1.5
  const tpPips = t.atr * 2.5

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
    const bbMid    = (t.bbUpper + t.bbLower) / 2
    const relWidth = t.price > 0 ? t.bbWidth / t.price : 1
    const squeeze  = relWidth < 0.004
    if (!squeeze)    { reasons.push('No BB squeeze — breakout condition not met') }
    if (t.adx <= 20) { reasons.push(`ADX ${t.adx.toFixed(1)} ≤ 20 — trend too weak for breakout`) }
    if (squeeze && t.adx > 20) {
      if (t.price > bbMid) {
        score += 20; reasons.push('BB squeeze above midline (bullish breakout setup)')
        if (t.price >= t.bbUpper) { score  += 8; reasons.push('Price at BB upper — breakout confirmed') }
        if (t.macdHistogram > 0)  { score  += 8; reasons.push('MACD positive — bullish momentum') }
      } else {
        score -= 20; reasons.push('BB squeeze below midline (bearish breakout setup)')
        if (t.price <= t.bbLower) { score  -= 8; reasons.push('Price at BB lower — breakdown confirmed') }
        if (t.macdHistogram < 0)  { score  -= 8; reasons.push('MACD negative — bearish momentum') }
      }
    }
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
  const direction: Direction = score >= 70 ? 'BUY' : score <= 30 ? 'SELL' : 'HOLD'
  const entry = t.price
  const sl = direction === 'BUY' ? entry - slPips : direction === 'SELL' ? entry + slPips : entry
  const tp = direction === 'BUY' ? entry + tpPips : direction === 'SELL' ? entry - tpPips : entry

  return {
    direction,
    confidence: Math.round(score),
    reasons: reasons.slice(0, 4),
    entry, sl, tp,
    risk_note: `Rule-based (AI offline). Spread: ${t.spreadPips.toFixed(1)} pips · ATR: ${t.atrPips.toFixed(1)} pips.`,
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

    const decimals = dp(pair)
    const pip      = pipSize(pair)
    const slPips   = t.atr * 1.5
    const tpPips   = t.atr * 2.5

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
      const systemPrompt = STRATEGY_PROMPTS[strategy] || STRATEGY_PROMPTS['Momentum']
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
        result      = JSON.parse(clean)
      } catch (e: any) {
        console.error('[scalper/signal] Claude error:', e?.status, e?.message)
        result   = fallbackSignal(t, strategy, pair)
        fallback = true
      }
    }

    // Query ML service in parallel with signal result (non-blocking)
    mlData = await queryMlService(body, pair, result.direction as Direction, result.confidence)

    // Ensure SL/TP are present
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
          indicator_snapshot: body,
        })
      } catch { /* non-critical */ }
    }

    return NextResponse.json({ ...result, fallback, ml: mlData })
  } catch (error: any) {
    console.error('[scalper/signal]', error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}
