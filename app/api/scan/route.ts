// app/api/scan/route.ts
// Scans all watchlist pairs in parallel, runs AI analysis,
// returns only actionable signals with full accuracy filters.

import { NextRequest, NextResponse } from 'next/server'
import { getMarketCandles } from '@/lib/marketdata'
import { calculateIndicators, evaluateChecklist, buildIndicatorPrompt } from '@/lib/indicators'
import Anthropic from '@anthropic-ai/sdk'
import type { StrategySettings } from '@/lib/supabase'
import { alertNewSignal, alertScanComplete } from '@/lib/telegram'
import { calcStandardPositionSize, getPipValue, getPipValuePerLot } from '@/lib/brokers/interface'
import { detectSupportResistance, calcATRIndicator } from '@/lib/advanced-indicators'
import { isIndexInSession, getPairDecimalPlaces } from '@/lib/instruments'

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

export interface ScanSignal {
  id: string
  pair: string
  timeframe: string
  direction: 'BUY' | 'SELL'
  confidence: number
  checklistScore: number
  entryZone: { low: number; high: number }
  reasons: string[]
  riskNote: string
  currentPrice: number
  scannedAt: string
  expiresAt: string
  indicators: any
  simulated?: boolean
  htfConfirmed?: boolean   // higher-timeframe trend confirmed
}

// Tighter expiry for short timeframes — a 1m signal is stale after 2 candles
const TF_EXPIRY_MS: Record<string, number> = {
  '1m':   2 * 60_000,    // 2 min  (was 5 — stale after 2 candles)
  '3m':   5 * 60_000,    // 5 min  (was 10)
  '5m':   15 * 60_000,
  '15m':  30 * 60_000,
  '30m':  60 * 60_000,
  '1H':   120 * 60_000,
  '4H':   360 * 60_000,
  'Daily': 1440 * 60_000,
}

// Per-timeframe thresholds
function tfConfig(timeframe: string) {
  const isShort  = ['1m', '3m', '5m'].includes(timeframe)
  const isMicro  = ['1m', '3m'].includes(timeframe)
  return {
    minChecklistPass: isShort ? 5 : 6,     // 1m/3m/5m allow one extra miss (noisier)
    atrGuardMult:     isShort ? 3 : 2,     // short TF ATR is naturally small
    minConfidence:    isMicro ? 55 : 60,   // slightly lower bar for micro scalps
    htfFrame:         isMicro ? '15m' : null, // multi-TF check for 1m/3m
    htfCandleCount:   60,
  }
}

// Fetch candles using the smart market-data chain (native broker → OANDA → Capital → Sim)
async function getCandles(authToken: string | undefined, pair: string, tf: string, count: number) {
  const result = await getMarketCandles(authToken, pair, tf, count)
  return { candles: result.candles, simulated: result.simulated }
}

// Higher-timeframe trend confirmation: returns true if HTF trend agrees with direction
async function confirmHTF(authToken: string | undefined, pair: string, htfFrame: string, direction: 'BUY' | 'SELL'): Promise<boolean> {
  try {
    const { candles } = await getCandles(authToken, pair, htfFrame, 60)
    const ind = calculateIndicators(candles)
    const htfBullish = ind.emaCrossed && ind.macdHistogram > 0
    const htfBearish = !ind.emaCrossed && ind.macdHistogram < 0
    return direction === 'BUY' ? htfBullish : htfBearish
  } catch {
    return true
  }
}

// Scan a single pair — returns a ScanSignal or null
async function scanPair(
  pair: string,
  timeframe: string,
  authToken: string | undefined,
  strategy: StrategySettings,
  context: { newsInWindow: boolean; openPositions: number; todayPL: number; accountBalance: number },
  cfg: ReturnType<typeof tfConfig>,
): Promise<ScanSignal | null> {
  // Skip index instruments outside their market session
  if (!isIndexInSession(pair)) return null

  // 1. Fetch candles for this timeframe
  const { candles, simulated } = await getCandles(authToken, pair, timeframe, 200)

  // 2. Calculate indicators
  const indicators = calculateIndicators(candles)

  // 3. EMA + MACD must agree on direction
  const emaDir:  'BUY' | 'SELL' = indicators.emaCrossed      ? 'BUY' : 'SELL'
  const macdDir: 'BUY' | 'SELL' = indicators.macdHistogram > 0 ? 'BUY' : 'SELL'
  if (emaDir !== macdDir) return null

  const direction = emaDir

  // 3b. RSI must not be extreme against direction
  // BUY when RSI overbought (>75) is a low-probability entry; same for SELL at oversold (<25)
  if (direction === 'BUY'  && indicators.rsi > 75) return null
  if (direction === 'SELL' && indicators.rsi < 25) return null

  // 3c. ATR volatility guard — TF-aware multiplier
  const atrResult = calcATRIndicator(candles, pair)
  if (atrResult.suggestedSL > strategy.slPips * cfg.atrGuardMult) return null

  // 4. Multi-timeframe confirmation for 1m / 3m
  let htfConfirmed = true
  if (cfg.htfFrame) {
    htfConfirmed = await confirmHTF(authToken, pair, cfg.htfFrame, direction)
    if (!htfConfirmed) return null
  }

  // 5. Checklist — TF-aware minimum pass count
  const checklist = evaluateChecklist(indicators, direction, {
    newsInWindow:  context.newsInWindow,
    signalStrength: indicators.adx,
    minStrength:   strategy.minStrength,
    openPositions: context.openPositions,
    maxPositions:  strategy.maxPositions,
    todayPL:       context.todayPL,
    balance:       context.accountBalance,
    maxLossPct:    strategy.maxLoss,
  })

  if (!checklist.canTrade || checklist.passCount < cfg.minChecklistPass) return null

  // 6. S/R room check — TP must have 70% clear runway before nearest S/R
  const pip      = getPipValue(pair)
  const srResult = detectSupportResistance(candles, pair)
  if (direction === 'BUY' && srResult.nearestResistance) {
    const roomPips = (srResult.nearestResistance.price - indicators.currentPrice) / pip
    if (roomPips < strategy.tpPips * 0.7) return null
  }
  if (direction === 'SELL' && srResult.nearestSupport) {
    const roomPips = (indicators.currentPrice - srResult.nearestSupport.price) / pip
    if (roomPips < strategy.tpPips * 0.7) return null
  }

  // 7. AI analysis
  let rec: any = null
  const hasKey = !!(process.env.ANTHROPIC_API_KEY &&
    process.env.ANTHROPIC_API_KEY !== 'your_anthropic_api_key_here')

  if (hasKey) {
    const isShort = ['1m', '3m', '5m'].includes(timeframe)
    const systemPrompt = `You are a disciplined forex scalping analyst. Respond ONLY with valid JSON — no markdown.
JSON format: {"direction":"BUY"|"SELL"|"WAIT","confidence":0-100,"entry_zone":{"low":number,"high":number},"reasons":["r1","r2","r3"],"risk_note":"string","checklist_passed":number}
${isShort ? `You are analysing a SHORT timeframe (${timeframe}). Signals must be crisp — momentum and immediate price action matter more than lagging indicators. Require tight confluence.` : ''}
Rules: Only recommend BUY/SELL if ${cfg.minChecklistPass}+ of 8 checklist rules pass. Otherwise return WAIT.`

    try {
      const prompt = buildIndicatorPrompt(pair, timeframe, indicators, checklist, direction)
      const msg = await anthropic.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 600,
        system: systemPrompt,
        messages: [{ role: 'user', content: prompt }],
      })
      const text = msg.content.find(b => b.type === 'text')?.text || '{}'
      rec = JSON.parse(text.replace(/```json|```/g, '').trim())
    } catch { /* fall through to null */ }
  }

  if (!rec || rec.direction === 'WAIT' || (rec.confidence ?? 0) < cfg.minConfidence) return null

  // 8. Build signal
  const now        = new Date()
  const sign       = rec.direction === 'BUY' ? 1 : -1
  const dp         = getPairDecimalPlaces(pair)
  const lots       = calcStandardPositionSize(context.accountBalance, strategy.riskPct, strategy.slPips, pair)
  const tpPrice    = +(indicators.currentPrice + strategy.tpPips * pip * sign).toFixed(dp)
  const slPrice    = +(indicators.currentPrice - strategy.slPips * pip * sign).toFixed(dp)
  const expiryMs   = TF_EXPIRY_MS[timeframe] ?? 15 * 60_000

  const signal: ScanSignal = {
    id:            `scan-${pair.replace('/', '')}-${now.getTime()}`,
    pair,
    timeframe,
    direction:     rec.direction,
    confidence:    rec.confidence,
    checklistScore: checklist.passCount,
    entryZone:     rec.entry_zone || { low: indicators.currentPrice, high: indicators.currentPrice },
    reasons:       rec.reasons || [],
    riskNote:      rec.risk_note || '',
    currentPrice:  indicators.currentPrice,
    scannedAt:     now.toISOString(),
    expiresAt:     new Date(now.getTime() + expiryMs).toISOString(),
    indicators,
    simulated,
    htfConfirmed,
  }

  // Telegram alert (non-blocking)
  alertNewSignal({
    pair, direction: rec.direction, confidence: rec.confidence,
    checklistScore: checklist.passCount,
    currentPrice: indicators.currentPrice, timeframe,
    entryLow: signal.entryZone.low, entryHigh: signal.entryZone.high,
    tpPrice, slPrice, lots,
    reasons: rec.reasons || [],
  })

  return signal
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const {
      pairs, timeframe = '1H', strategy,
      newsInWindow = false, openPositions = 0, todayPL = 0, accountBalance = 10000,
    } = body as {
      pairs: string[]; timeframe: string; strategy: StrategySettings
      newsInWindow: boolean; openPositions: number; todayPL: number; accountBalance: number
    }

    if (!pairs?.length) return NextResponse.json({ signals: [] })

    const authToken = req.headers.get('Authorization')?.replace('Bearer ', '') || undefined
    const cfg       = tfConfig(timeframe)
    const context   = { newsInWindow, openPositions, todayPL, accountBalance }

    // Run all pairs in parallel — cuts total scan time from 60-90 s → 10-15 s
    // Batch in groups of 3 to avoid hitting Claude rate limits
    const results: ScanSignal[] = []
    const BATCH = 3

    for (let i = 0; i < pairs.length; i += BATCH) {
      const batch  = pairs.slice(i, i + BATCH)
      const settled = await Promise.allSettled(
        batch.map(pair =>
          scanPair(pair, timeframe, authToken, strategy, context, cfg)
            .catch(e => { console.error(`[scan] ${pair}:`, e?.message); return null })
        )
      )
      for (const r of settled) {
        if (r.status === 'fulfilled' && r.value) results.push(r.value)
      }
    }

    if (results.length > 0) {
      alertScanComplete({
        pairsScanned: pairs.length,
        signalsFound: results.length,
        pairs: results.map(s => `${s.pair} ${s.direction} (${s.confidence}%)`),
      })
    }

    return NextResponse.json({
      signals: results,
      scannedAt: new Date().toISOString(),
      pairsScanned: pairs.length,
    })
  } catch (error: any) {
    console.error('[scan]', error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}
