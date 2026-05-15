// app/api/scan/route.ts
// Scans all watchlist pairs in one shot, runs AI analysis on each,
// returns only actionable signals (BUY or SELL with checklist >= 6/8).

import { NextRequest, NextResponse } from 'next/server'
import { getBroker } from '@/lib/brokers'
import { calculateIndicators, evaluateChecklist, buildIndicatorPrompt } from '@/lib/indicators'
import { SimulationBroker } from '@/lib/brokers/simulation.adapter'
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
  expiresAt: string       // 15-min window
  indicators: any
  simulated?: boolean
}

const TF_EXPIRY_MS: Record<string, number> = {
  '1m': 5 * 60_000, '3m': 10 * 60_000, '5m': 15 * 60_000,
  '15m': 30 * 60_000, '30m': 60 * 60_000, '1H': 120 * 60_000,
  '4H': 360 * 60_000, 'Daily': 1440 * 60_000,
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const { pairs, timeframe = '1H', strategy, newsInWindow = false, openPositions = 0, todayPL = 0, accountBalance = 10000 } = body as {
      pairs: string[]
      timeframe: string
      strategy: StrategySettings
      newsInWindow: boolean
      openPositions: number
      todayPL: number
      accountBalance: number
    }

    if (!pairs?.length) return NextResponse.json({ signals: [] })

    const authToken = req.headers.get('Authorization')?.replace('Bearer ', '') || undefined
    const broker = await getBroker(authToken)
    const signals: ScanSignal[] = []

    // Scan each pair sequentially to avoid rate limits
    for (const pair of pairs) {
      try {
        // Skip index instruments outside their market session
        if (!isIndexInSession(pair)) continue

        // 1. Get candles
        let candles: any[]
        let candlesSimulated = false
        try {
          candles = await broker.getCandles(pair, timeframe, 200)
          if (!candles || candles.length < 60) throw new Error('insufficient')
        } catch {
          const sim = new SimulationBroker()
          candles = await sim.getCandles(pair, timeframe, 200)
          candlesSimulated = true
        }

        // 2. Calculate indicators
        const indicators = calculateIndicators(candles)

        // 3. Determine direction — require EMA AND MACD to agree (conflicting = skip, reduces false signals)
        const emaDir: 'BUY' | 'SELL' = indicators.emaCrossed ? 'BUY' : 'SELL'
        const macdDir: 'BUY' | 'SELL' = indicators.macdHistogram > 0 ? 'BUY' : 'SELL'
        if (emaDir !== macdDir) continue  // EMA and MACD disagree — no high-probability setup

        const direction = emaDir

        // 3b. ATR volatility guard — if ATR-based SL is >2x our fixed SL, volatility too high for fixed stops
        const atrResult = calcATRIndicator(candles, pair)
        if (atrResult.suggestedSL > strategy.slPips * 2) continue

        // 4. Run checklist
        const checklist = evaluateChecklist(indicators, direction, {
          newsInWindow,
          signalStrength: indicators.adx,  // pass actual ADX, used for context only
          minStrength: strategy.minStrength,
          openPositions,
          maxPositions: strategy.maxPositions,
          todayPL,
          balance: accountBalance,
          maxLossPct: strategy.maxLoss,
        })

        // Skip pairs that can't trade or have weak signal
        if (!checklist.canTrade || checklist.passCount < 6) continue

        // 4b. S/R room check — ensure TP can be reached before nearest S/R level blocks it
        const pip = getPipValue(pair)
        const srResult = detectSupportResistance(candles, pair)
        const tpDistance = strategy.tpPips * pip
        if (direction === 'BUY' && srResult.nearestResistance) {
          const roomPips = (srResult.nearestResistance.price - indicators.currentPrice) / pip
          if (roomPips < strategy.tpPips * 0.7) continue  // resistance blocks TP
        }
        if (direction === 'SELL' && srResult.nearestSupport) {
          const roomPips = (indicators.currentPrice - srResult.nearestSupport.price) / pip
          if (roomPips < strategy.tpPips * 0.7) continue  // support blocks TP
        }

        // 5. Run AI analysis
        let rec: any = null
        try {
          if (process.env.ANTHROPIC_API_KEY && process.env.ANTHROPIC_API_KEY !== 'your_anthropic_api_key_here') {
            const systemPrompt = `You are a disciplined forex trading analyst. Respond ONLY with valid JSON — no markdown.
JSON format: {"direction":"BUY"|"SELL"|"WAIT","confidence":0-100,"entry_zone":{"low":number,"high":number},"reasons":["r1","r2","r3"],"risk_note":"string","checklist_passed":number}
Rules: Only recommend BUY/SELL if 6+ of 8 checklist rules pass. Otherwise return WAIT.`
            const prompt = buildIndicatorPrompt(pair, timeframe, indicators, checklist, direction)
            const msg = await anthropic.messages.create({
              model: 'claude-sonnet-4-6',
              max_tokens: 600,
              system: systemPrompt,
              messages: [{ role: 'user', content: prompt }],
            })
            const text = msg.content.find(b => b.type === 'text')?.text || '{}'
            rec = JSON.parse(text.replace(/```json|```/g, '').trim())
          }
        } catch { /* fall through to skip */ }

        if (!rec || rec.direction === 'WAIT' || rec.confidence < 60) continue

        const now = new Date()
        const pipPerLot = getPipValuePerLot(pair)
        const lots = calcStandardPositionSize(accountBalance, strategy.riskPct, strategy.slPips, pair)
        const sign = rec.direction === 'BUY' ? 1 : -1
        const dp = getPairDecimalPlaces(pair)
        const tpPrice = +(indicators.currentPrice + strategy.tpPips * pip * sign).toFixed(dp)
        const slPrice = +(indicators.currentPrice - strategy.slPips * pip * sign).toFixed(dp)

        const signal: ScanSignal = {
          id: `scan-${pair.replace('/', '')}-${now.getTime()}`,
          pair,
          timeframe,
          direction: rec.direction,
          confidence: rec.confidence,
          checklistScore: checklist.passCount,
          entryZone: rec.entry_zone || { low: indicators.currentPrice, high: indicators.currentPrice },
          reasons: rec.reasons || [],
          riskNote: rec.risk_note || '',
          currentPrice: indicators.currentPrice,
          scannedAt: now.toISOString(),
          expiresAt: new Date(now.getTime() + (TF_EXPIRY_MS[timeframe] ?? 15 * 60_000)).toISOString(),
          indicators,
          simulated: candlesSimulated,
        }

        // Fire Telegram alert for this signal (non-blocking)
        alertNewSignal({
          pair, direction: rec.direction, confidence: rec.confidence,
          checklistScore: checklist.passCount,
          currentPrice: indicators.currentPrice, timeframe,
          entryLow: signal.entryZone.low, entryHigh: signal.entryZone.high,
          tpPrice, slPrice, lots,
          reasons: rec.reasons || [],
        })

        signals.push(signal)
      } catch (e: any) {
        console.error(`[scan] ${pair}:`, e?.message)
      }
    }

    // Summary alert if any signals found
    if (signals.length > 0) {
      alertScanComplete({
        pairsScanned: pairs.length,
        signalsFound: signals.length,
        pairs: signals.map(s => `${s.pair} ${s.direction} (${s.confidence}%)`),
      })
    }

    return NextResponse.json({ signals, scannedAt: new Date().toISOString(), pairsScanned: pairs.length })
  } catch (error: any) {
    console.error('[scan]', error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}
