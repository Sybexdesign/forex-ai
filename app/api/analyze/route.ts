// app/api/analyze/route.ts
import { NextRequest, NextResponse } from 'next/server'
import { evaluateChecklist, buildIndicatorPrompt } from '@/lib/indicators'
import { getAdminClient } from '@/lib/supabase'
import { isMetal, goldAIContext } from '@/lib/metals'
import { isIndex, getIndexSession, isIndexInSession, getPairDecimalPlaces } from '@/lib/instruments'
import { llmComplete, hasLlmKey } from '@/lib/llm'
import type { IndicatorValues } from '@/lib/indicators'
import type { StrategySettings } from '@/lib/supabase'

// ── Instrument classification ─────────────────────────────────────────────────

function isOil(pair: string): boolean {
  return pair.startsWith('BCO') || pair.startsWith('WTI')
}

function isCross(pair: string): boolean {
  if (!pair.includes('/') && !pair.includes('_')) return false
  const base = pair.split(/[/_]/)[0]
  const quote = pair.split(/[/_]/)[1]
  return !['USD', 'EUR', 'GBP', 'AUD', 'NZD', 'CAD', 'CHF'].slice(0, 1).includes(base) ||
    !['USD'].includes(quote)
}

// ── Per-instrument AI context ─────────────────────────────────────────────────

function getInstrumentContext(pair: string, price: number, strategy: StrategySettings): string {
  const dp = getPairDecimalPlaces(pair)

  if (isMetal(pair)) {
    return goldAIContext(pair, price)
  }

  if (isOil(pair)) {
    return `
OIL TRADING CONTEXT:
- Asset: Brent Crude Oil (BCO/USD)
- Current price: $${price.toFixed(dp)} per barrel
- 1 pip = $0.01 | Pip value ≈ $10 per lot
- TP: ${strategy.tpPips} pips | SL: ${strategy.slPips} pips
- Key drivers: OPEC+ production decisions, EIA/API inventory data, geopolitical risk (Middle East), USD strength, global demand outlook
- Peak session: London + NY overlap (13:00–17:00 UTC)
- Oil is highly event-driven — major moves on Wednesday EIA data release.
- Avoid holding through OPEC meetings without wide stops.`.trim()
  }

  if (isIndex(pair)) {
    const session = getIndexSession(pair)
    const inSession = isIndexInSession(pair)
    const INDEX_CONTEXT: Record<string, string> = {
      SPX500: `S&P 500 — 500 largest US companies. Driven by Fed policy, earnings, risk sentiment, economic data (NFP, CPI, GDP). Typical daily range: 30–80 points.`,
      NAS100: `NASDAQ 100 — tech-heavy index. Highly sensitive to interest rates and growth outlook. More volatile than SPX500. Typical daily range: 80–200 points.`,
      UK100:  `FTSE 100 — UK blue chips, heavy in energy/financials/miners. Influenced by GBP strength, Bank of England, commodity prices. Typical range: 30–80 pts.`,
      GER40:  `DAX 40 — German industrial index. Sensitive to ECB policy, eurozone data, global trade. Typical daily range: 80–180 points.`,
      JP225:  `Nikkei 225 — Japanese equities. Heavily influenced by JPY strength (inverse), BoJ policy, US market direction. Typical range: 150–400 points.`,
    }
    return `
INDEX TRADING CONTEXT:
- Asset: ${pair} — ${INDEX_CONTEXT[pair] ?? 'Equity index'}
- Current price: ${price.toFixed(dp)} points
- TP and SL are measured in POINTS, not pips. TP: ${strategy.tpPips} pts | SL: ${strategy.slPips} pts
- Market session: ${session ? `${session.name} — ${session.hours}` : 'Check broker hours'}
- Session status: ${inSession ? 'OPEN — good liquidity' : 'CLOSED — low liquidity, avoid new entries'}
- Key universal index drivers: central bank policy, risk sentiment, macro data surprises, earnings season
- Avoid trading indices outside market hours — wide spreads and thin order books.`.trim()
  }

  // JPY cross pairs — extra volatility context
  if (pair.includes('JPY') && !pair.startsWith('USD') && !pair.startsWith('EUR/JPY')) {
    return `
CROSS PAIR CONTEXT (${pair}):
- JPY crosses amplify the base currency move against JPY weakness/strength.
- GBP/JPY and similar pairs have wide daily ranges — use ATR-based stops.
- BoJ intervention risk: extreme JPY moves can reverse sharply.
- Monitor risk sentiment — JPY strengthens on risk-off flows.`.trim()
  }

  // Default: standard forex context (majors and other crosses)
  return `
FOREX CONTEXT (${pair}):
- Standard forex pair. TP: ${strategy.tpPips} pips | SL: ${strategy.slPips} pips.
- Analyse EMA, RSI, MACD, ADX, Bollinger Bands and S/R confluence.
- Consider session overlap liquidity and news risk.`.trim()
}

// ── Unit label for AI prompt ──────────────────────────────────────────────────

function getPipLabel(pair: string): string {
  return isIndex(pair) ? 'points' : 'pips'
}

// ── Main handler ──────────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const { pair, timeframe, direction, indicators, strategy, context, userId } = body

    // Block analysis on simulated data — broker feed unavailable
    if (indicators?.simulated === true) {
      return NextResponse.json({
        direction: 'WAIT',
        confidence: 0,
        reasons: ['Live market data required — broker feed unavailable or MT5 EA disconnected'],
        risk_note: '⚠ Simulated data detected. Reconnect your broker before analysing.',
        entry_zone: null,
        checklist: { passCount: 0, canTrade: false, items: [] },
      })
    }

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

    const pipLabel = getPipLabel(pair)
    const instrumentCtx = getInstrumentContext(pair, indicators.currentPrice, strategy)

    const systemPrompt = `You are a disciplined trading analyst covering forex, metals, commodities, and equity indices. The user follows these strategy rules:
- Trading style: ${strategy.style}
- Risk per trade: ${strategy.riskPct}%
- Max daily loss: ${strategy.maxLoss}%
- Max open positions: ${strategy.maxPositions}
- Min signal strength required: ${strategy.minStrength}%
- Take profit: ${strategy.tpPips} ${pipLabel} | Stop loss: ${strategy.slPips} ${pipLabel}

${instrumentCtx}

RULES:
1. Never recommend BUY or SELL if fewer than 6/8 checklist rules pass — return WAIT.
2. Always include a concrete risk note specific to this instrument.
3. Mention position sizing implications where relevant (indices and metals move more per point/pip than forex).
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

    const authToken = req.headers.get('Authorization')?.replace('Bearer ', '') || undefined
    const indicatorPrompt = buildIndicatorPrompt(pair, timeframe, indicators, checklist, direction)
    const advancedCtx = await getAdvancedContext(pair, timeframe, authToken)
    const userMsg = [
      advancedCtx,
      indicatorPrompt,
      'Provide your trading recommendation as JSON.',
    ].filter(Boolean).join('\n\n')

    let recommendation: any

    if (!hasLlmKey()) {
      recommendation = generateDemoRecommendation(indicators, checklist, direction, pair, strategy)
    } else {
      const { text } = await llmComplete({
        system:    systemPrompt,
        user:      userMsg,
        maxTokens: 1000,
      })
      const clean = (text || '{}').replace(/```json|```/g, '').trim()
      try {
        recommendation = JSON.parse(clean)
      } catch {
        recommendation = generateDemoRecommendation(indicators, checklist, direction, pair, strategy)
      }
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

// ── Demo recommendation (no API key) ─────────────────────────────────────────

function generateDemoRecommendation(
  indicators: IndicatorValues,
  checklist: ReturnType<typeof evaluateChecklist>,
  direction: 'BUY' | 'SELL',
  pair: string,
  strategy: StrategySettings,
) {
  const canTrade = checklist.canTrade
  const dir = canTrade ? direction : 'WAIT'
  const confidence = canTrade
    ? Math.floor(55 + checklist.passCount * 5 + (indicators.adx > 25 ? 5 : 0))
    : Math.floor(30 + checklist.passCount * 3)
  const price = indicators.currentPrice
  const dp = getPairDecimalPlaces(pair)
  const pipLabel = getPipLabel(pair)

  const halfSpread = isIndex(pair)
    ? price * 0.0001
    : isMetal(pair)
    ? (pair === 'XAU/USD' ? 0.5 : 0.03)
    : isOil(pair)
    ? 0.04
    : price * 0.0005

  const instrumentName = isIndex(pair) ? pair
    : isOil(pair) ? 'Brent Oil'
    : isMetal(pair) ? (pair === 'XAU/USD' ? 'Gold' : 'Silver')
    : pair

  const reasons = canTrade ? [
    `${indicators.emaCrossSignal === 'BULLISH' ? 'Bullish' : 'Bearish'} EMA structure supports ${direction.toLowerCase()} momentum on ${instrumentName}`,
    `RSI at ${indicators.rsi} — ${indicators.rsi < 50 ? 'room for further move without being overextended' : 'elevated RSI — manage position size carefully'}`,
    `ADX at ${indicators.adx} confirms ${indicators.adxStrength.toLowerCase()} trend strength${isIndex(pair) ? ` — monitor session close for ${instrumentName}` : ''}`,
  ] : [
    `Only ${checklist.passCount}/8 rules passed — insufficient confluence for ${instrumentName} trade`,
    `Wait for better ${pipLabel}-based technical setup before entering`,
    'Patience is risk management — no trade is a valid position',
  ]

  const riskNote = canTrade
    ? isIndex(pair)
      ? `${pair} moves in points — verify session is open and TP/SL (${strategy.tpPips}/${strategy.slPips} pts) are realistic for current daily range.`
      : isOil(pair)
      ? `Oil is highly event-driven. Ensure no major EIA/OPEC news before entry. SL: ${strategy.slPips} pips.`
      : isMetal(pair)
      ? `${pair} pip value is $${pair === 'XAU/USD' ? '10' : '50'}/lot — use smaller position than forex. Monitor DXY for correlation.`
      : `Standard risk: ${strategy.slPips} ${pipLabel} SL. ADX at ${indicators.adx} — ${indicators.adxStrength.toLowerCase()} trend.`
    : `Do not trade — only ${checklist.passCount}/8 rules met. Minimum 6 required.`

  return {
    direction: dir,
    confidence,
    entry_zone: {
      low:  +(price - halfSpread).toFixed(dp),
      high: +(price + halfSpread).toFixed(dp),
    },
    reasons,
    risk_note: riskNote,
    checklist_passed: checklist.passCount,
    checklist,
  }
}

// ── Advanced context (Fibonacci, S/R, ATR, patterns) ─────────────────────────

export async function getAdvancedContext(pair: string, timeframe: string, authToken?: string): Promise<string> {
  try {
    const { getMarketCandles } = await import('@/lib/marketdata')
    const { runAdvancedAnalysis } = await import('@/lib/advanced-indicators')

    const { candles } = await getMarketCandles(authToken, pair, timeframe, 200)

    const analysis = runAdvancedAnalysis(candles, pair)
    const patternList = analysis.patterns.patterns.length > 0
      ? analysis.patterns.patterns.map((p: any) => `${p.name} (${p.signal}, ${p.strength})`).join(', ')
      : 'None detected'

    const unit = getPipLabel(pair)

    return [
      'ADVANCED ANALYSIS CONTEXT:',
      `- Fibonacci trend: ${analysis.fibonacci.trend}, price zone: ${analysis.fibonacci.currentPriceZone}`,
      `- ATR volatility: ${analysis.atr.volatility} | ATR-suggested SL: ${analysis.atr.suggestedSL} ${unit} | ATR TP (1:2R): ${analysis.atr.suggestedTP2} ${unit}`,
      `- Candlestick patterns: ${analysis.patterns.summary}`,
      `  Patterns: ${patternList}`,
      `- Nearest resistance: ${analysis.supportResistance.nearestResistance?.price ?? 'none'} (${analysis.supportResistance.nearestResistance?.distancePips ?? 0} ${unit} away, touched ${analysis.supportResistance.nearestResistance?.strength ?? 0}x)`,
      `- Nearest support: ${analysis.supportResistance.nearestSupport?.price ?? 'none'} (${analysis.supportResistance.nearestSupport?.distancePips ?? 0} ${unit} away, touched ${analysis.supportResistance.nearestSupport?.strength ?? 0}x)`,
      `- S/R price action: ${analysis.supportResistance.priceAction}`,
      `- Confluence score: ${analysis.confluenceScore}/100 (${analysis.overallBias})`,
      `IMPORTANT: Factor ATR-suggested levels into your entry_zone and risk_note. Flag if nearest S/R blocks the TP target.`,
    ].join('\n')
  } catch {
    return ''
  }
}
