// app/api/analyze/route.ts
import { NextRequest, NextResponse } from 'next/server'
import Anthropic from '@anthropic-ai/sdk'
import { evaluateChecklist, buildIndicatorPrompt } from '@/lib/indicators'
import { getAdminClient } from '@/lib/supabase'
import type { IndicatorValues } from '@/lib/indicators'
import type { StrategySettings } from '@/lib/supabase'

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

export interface AnalyzeRequest {
  pair: string
  timeframe: string
  direction: 'BUY' | 'SELL'
  indicators: IndicatorValues
  strategy: StrategySettings
  context: {
    newsInWindow: boolean
    newsEvent?: string
    signalStrength: number
    openPositions: number
    accountBalance: number
    todayPL: number
  }
  userId?: string
}

export interface AnalyzeResponse {
  direction: 'BUY' | 'SELL' | 'WAIT'
  confidence: number
  entry_zone: { low: number; high: number }
  reasons: string[]
  risk_note: string
  checklist_passed: number
  checklist: ReturnType<typeof evaluateChecklist>
}

export async function POST(req: NextRequest) {
  try {
    const body: AnalyzeRequest = await req.json()
    const { pair, timeframe, direction, indicators, strategy, context, userId } = body

    // Evaluate checklist
    const checklist = evaluateChecklist(indicators, direction, {
      newsInWindow: context.newsInWindow,
      signalStrength: context.signalStrength,
      minStrength: strategy.minStrength,
      openPositions: context.openPositions,
      maxPositions: strategy.maxPositions,
      todayPL: context.todayPL,
      balance: context.accountBalance,
      maxLossPct: strategy.maxLoss,
    })

    const systemPrompt = `You are a disciplined forex trading analyst assistant. The user follows these strategy rules:
- Trading style: ${strategy.style}
- Risk per trade: ${strategy.riskPct}%
- Max daily loss: ${strategy.maxLoss}%
- Max open positions: ${strategy.maxPositions}
- Min signal strength required: ${strategy.minStrength}%
- Take profit: ${strategy.tpPips} pips | Stop loss: ${strategy.slPips} pips
- Session hours: ${strategy.sessionStart}:00–${strategy.sessionEnd}:00 UTC

Your job is to evaluate the current market conditions and entry checklist, then give a specific, direct recommendation.
CRITICAL RULES:
1. Never recommend BUY or SELL if fewer than 6/8 checklist rules are met — return WAIT instead.
2. Always include a concrete risk note.
3. Be specific about price levels.
4. Respond ONLY with valid JSON — no markdown, no explanation outside the JSON.

JSON format required:
{
  "direction": "BUY" | "SELL" | "WAIT",
  "confidence": 0-100,
  "entry_zone": { "low": number, "high": number },
  "reasons": ["reason1", "reason2", "reason3"],
  "risk_note": "string",
  "checklist_passed": number
}`

    const userMsg = buildIndicatorPrompt(pair, timeframe, indicators, checklist, direction)
      + `\n\nBased on the above analysis, provide your trading recommendation as JSON.`

    let recommendation: AnalyzeResponse

    if (!process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY === 'your_anthropic_api_key_here') {
      // Fallback demo recommendation
      recommendation = generateDemoRecommendation(indicators, checklist, direction)
    } else {
      const message = await anthropic.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1000,
        system: systemPrompt,
        messages: [{ role: 'user', content: userMsg }],
      })

      const text = message.content.find(b => b.type === 'text')?.text || '{}'
      const clean = text.replace(/```json|```/g, '').trim()
      const parsed = JSON.parse(clean)
      recommendation = { ...parsed, checklist }
    }

    // Save signal to Supabase if userId provided
    if (userId) {
      try {
        const admin = getAdminClient()
        await admin.from('signals').insert({
          user_id: userId,
          pair,
          timeframe,
          direction: recommendation.direction,
          confidence: recommendation.confidence,
          checklist_score: checklist.passCount,
          entry_zone_low: recommendation.entry_zone?.low,
          entry_zone_high: recommendation.entry_zone?.high,
          reasons: recommendation.reasons,
          risk_note: recommendation.risk_note,
          acted_on: false,
          outcome: 'PENDING',
          indicator_snapshot: indicators,
        })
      } catch (e) {
        console.error('[analyze] signal save failed:', e)
      }
    }

    return NextResponse.json({ ...recommendation, checklist })
  } catch (error: any) {
    console.error('[analyze]', error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}

function generateDemoRecommendation(
  indicators: IndicatorValues,
  checklist: ReturnType<typeof evaluateChecklist>,
  direction: 'BUY' | 'SELL'
): AnalyzeResponse {
  const canTrade = checklist.canTrade
  const dir = canTrade ? direction : 'WAIT'
  const confidence = canTrade
    ? Math.floor(55 + checklist.passCount * 5 + (indicators.adx > 25 ? 5 : 0))
    : Math.floor(30 + checklist.passCount * 3)

  const price = indicators.currentPrice
  const halfSpread = price * 0.0005

  return {
    direction: dir as 'BUY' | 'SELL' | 'WAIT',
    confidence,
    entry_zone: {
      low: +(price - halfSpread).toFixed(5),
      high: +(price + halfSpread).toFixed(5),
    },
    reasons: canTrade ? [
      `${indicators.emaCrossSignal === 'BULLISH' ? 'Bullish' : 'Bearish'} EMA cross confirms ${direction.toLowerCase()} momentum with EMA20 ${indicators.emaCrossed ? 'above' : 'below'} EMA50`,
      `RSI at ${indicators.rsi} in neutral zone — room to run without being overextended`,
      `ADX at ${indicators.adx} confirms ${indicators.adxStrength.toLowerCase()} trend strength supporting the setup`,
    ] : [
      `Only ${checklist.passCount}/8 checklist rules passed — setup does not meet minimum threshold`,
      `${!checklist.rsiNeutral ? `RSI at ${indicators.rsi} is in ${indicators.rsiZone.toLowerCase()} territory — poor entry timing` : `MACD crossover not confirmed in ${direction.toLowerCase()} direction`}`,
      `Wait for price to pull back to key levels before considering entry`,
    ],
    risk_note: canTrade
      ? (checklist.noNews ? `Standard risk applies. ADX at ${indicators.adx} — ${indicators.adxStrength.toLowerCase()} trend.` : `News risk active — reduce position size by 50% or skip this trade.`)
      : `Do not trade — ${checklist.passCount}/8 rules met, minimum 6 required.`,
    checklist_passed: checklist.passCount,
    checklist,
  } as any
}
