// app/api/analyze/route.ts
import { NextRequest, NextResponse } from 'next/server'
import Anthropic from '@anthropic-ai/sdk'
import { evaluateChecklist, buildIndicatorPrompt } from '@/lib/indicators'
import { getAdminClient } from '@/lib/supabase'
import { isMetal, goldAIContext } from '@/lib/metals'
import type { IndicatorValues } from '@/lib/indicators'
import type { StrategySettings } from '@/lib/supabase'

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const { pair, timeframe, direction, indicators, strategy, context, userId } = body

    const checklist = evaluateChecklist(indicators, direction, {
      newsInWindow: context.newsInWindow,
      signalStrength: context.signalStrength ?? 70,
      minStrength: strategy.minStrength,
      openPositions: context.openPositions,
      maxPositions: strategy.maxPositions,
      todayPL: context.todayPL,
      balance: context.accountBalance,
      maxLossPct: strategy.maxLoss,
    })

    // Build metal-specific context if applicable
    const metalCtx = isMetal(pair)
      ? goldAIContext(pair, indicators.currentPrice)
      : ''

    const systemPrompt = `You are a disciplined forex and metals trading analyst. The user follows these strategy rules:
- Trading style: ${strategy.style}
- Risk per trade: ${strategy.riskPct}%
- Max daily loss: ${strategy.maxLoss}%
- Max open positions: ${strategy.maxPositions}
- Min signal strength required: ${strategy.minStrength}%
- Take profit: ${strategy.tpPips} pips | Stop loss: ${strategy.slPips} pips
${isMetal(pair) ? `
IMPORTANT — THIS IS A METALS TRADE (${pair}):
- Gold and Silver have different pip values than forex
- Gold (XAU/USD): 1 pip = $0.10, pip value = $10 per standard lot
- Silver (XAG/USD): 1 pip = $0.01, pip value = $50 per standard lot  
- Gold is inversely correlated with USD strength
- Safe haven demand, real rates, and inflation are key gold drivers
- Always mention DXY trend and real interest rate environment in gold analysis
- Use price levels like $2000, $2100, $2300 as key psychological levels for gold
` : ''}
RULES:
1. Never recommend BUY or SELL if fewer than 6/8 checklist rules pass — return WAIT.
2. Always include a concrete risk note specific to this asset.
3. For metals, mention position sizing carefully — lots are worth more per pip.
4. Respond ONLY with valid JSON. No markdown, no explanation outside JSON.

JSON format:
{
  "direction": "BUY" | "SELL" | "WAIT",
  "confidence": 0-100,
  "entry_zone": { "low": number, "high": number },
  "reasons": ["reason1", "reason2", "reason3"],
  "risk_note": "string",
  "checklist_passed": number
}`

    const indicatorPrompt = buildIndicatorPrompt(pair, timeframe, indicators, checklist, direction)
    const userMsg = `${metalCtx ? metalCtx + '\n\n' : ''}${indicatorPrompt}\n\nProvide your trading recommendation as JSON.`

    let recommendation: any

    if (!process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY === 'your_anthropic_api_key_here') {
      recommendation = generateDemoRecommendation(indicators, checklist, direction, pair)
    } else {
      const message = await anthropic.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1000,
        system: systemPrompt,
        messages: [{ role: 'user', content: userMsg }],
      })
      const text = message.content.find(b => b.type === 'text')?.text || '{}'
      const clean = text.replace(/```json|```/g, '').trim()
      recommendation = JSON.parse(clean)
    }

    // Save signal to Supabase
    if (userId) {
      try {
        const admin = getAdminClient()
        await admin.from('signals').insert({
          user_id: userId, pair, timeframe,
          direction: recommendation.direction,
          confidence: recommendation.confidence,
          checklist_score: checklist.passCount,
          entry_zone_low: recommendation.entry_zone?.low,
          entry_zone_high: recommendation.entry_zone?.high,
          reasons: recommendation.reasons,
          risk_note: recommendation.risk_note,
          acted_on: false, outcome: 'PENDING',
          indicator_snapshot: indicators,
        })
      } catch { /* ignore */ }
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
  direction: 'BUY' | 'SELL',
  pair: string
) {
  const canTrade = checklist.canTrade
  const dir = canTrade ? direction : 'WAIT'
  const confidence = canTrade
    ? Math.floor(55 + checklist.passCount * 5 + (indicators.adx > 25 ? 5 : 0))
    : Math.floor(30 + checklist.passCount * 3)
  const price = indicators.currentPrice
  const isMetal_ = isMetal(pair)
  const halfSpread = isMetal_ ? 0.5 : price * 0.0005

  const goldReasons = canTrade ? [
    `${indicators.emaCrossSignal === 'BULLISH' ? 'Bullish' : 'Bearish'} EMA structure supports ${direction.toLowerCase()} momentum on ${pair}`,
    `RSI at ${indicators.rsi} — ${indicators.rsi < 50 ? 'room for further upside without being overextended' : 'approaching overbought, manage risk carefully'}`,
    `ADX at ${indicators.adx} confirms ${indicators.adxStrength.toLowerCase()} trend. ${isMetal_ ? 'Gold responding to macro drivers — monitor DXY for confirmation.' : ''}`,
  ] : [
    `Only ${checklist.passCount}/8 rules passed — insufficient confluence for ${pair} trade`,
    `${isMetal_ ? 'Gold requires strong macro alignment — wait for clearer USD direction' : 'Wait for better technical setup before entering'}`,
    'Patience is risk management — no trade is a valid position',
  ]

  return {
    direction: dir,
    confidence,
    entry_zone: { low: +(price - halfSpread).toFixed(isMetal_ ? 2 : 5), high: +(price + halfSpread).toFixed(isMetal_ ? 2 : 5) },
    reasons: goldReasons,
    risk_note: canTrade
      ? isMetal_
        ? `${pair} pip value is $${pair === 'XAU/USD' ? '10' : '50'}/lot — use smaller position size than forex. Monitor DXY for correlation.`
        : `Standard risk applies. ADX at ${indicators.adx} — ${indicators.adxStrength.toLowerCase()} trend.`
      : `Do not trade — only ${checklist.passCount}/8 rules met. Minimum 6 required.`,
    checklist_passed: checklist.passCount,
    checklist,
  }
}

// Helper to add advanced analysis to AI prompt (imported at call time to avoid circular deps)
export async function getAdvancedContext(pair: string, timeframe: string): Promise<string> {
  try {
    const base = process.env.NEXT_PUBLIC_SITE_URL || 'http://localhost:3000'
    const res = await fetch(`${base}/api/advanced?pair=${encodeURIComponent(pair)}&timeframe=${timeframe}`)
    if (!res.ok) return ''
    const { analysis } = await res.json()
    if (!analysis) return ''
    return `
ADVANCED ANALYSIS CONTEXT:
- Fibonacci trend: ${analysis.fibonacci?.trend}, price in zone: ${analysis.fibonacci?.currentPriceZone}
- ATR volatility: ${analysis.atr?.volatility}, suggested SL: ${analysis.atr?.suggestedSL} pips, TP: ${analysis.atr?.suggestedTP2} pips (1:2R)
- Candlestick patterns: ${analysis.patterns?.summary}
- ${analysis.patterns?.patterns?.map((p: any) => `${p.name} (${p.signal})`).join(', ') || 'None'}
- Nearest resistance: ${analysis.supportResistance?.nearestResistance?.price || 'none'} (${analysis.supportResistance?.nearestResistance?.distancePips || 0}p)
- Nearest support: ${analysis.supportResistance?.nearestSupport?.price || 'none'} (${analysis.supportResistance?.nearestSupport?.distancePips || 0}p)
- Overall confluence score: ${analysis.confluenceScore}/100 (${analysis.overallBias})
`.trim()
  } catch {
    return ''
  }
}
