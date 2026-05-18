// app/api/scan/route.ts
// Scans XAU/USD and XAG/USD (metals only) — live data required, simulation rejected.
// Multi-timeframe confirmation, metals-tuned thresholds, AI analysis with fallback path.

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

// Only these two pairs are permitted
const METALS_ONLY = ['XAU/USD', 'XAG/USD']

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
  htfConfirmed?: boolean
}

const TF_EXPIRY_MS: Record<string, number> = {
  '1m':   3 * 60_000,
  '3m':   6 * 60_000,
  '5m':   15 * 60_000,
  '15m':  30 * 60_000,
  '30m':  60 * 60_000,
  '1H':   120 * 60_000,
  '4H':   360 * 60_000,
  'Daily': 1440 * 60_000,
}

// HTF to use for each timeframe (metals always get multi-TF confirmation)
const HTF_MAP: Record<string, string | null> = {
  '1m': '15m', '3m': '15m', '5m': '15m',
  '15m': '1H', '30m': '1H', '1H': '4H', '4H': null, 'Daily': null,
}

function isMetals(pair: string) { return pair.startsWith('XA') }

function tfConfig(timeframe: string, pair: string) {
  const isShort  = ['1m', '3m', '5m'].includes(timeframe)
  const isMicro  = ['1m', '3m'].includes(timeframe)
  const metals   = isMetals(pair)
  return {
    minChecklistPass: metals ? 4 : (isShort ? 5 : 6),
    skipAtrGuard:     metals,                           // metals ATR dwarfs FX slPips baseline
    atrGuardMult:     isShort ? 3 : 2,
    minConfidence:    metals ? 55 : (isMicro ? 55 : 60),
    rsiExtremeBuy:    metals ? 87 : 75,                 // metals sustain high RSI in trends
    rsiExtremeSell:   metals ? 13 : 25,
    htfFrame:         HTF_MAP[timeframe] ?? null,
    htfCandleCount:   60,
  }
}

async function getCandles(authToken: string | undefined, pair: string, tf: string, count: number) {
  const result = await getMarketCandles(authToken, pair, tf, count)
  return { candles: result.candles, simulated: result.simulated }
}

// HTF confirmation: returns { confirmed: boolean, boostConfidence: boolean }
// For metals, disagreement reduces confidence rather than hard-blocking
async function confirmHTF(
  authToken: string | undefined,
  pair: string,
  htfFrame: string,
  direction: 'BUY' | 'SELL',
): Promise<{ confirmed: boolean; boost: boolean }> {
  try {
    const { candles, simulated } = await getCandles(authToken, pair, htfFrame, 60)
    if (simulated) return { confirmed: true, boost: false }  // no penalty for unavailable HTF
    const ind = calculateIndicators(candles)
    const htfBullish = ind.emaCrossed && ind.macdHistogram > 0 && ind.rsi > 45
    const htfBearish = !ind.emaCrossed && ind.macdHistogram < 0 && ind.rsi < 55
    const confirmed = direction === 'BUY' ? htfBullish : htfBearish
    const boost     = confirmed && (direction === 'BUY' ? ind.adx > 25 : ind.adx > 25)
    return { confirmed, boost }
  } catch {
    return { confirmed: true, boost: false }
  }
}

// Determine signal direction — primary: EMA+MACD, fallback: RSI momentum for metals
function resolveDirection(
  indicators: ReturnType<typeof calculateIndicators>,
  pair: string,
): { direction: 'BUY' | 'SELL' | null; method: 'ema_macd' | 'rsi_momentum' } {
  const emaDir:  'BUY' | 'SELL' = indicators.emaCrossed       ? 'BUY' : 'SELL'
  const macdDir: 'BUY' | 'SELL' = indicators.macdHistogram > 0 ? 'BUY' : 'SELL'

  if (emaDir === macdDir) return { direction: emaDir, method: 'ema_macd' }

  if (isMetals(pair)) {
    // MACD histogram is price-scaled: -0.03 for XAU at 4500 is < 0.001% of price — pure noise.
    // When the histogram is within a negligible band, trust EMA trend alignment instead.
    const flatThreshold = pair.startsWith('XAU') ? 0.5 : 0.05
    if (Math.abs(indicators.macdHistogram) < flatThreshold)
      return { direction: emaDir, method: 'ema_macd' }

    // When EMA and MACD genuinely disagree, use RSI to confirm EMA direction (ADX must show trend)
    // Note: macdHistogram condition removed — it was logically unreachable in this branch
    if (indicators.adx > 22) {
      if (emaDir === 'BUY'  && indicators.rsi > 58)
        return { direction: 'BUY',  method: 'rsi_momentum' }
      if (emaDir === 'SELL' && indicators.rsi < 42)
        return { direction: 'SELL', method: 'rsi_momentum' }
    }
  }

  return { direction: null, method: 'ema_macd' }
}

async function scanPair(
  pair: string,
  timeframe: string,
  authToken: string | undefined,
  strategy: StrategySettings,
  context: { newsInWindow: boolean; openPositions: number; todayPL: number; accountBalance: number },
  cfg: ReturnType<typeof tfConfig>,
): Promise<ScanSignal | null> {
  if (!isIndexInSession(pair)) return null

  // 1. Fetch candles — reject simulation outright
  const { candles, simulated } = await getCandles(authToken, pair, timeframe, 200)
  if (simulated) {
    console.log(`[scan] ${pair}/${timeframe}: simulated data — live feed required, skipping`)
    return null
  }

  // 2. Indicators
  const indicators = calculateIndicators(candles)

  // 3. Direction resolution (EMA+MACD primary; RSI momentum fallback for metals)
  const { direction: resolvedDir, method: dirMethod } = resolveDirection(indicators, pair)
  if (!resolvedDir) return null

  const direction = resolvedDir

  // 4. RSI extreme guard (metals use wider thresholds — they trend at high RSI)
  if (direction === 'BUY'  && indicators.rsi > cfg.rsiExtremeBuy)  return null
  if (direction === 'SELL' && indicators.rsi < cfg.rsiExtremeSell) return null

  // 5. ATR guard (skipped for metals — their natural ATR dwarfs FX-calibrated slPips)
  const atrResult = calcATRIndicator(candles, pair)
  if (!cfg.skipAtrGuard) {
    if (atrResult.suggestedSL > strategy.slPips * cfg.atrGuardMult) return null
  }

  // 6. Multi-timeframe confirmation — metals always get this
  let htfConfirmed = true
  let htfBoost = false
  if (cfg.htfFrame) {
    const htf = await confirmHTF(authToken, pair, cfg.htfFrame, direction)
    htfBoost = htf.boost
    if (isMetals(pair)) {
      // For metals: HTF contradiction reduces confidence but doesn't hard-block
      htfConfirmed = htf.confirmed
    } else {
      // For non-metals: hard filter (not used since only metals are scanned, kept for safety)
      if (!htf.confirmed) return null
      htfConfirmed = true
    }
  }

  // 7. Checklist
  const checklist = evaluateChecklist(indicators, direction, {
    newsInWindow:   context.newsInWindow,
    signalStrength: indicators.adx,
    minStrength:    strategy.minStrength,
    openPositions:  context.openPositions,
    maxPositions:   strategy.maxPositions,
    todayPL:        context.todayPL,
    balance:        context.accountBalance,
    maxLossPct:     strategy.maxLoss,
  })
  // Use our own per-config minimum, not the hardcoded canTrade threshold (which always requires 6)
  if (checklist.passCount < cfg.minChecklistPass) return null

  // 8. S/R room check — skipped for metals.
  // Metals are momentum/breakout assets; historical S/R is continuously broken in trending moves.
  // In a trending XAU/XAG market there are always recent swing highs nearby, which would
  // kill every valid BUY signal. The ATR guard and checklist provide sufficient risk filtering.
  const pip = getPipValue(pair)
  if (!isMetals(pair)) {
    const srResult = detectSupportResistance(candles, pair)
    if (direction === 'BUY' && srResult.nearestResistance) {
      const roomPips = (srResult.nearestResistance.price - indicators.currentPrice) / pip
      if (roomPips < strategy.tpPips * 0.70) return null
    }
    if (direction === 'SELL' && srResult.nearestSupport) {
      const roomPips = (indicators.currentPrice - srResult.nearestSupport.price) / pip
      if (roomPips < strategy.tpPips * 0.70) return null
    }
  }

  // 9. AI analysis — with rule-based fallback if AI is unavailable (no key / out of credits)
  let rec: any = null
  let aiUnavailable = false
  const hasKey = !!(process.env.ANTHROPIC_API_KEY &&
    process.env.ANTHROPIC_API_KEY !== 'your_anthropic_api_key_here')

  if (hasKey) {
    const assetName  = pair === 'XAU/USD' ? 'Gold' : 'Silver'
    const systemPrompt = `You are a specialist precious metals trader analysing ${assetName} (${pair}).
Respond ONLY with valid JSON — no markdown, no explanation outside the JSON.
JSON format: {"direction":"BUY"|"SELL"|"WAIT","confidence":0-100,"entry_zone":{"low":number,"high":number},"reasons":["r1","r2","r3"],"risk_note":"string","checklist_passed":number}

${assetName} trading rules:
- ${assetName} can sustain RSI 70–87 in strong bull trends; high RSI alone is NOT a reason to avoid BUY
- ATR is naturally high — focus on momentum, breakout structures, and Bollinger Band expansion
- ADX > 20 confirms a trending environment; prioritise trend-following signals
- Bollinger Band width expansion signals breakout setups; price near upper/lower band with momentum is actionable
- Multi-timeframe trend alignment (EMA stack direction) is the highest-weight factor
- Direction method "${dirMethod}" was used — if "rsi_momentum", require stronger AI confirmation
- Checklist passed: ${checklist.passCount}/8 items${htfBoost ? ' — higher-timeframe trend strongly confirmed (boost confidence)' : (!htfConfirmed ? ' — higher-timeframe trend conflicts (reduce confidence slightly)' : '')}

Only recommend BUY/SELL if confidence ≥ 55. For WAIT: explain the main reason briefly in risk_note.`

    try {
      const prompt = buildIndicatorPrompt(pair, timeframe, indicators, checklist, direction)
      const msg = await anthropic.messages.create({
        model:      'claude-sonnet-4-6',
        max_tokens: 600,
        system:     systemPrompt,
        messages:   [{ role: 'user', content: prompt }],
      })
      const text = msg.content.find(b => b.type === 'text')?.text || '{}'
      rec = JSON.parse(text.replace(/```json|```/g, '').trim())
    } catch (e: any) {
      const msg = e?.message || ''
      if (msg.includes('credit') || msg.includes('billing') || msg.includes('quota') || msg.includes('429') || msg.includes('insufficient')) {
        console.warn(`[scan] AI unavailable (${msg.slice(0, 80)}) — using rule-based fallback`)
        aiUnavailable = true
      }
      // fall through to rule-based fallback below
    }

    // If AI says WAIT on first pass, try a fallback prompt focused on best current setup
    if (!aiUnavailable && (!rec || rec.direction === 'WAIT') && isMetals(pair)) {
      try {
        const fallbackPrompt = buildIndicatorPrompt(pair, timeframe, indicators, checklist, direction) +
          `\n\nFallback analysis request: The pre-filter passed. Even if the setup is not perfect, identify the BEST directional bias right now. If there is ANY measurable momentum or trend, report it with honest confidence (may be 55–65%). Do not return WAIT unless the market is genuinely flat with no discernible direction.`
        const msg2 = await anthropic.messages.create({
          model:      'claude-sonnet-4-6',
          max_tokens: 600,
          system:     systemPrompt,
          messages:   [{ role: 'user', content: fallbackPrompt }],
        })
        const text2 = msg2.content.find(b => b.type === 'text')?.text || '{}'
        const fallbackRec = JSON.parse(text2.replace(/```json|```/g, '').trim())
        if (fallbackRec.direction !== 'WAIT' && (fallbackRec.confidence ?? 0) >= cfg.minConfidence) {
          rec = fallbackRec
        }
      } catch { /* ignore */ }
    }
  }

  // Rule-based confidence fallback: used when AI key missing or API unavailable (credits/rate limit)
  if (!rec || rec.direction === 'WAIT') {
    const base     = Math.min(50, checklist.passCount * 7)   // up to 56 from 8/8
    const adxBonus = indicators.adx > 30 ? 10 : indicators.adx > 25 ? 6 : indicators.adx > 20 ? 3 : 0
    const rsiBonus = direction === 'BUY'
      ? (indicators.rsi > 55 && indicators.rsi < 72 ? 6 : 0)
      : (indicators.rsi < 45 && indicators.rsi > 28 ? 6 : 0)
    const macdBonus = Math.abs(indicators.macdHistogram) > 0.3 ? 5 : Math.abs(indicators.macdHistogram) > 0.1 ? 3 : 0
    const htfBonus2 = htfBoost ? 6 : (!htfConfirmed ? -6 : 0)
    const ruleConf  = base + adxBonus + rsiBonus + macdBonus + htfBonus2

    if (ruleConf >= cfg.minConfidence) {
      const isBuy = direction === 'BUY'
      rec = {
        direction,
        confidence: ruleConf,
        entry_zone: { low: indicators.currentPrice, high: indicators.currentPrice },
        reasons: [
          `${checklist.passCount}/8 checklist items pass`,
          `ADX ${indicators.adx.toFixed(1)} — ${indicators.adx > 25 ? 'strong' : 'moderate'} trend`,
          `RSI ${indicators.rsi.toFixed(1)} — ${isBuy ? 'bullish' : 'bearish'} momentum`,
          `MACD histogram ${indicators.macdHistogram > 0 ? '+' : ''}${indicators.macdHistogram.toFixed(3)}`,
        ].filter(Boolean),
        risk_note: aiUnavailable
          ? 'Rule-based signal — AI credits needed for enhanced analysis'
          : 'Rule-based signal — AI key not configured',
        checklist_passed: checklist.passCount,
      }
    }
  }

  if (!rec || rec.direction === 'WAIT' || (rec.confidence ?? 0) < cfg.minConfidence) return null

  // Confidence adjustment: HTF boost/penalty
  let finalConfidence = rec.confidence as number
  if (htfBoost)      finalConfidence = Math.min(98, finalConfidence + 8)
  if (!htfConfirmed) finalConfidence = Math.max(cfg.minConfidence, finalConfidence - 8)
  if (dirMethod === 'rsi_momentum') finalConfidence = Math.max(cfg.minConfidence, finalConfidence - 5)

  if (finalConfidence < cfg.minConfidence) return null

  // 10. Build signal
  const now      = new Date()
  const sign     = rec.direction === 'BUY' ? 1 : -1
  const dp       = getPairDecimalPlaces(pair)
  const lots     = calcStandardPositionSize(context.accountBalance, strategy.riskPct, strategy.slPips, pair)
  const tpPrice  = +(indicators.currentPrice + strategy.tpPips * pip * sign).toFixed(dp)
  const slPrice  = +(indicators.currentPrice - strategy.slPips * pip * sign).toFixed(dp)
  const expiryMs = TF_EXPIRY_MS[timeframe] ?? 15 * 60_000

  const signal: ScanSignal = {
    id:            `scan-${pair.replace('/', '')}-${now.getTime()}`,
    pair,
    timeframe,
    direction:     rec.direction,
    confidence:    finalConfidence,
    checklistScore: checklist.passCount,
    entryZone:     rec.entry_zone || { low: indicators.currentPrice, high: indicators.currentPrice },
    reasons:       rec.reasons || [],
    riskNote:      rec.risk_note || '',
    currentPrice:  indicators.currentPrice,
    scannedAt:     now.toISOString(),
    expiresAt:     new Date(now.getTime() + expiryMs).toISOString(),
    indicators,
    simulated:     false,
    htfConfirmed,
  }

  await alertNewSignal({
    pair, direction: rec.direction, confidence: finalConfidence,
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
      pairs: rawPairs,
      timeframe = '5m',
      strategy,
      newsInWindow = false, openPositions = 0, todayPL = 0, accountBalance = 10000,
    } = body as {
      pairs: string[]; timeframe: string; strategy: StrategySettings
      newsInWindow: boolean; openPositions: number; todayPL: number; accountBalance: number
    }

    // Enforce metals-only — filter out any non-metals pairs
    const pairs = (rawPairs || METALS_ONLY).filter(p => METALS_ONLY.includes(p))
    if (!pairs.length) return NextResponse.json({ signals: [], note: 'No metals pairs to scan' })

    const authToken = req.headers.get('Authorization')?.replace('Bearer ', '') || undefined
    const context   = { newsInWindow, openPositions, todayPL, accountBalance }

    // Scan both metals concurrently
    const settled = await Promise.allSettled(
      pairs.map(pair =>
        scanPair(pair, timeframe, authToken, strategy, context, tfConfig(timeframe, pair))
          .catch(e => { console.error(`[scan] ${pair}:`, e?.message); return null })
      )
    )

    const results: ScanSignal[] = []
    for (const r of settled) {
      if (r.status === 'fulfilled' && r.value) results.push(r.value)
    }

    if (results.length > 0) {
      await alertScanComplete({
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
