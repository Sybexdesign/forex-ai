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

const ML_URL = process.env.ML_SERVICE_URL || 'http://localhost:8100'

async function queryML(indicators: any, pair: string, direction: string, confidence: number) {
  try {
    const ctrl  = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), 3000)
    const resp  = await fetch(`${ML_URL}/predict`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      signal:  ctrl.signal,
      body:    JSON.stringify({
        pair, direction, confidence,
        indicators,
        scalperIndicators: indicators.scalper ?? {},
        timestamp: new Date().toISOString(),
      }),
    })
    clearTimeout(timer)
    if (!resp.ok) return null
    return await resp.json() as { win_probability: number; should_trade: boolean; ml_confidence: number }
  } catch {
    return null
  }
}

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
  mlScore?: { win_probability: number; should_trade: boolean; ml_confidence: number } | null
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
    minChecklistPass: metals ? 5 : (isShort ? 5 : 6),
    skipAtrGuard:     metals,                           // metals ATR dwarfs FX slPips baseline
    atrGuardMult:     isShort ? 3 : 2,
    minConfidence:    metals ? 65 : (isMicro ? 55 : 60),
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
    // Simulated HTF data is not a confirmation — treat as unconfirmed (reduces confidence by 8%)
    if (simulated) return { confirmed: false, boost: false }
    const ind = calculateIndicators(candles)
    // Use RSI > 50 (clear momentum) not > 45 (near-neutral) to confirm bullish HTF
    const htfBullish = ind.emaCrossed && ind.macdHistogram > 0 && ind.rsi > 50
    const htfBearish = !ind.emaCrossed && ind.macdHistogram < 0 && ind.rsi < 50
    const confirmed = direction === 'BUY' ? htfBullish : htfBearish
    const boost     = confirmed && ind.adx > 25
    return { confirmed, boost }
  } catch {
    return { confirmed: false, boost: false }
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

type ScanResult = { signal: ScanSignal; blockedBy: null } | { signal: null; blockedBy: string }

async function scanPair(
  pair: string,
  timeframe: string,
  authToken: string | undefined,
  strategy: StrategySettings,
  context: { newsInWindow: boolean; openPositions: number; todayPL: number; accountBalance: number },
  cfg: ReturnType<typeof tfConfig>,
): Promise<ScanResult> {
  const block = (reason: string): ScanResult => ({ signal: null, blockedBy: reason })

  if (!isIndexInSession(pair)) return block('Market closed')

  // Metals session gate: London/NY sessions (05:00–18:59 UTC) have 0% win rate on XAU/USD
  // from 213 live signals. Best window: 19:00–04:00 UTC (Asian session / NY close).
  if (isMetals(pair)) {
    const utcHour = new Date().getUTCHours()
    if (utcHour >= 5 && utcHour < 19) {
      console.log(`[scan] ${pair}/${timeframe}: London/NY session (${utcHour}:xx UTC) — metals blocked (historical 0% win rate this window)`)
      return block(`London/NY session (${utcHour}:xx UTC) — best window 19:00–04:00 UTC`)
    }
  }

  // 1. Fetch candles — reject simulation outright
  const { candles, simulated } = await getCandles(authToken, pair, timeframe, 200)
  if (simulated) {
    console.log(`[scan] ${pair}/${timeframe}: simulated data — live feed required, skipping`)
    return block('No live data — MT5 EA offline')
  }

  // 2. Indicators
  const indicators = calculateIndicators(candles)

  // Metals ADX floor: ADX 20–24 has 6% win rate (91 losses). Require ADX ≥ 25.
  if (isMetals(pair) && indicators.adx < 25) {
    console.log(`[scan] ${pair}/${timeframe}: ADX ${indicators.adx.toFixed(1)} < 25 — metals need stronger trend`)
    return block(`ADX ${indicators.adx.toFixed(1)} < 25 — trend too weak`)
  }

  // 3. Direction resolution (EMA+MACD primary; RSI momentum fallback for metals)
  const { direction: resolvedDir, method: dirMethod } = resolveDirection(indicators, pair)
  if (!resolvedDir) return block('EMA/MACD conflict — no clear direction')

  const direction = resolvedDir

  // 4. RSI extreme guard (metals use wider thresholds — they trend at high RSI)
  if (direction === 'BUY'  && indicators.rsi > cfg.rsiExtremeBuy)  return block(`RSI ${indicators.rsi.toFixed(1)} overbought`)
  if (direction === 'SELL' && indicators.rsi < cfg.rsiExtremeSell) return block(`RSI ${indicators.rsi.toFixed(1)} oversold`)

  // Metals RSI momentum gate: RSI 50–69 on BUY has 0% win rate (93 losses).
  // Only enter BUY on oversold momentum (RSI < 45), SELL on overbought (RSI > 55).
  if (isMetals(pair)) {
    if (direction === 'BUY'  && indicators.rsi > 45) {
      console.log(`[scan] ${pair}/${timeframe}: RSI ${indicators.rsi.toFixed(1)} > 45 on BUY — mid-range RSI has 0% win rate on metals`)
      return block(`RSI ${indicators.rsi.toFixed(1)} — BUY needs RSI < 45 (mid-range = 0% win rate)`)
    }
    if (direction === 'SELL' && indicators.rsi < 55) {
      console.log(`[scan] ${pair}/${timeframe}: RSI ${indicators.rsi.toFixed(1)} < 55 on SELL — mid-range RSI blocked`)
      return block(`RSI ${indicators.rsi.toFixed(1)} — SELL needs RSI > 55`)
    }
  }

  // 5. ATR guard
  const atrResult = calcATRIndicator(candles, pair)
  if (!cfg.skipAtrGuard) {
    if (atrResult.suggestedSL > strategy.slPips * cfg.atrGuardMult) return block('ATR too high for SL setting')
  } else if (isMetals(pair)) {
    // Metals ATR dwarfs FX pip baselines, but a SL inside 1x ATR gets stopped by noise alone.
    // suggestedSL = ATR_pips * 1.5, so ATR_pips = suggestedSL / 1.5
    const atrPips = atrResult.suggestedSL / 1.5
    if (strategy.slPips < atrPips) {
      console.log(`[scan] ${pair}/${timeframe}: SL ${strategy.slPips}p < ATR ${atrPips.toFixed(0)}p — blocked (widen SL to trade ${pair})`)
      return block(`SL ${strategy.slPips}p < ATR ${atrPips.toFixed(0)}p — widen SL`)
    }
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
      if (!htf.confirmed) return block('HTF trend not confirmed')
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
  if (checklist.passCount < cfg.minChecklistPass) return block(`Checklist ${checklist.passCount}/${cfg.minChecklistPass} — need ${cfg.minChecklistPass} passes`)

  // 8. S/R room check — skipped for metals.
  // Metals are momentum/breakout assets; historical S/R is continuously broken in trending moves.
  // In a trending XAU/XAG market there are always recent swing highs nearby, which would
  // kill every valid BUY signal. The ATR guard and checklist provide sufficient risk filtering.
  const pip = getPipValue(pair)
  if (!isMetals(pair)) {
    const srResult = detectSupportResistance(candles, pair)
    if (direction === 'BUY' && srResult.nearestResistance) {
      const roomPips = (srResult.nearestResistance.price - indicators.currentPrice) / pip
      if (roomPips < strategy.tpPips * 0.70) return block(`Resistance too close (${roomPips.toFixed(0)}p room, need ${(strategy.tpPips * 0.70).toFixed(0)}p)`)
    }
    if (direction === 'SELL' && srResult.nearestSupport) {
      const roomPips = (indicators.currentPrice - srResult.nearestSupport.price) / pip
      if (roomPips < strategy.tpPips * 0.70) return block(`Support too close (${roomPips.toFixed(0)}p room, need ${(strategy.tpPips * 0.70).toFixed(0)}p)`)
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

    // Fallback prompt removed: forcing WAIT → signal on metals generates conf 65–79 trades
    // with 0–4% historical win rate. If AI says WAIT, trust it and skip.
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

  if (!rec || rec.direction === 'WAIT' || (rec.confidence ?? 0) < cfg.minConfidence) {
    const reason = !rec ? 'AI returned no signal' : rec.direction === 'WAIT' ? `AI says WAIT: ${rec.risk_note?.slice(0, 80) || 'no setup'}` : `Confidence ${rec.confidence}% < min ${cfg.minConfidence}%`
    return block(reason)
  }

  // Confidence adjustment: HTF boost/penalty
  let finalConfidence = rec.confidence as number
  if (htfBoost)      finalConfidence = Math.min(98, finalConfidence + 8)
  if (!htfConfirmed) finalConfidence = Math.max(cfg.minConfidence, finalConfidence - 8)
  if (dirMethod === 'rsi_momentum') finalConfidence = Math.max(cfg.minConfidence, finalConfidence - 5)

  if (finalConfidence < cfg.minConfidence) return block(`Confidence ${finalConfidence}% < min ${cfg.minConfidence}% after adjustments`)

  // 10. Build signal
  const now      = new Date()
  const sign     = rec.direction === 'BUY' ? 1 : -1
  const dp       = getPairDecimalPlaces(pair)
  const lots     = calcStandardPositionSize(context.accountBalance, strategy.riskPct, strategy.slPips, pair)
  const tpPrice  = +(indicators.currentPrice + strategy.tpPips * pip * sign).toFixed(dp)
  const slPrice  = +(indicators.currentPrice - strategy.slPips * pip * sign).toFixed(dp)
  const expiryMs = TF_EXPIRY_MS[timeframe] ?? 15 * 60_000

  // ML score: advisory only until model accumulates sufficient WIN samples with
  // complete indicator snapshots. Hard block disabled — score is attached to signal
  // for display and will be re-enabled once model ROC-AUC > 0.70 on clean data.
  const mlScore = await queryML(indicators, pair, rec.direction, finalConfidence)

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
    mlScore,
  }

  await alertNewSignal({
    pair, direction: rec.direction, confidence: finalConfidence,
    checklistScore: checklist.passCount,
    currentPrice: indicators.currentPrice, timeframe,
    entryLow: signal.entryZone.low, entryHigh: signal.entryZone.high,
    tpPrice, slPrice, lots,
    reasons: rec.reasons || [],
    adx: typeof indicators.adx === 'number' ? indicators.adx : null,
  })

  return { signal, blockedBy: null }
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
          .catch(e => { console.error(`[scan] ${pair}:`, e?.message); return { signal: null, blockedBy: `Error: ${e?.message}` } as ScanResult })
      )
    )

    const results: ScanSignal[] = []
    const diagnostics: { pair: string; blockedBy: string }[] = []
    settled.forEach((r, i) => {
      if (r.status === 'fulfilled') {
        if (r.value.signal) results.push(r.value.signal)
        else if (r.value.blockedBy) diagnostics.push({ pair: pairs[i], blockedBy: r.value.blockedBy })
      }
    })

    if (results.length > 0) {
      await alertScanComplete({
        pairsScanned: pairs.length,
        signalsFound: results.length,
        pairs: results.map(s => `${s.pair} ${s.direction} (${s.confidence}%)`),
      })
    }

    return NextResponse.json({
      signals: results,
      diagnostics,
      scannedAt: new Date().toISOString(),
      pairsScanned: pairs.length,
    })
  } catch (error: any) {
    console.error('[scan]', error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}
