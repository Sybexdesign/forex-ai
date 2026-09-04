// app/api/scalper/signal/route.ts
export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { getAdminClient } from '@/lib/supabase'
import { llmComplete, hasLlmKey, providerLabel } from '@/lib/llm'
import { getMarketCandles } from '@/lib/marketdata'
import { calculateIndicators } from '@/lib/indicators'
import { selectLatestClosedCandle } from '@/lib/market-health'
import {
  PREDICTION_WINDOW_MS, PREDICTION_FUTURE_CANDLES, PREDICTION_RESOLUTION_RULE,
  PREDICTION_TIMEFRAME, buildPredictionMeta,
} from '@/lib/prediction-contract.mjs'
import { getCalibratedMinStrengths } from '@/lib/threshold-calibration'
import { sessionOf } from '@/lib/expectancy-engine'
import { evaluateSetup } from '@/lib/setup-evaluator'

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
  // Audit Phase 1.4 — provenance of the spread value: 'live' bid/ask feed
  // vs the static per-instrument default. Gates must only fire on 'live'.
  spreadSource?: 'live' | 'default'
  bid?: number | null
  ask?: number | null
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
  ADX < 15   → chop         (signals suppressed downstream — never traded)
  ADX 15-19 → ranging      (downstream gate is 78)
  ADX 20-24 → weak-trend   (downstream gate is 75)
  ADX 25-27 → trending     (downstream gate is 72)
  ADX ≥ 28  → strong-trend (signals suppressed downstream — never traded)
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

// ── Multi-timeframe HTF bias (audit Phase 2, item 6) ──────────────────────────
// Fetches 15m / 1H indicator snapshots and derives a directional bias using the
// same persistent-EMA logic the worker's inferHTFDirection uses (ema20 vs ema50
// + MACD histogram + RSI). Serves both the Scalp HTF bias filter (item 6) and
// the unified agreement score (item 8). A short TTL cache keeps repeated calls
// cheap — the worker already refreshes its own HTF cache every 30s.
const HTF_CACHE_MS = 20_000
const HTF_SPAN_MS: Record<string, number> = {
  '1m': 60_000, '3m': 3 * 60_000, '5m': 5 * 60_000, '15m': 15 * 60_000,
  '30m': 30 * 60_000, '1H': 60 * 60_000, '1h': 60 * 60_000, '4H': 4 * 60 * 60_000,
  '4h': 4 * 60 * 60_000, '1D': 24 * 60 * 60_000, 'Daily': 24 * 60 * 60_000,
}
const htfCache = new Map<string, { at: number; bias: 'BUY' | 'SELL' | null; simulated: boolean }>()

async function fetchHtfBias(pair: string, timeframe: string): Promise<'BUY' | 'SELL' | null> {
  const key = `${pair}:${timeframe}`
  const hit = htfCache.get(key)
  if (hit && Date.now() - hit.at < HTF_CACHE_MS) return hit.simulated ? null : hit.bias
  try {
    const { candles, simulated } = await getMarketCandles(undefined, pair, timeframe, 200)
    // Closed-candle audit 2026-09-04: never let a forming 15M/1H bar leak into
    // the HTF confirmation — restrict indicators to fully closed candles.
    const span = HTF_SPAN_MS[timeframe] || 15 * 60_000
    const sel = selectLatestClosedCandle(candles, span, Date.now(), `htf:${key}`)
    let data = candles
    if (!sel.none && sel.closedCount > 1 && sel.closedCount <= candles.length) {
      data = candles.slice(0, sel.closedCount)
    }
    const ind = calculateIndicators(data)
    const ema20AboveEma50 = ind.ema20 > ind.ema50
    let bias: 'BUY' | 'SELL' | null = null
    if (ema20AboveEma50 && ind.macdHistogram > 0 && ind.rsi > 50)  bias = 'BUY'
    else if (!ema20AboveEma50 && ind.macdHistogram < 0 && ind.rsi < 50) bias = 'SELL'
    htfCache.set(key, { at: Date.now(), bias, simulated })
    // Never bias-filter on simulated HTF data — a fake trend would be worse
    // than no trend signal.
    return simulated ? null : bias
  } catch {
    return null  // feed unavailable → no bias opinion
  }
}

/** Admin cache-clear hook: drop cached 15m/1H bias reads. */
export function clearHtfBiasCache(): void {
  htfCache.clear()
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

async function queryMlService(body: any, pair: string, direction: Direction, confidence: number, regime?: string): Promise<{
  win_probability: number; should_trade: boolean; ml_confidence: number
  feature_contributions: Record<string, { importance: number; value: number }>
  regime?: string | null; model?: string; calibration_method?: string; model_auc?: number | null
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
        regime:            regime ?? null,   // Phase 3 (item 11): regime routing
      }),
    })
    clearTimeout(timer)
    if (!resp.ok) return null
    return await resp.json()
  } catch {
    return null
  }
}

// ── Per-candle evaluation cache (audit fix 2026-09-04) ─────────────────────
// Candle identity = pair + broker-frame CLOSE time of the latest fully closed
// candle. Repeats of the SAME closed candle return the cached result quickly
// with candleDuplicate=true so worker/browser/API callers never double-run the
// engine. DB uniqueness below is the durable backstop across restarts; this
// cache just stops redundant LLM/AI spend while a candle remains current.
const EVAL_CACHE_TTL_MS = 10 * 60_000
const evalCache = new Map<string, { at: number; body: any }>()
const _gateLog = new Map<string, number>()

/** Broker-frame close time (ms) of the candle under evaluation. */
function closeTimeMs(body: any): number | null {
  if (body && typeof body.candleCloseTime === 'string') {
    const t = new Date(body.candleCloseTime).getTime()
    if (Number.isFinite(t)) return t
  }
  if (body && typeof body.lastCandleTime === 'string') {
    const t = new Date(body.lastCandleTime).getTime()
    if (Number.isFinite(t)) return t + 5 * 60_000
  }
  return null
}

/** ISO string form for TIMESTAMPTZ columns (PostgREST rejects epoch-ms numbers with 22008). */
function closeTimeIso(body: any): string | null {
  const ms = closeTimeMs(body)
  return ms === null ? null : new Date(ms).toISOString()
}

function candleKeyOf(body: any): string | null {
  const pair = typeof body?.pair === 'string' && body.pair ? body.pair : null
  const ct = closeTimeMs(body)
  return pair && ct !== null ? `${pair}:${ct}` : null
}

function logGateRejection(
  body: any,
  gate: { filterName: string; reason: string; value?: number | null; threshold?: number | null },
  pair: string,
  userId?: string,
): void {
  try {
    // Suppress repeated rejections for the SAME candle (6-min window): with
    // closed-candle evaluation a gate now fires once per candle, not once per
    // worker sweep. Keeps rejection counters measuring evaluations, not polls.
    const logKey = body
      ? `${String(body?.pair ?? '?')}|${gate.filterName}|${closeTimeMs(body) ?? String(body?.lastCandleTime ?? 'no-candle')}`
      : null
    if (logKey) {
      const last = _gateLog.get(logKey)
      if (last && Date.now() - last < 6 * 60_000) return
      _gateLog.set(logKey, Date.now())
    }
    const admin = getAdminClient()
    void (async () => {
      try {
        await admin.from('filter_rejections').insert({
          user_id: userId ?? null,
          pair,
          direction: 'HOLD',
          filter_name: gate.filterName,
          filter_stage: 'pre',
          rejection_value: gate.value ?? null,
          threshold: gate.threshold ?? null,
          reason: gate.reason,
          signal_id: null,
          indicator_snapshot: {
            simulated: body?.simulated ?? null,
            candleCount: body?.candleCount ?? null,
            candleClosed: body?.candleClosed ?? null,
            lastCandleTime: body?.lastCandleTime ?? null,
            marketHealth: body?.marketHealth ?? null,
          },
        })
      } catch (e: any) {
        console.warn('[gate-rejection]', e?.message)
      }
    })()
  } catch { /* never throw */ }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const { pair, strategy, userId } = body as { pair: string; strategy: Strategy; userId?: string }

    // Hard block: never generate a tradable signal from simulated market data
    if (body.simulated === true) {
      logGateRejection(body, { filterName: 'simulated_feed', reason: 'Live data required — simulated feed detected' }, pair, userId)
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

    // ── Market-data health watchdog gate (audit 2026-09-03) ───────────────────
    // If the tick route detected a broker-clock error or a stalled candle feed
    // (dataSuspended=true) we REFUSE to generate — another silent clock bug
    // must not produce invalid trades.
    if (body.dataSuspended === true) {
      const mh = body.marketHealth || {}
      const reason = mh.reason || 'Market-data health watchdog: signal generation suspended'
      logGateRejection(body, { filterName: 'market-data-time-error', reason, value: typeof mh.status === 'string' ? mh.status : null }, pair, userId)
      return NextResponse.json({
        direction:  'HOLD' as Direction,
        confidence: 0,
        reasons:    [reason],
        risk_note:  'Signal blocked: market-data health check failed (broker clock / stale feed). No invalid trades will be generated while unhealthy.',
        entry: body.price || 0, sl: body.price || 0, tp: body.price || 0,
        fallback: false,
        marketDataSuspended: true,
        ml: null,
      })
    }

    // ── Per-candle dedupe (audit fix 2026-09-04) ──────────────────────────────
    // Evaluate each fully closed candle at most once: first caller runs the
    // full pipeline; repeat requests for the SAME candle return the cached
    // result marked candleDuplicate=true. Durable uniqueness on the DB tables
    // (migration 20260904) is the backstop across process/API restarts.
    const candleKey = candleKeyOf(body)
    if (candleKey && body.candleClosed !== false) {
      const hit = evalCache.get(candleKey)
      if (hit && Date.now() - hit.at < EVAL_CACHE_TTL_MS) {
        return NextResponse.json({
          ...hit.body,
          candleDuplicate: true,
          cachedEvaluation: true,
          _cachedAt: new Date(hit.at).toISOString(),
          evaluatedAt: new Date().toISOString(),
          evaluatedCandleTime: typeof body?.candleCloseTime === 'string'
            ? body.candleCloseTime
            : (candleKey ? new Date(Number(candleKey.slice(candleKey.indexOf(':') + 1))).toISOString() : null),
          formingCandle: body?.formingCandle === true,
        })
      }
    }

    // Candle-closed gate (audit Phase 1.1 + 2026-09-04): the tick route now
    // evaluates indicators over the latest FULLY CLOSED candle and returns
    // candleClosed=true whenever such a candle exists (a forming current bar is
    // normal — it never blocks evaluation of the previous closed candle). This
    // gate therefore fires ONLY when the feed genuinely has no usable closed
    // candle (empty/barely-warmed feed) — the former 1-2s timing bottleneck is
    // gone. Absent field (older callers / tests) is not blocked.
    if (body.candleClosed === false) {
      logGateRejection(body, { filterName: 'candle_open', reason: 'No valid closed candle available in feed — waiting for the first completed candle', value: body.lastCandleTime ? 0 : null }, pair, userId)
      return NextResponse.json({
        direction:  'HOLD' as Direction,
        confidence: 0,
        reasons:    ['No valid closed candle available — feed has no completed candle to evaluate yet'],
        risk_note:  'Signal blocked: a fully closed candle is required. A forming current candle is normal; the previous closed candle is used once available.',
        entry: body.price || 0, sl: body.price || 0, tp: body.price || 0,
        fallback: false,
        candleOpen: true,
        ml: null,
      })
    }

    // History block: EMA50/ADX computed on <100 bars are poorly converged
    // — a direction from half-warmed indicators is noise with a confidence
    // number attached. Callers forward the tick verbatim, so candleCount is
    // present whenever the tick route produced the data. Absent field (older
    // callers / tests) is not blocked.
    if (typeof body.candleCount === 'number' && body.candleCount < 100) {
      logGateRejection(body, { filterName: 'insufficient_bars', reason: `Only ${body.candleCount} bars — indicators not warmed`, value: body.candleCount, threshold: 100 }, pair, userId)
      return NextResponse.json({
        direction:  'HOLD' as Direction,
        confidence: 0,
        reasons:    [`Only ${body.candleCount} bars available — indicators not fully warmed (need 100+)`],
        risk_note:  'Signal blocked: insufficient candle history for reliable indicators.',
        entry: body.price || 0, sl: body.price || 0, tp: body.price || 0,
        fallback: false,
        insufficientBars: true,
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
      logGateRejection(body, { filterName: 'adx_chop', reason: `ADX ${t.adx.toFixed(1)} below 15 — true chop`, value: t.adx, threshold: 15 }, pair, userId)
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

    // ── Live-spread gate (audit Phase 1.4) ──────────────────────────────────
    // Blocks signals when the REAL bid/ask spread is too wide relative to ATR.
    // Entering through a wide spread hands back most of the expected move, so
    // this is a hard block (not just a confidence penalty) — but ONLY when the
    // spread is live market data. The static per-instrument default is an
    // estimate, not a market condition, and is handled by the soft penalty in
    // fallbackSignal() instead. Threshold matches the strategy prompts and the
    // rule engine: >40% of ATR.
    if (t.spreadSource === 'live' && t.atrPips > 0 && t.spreadPips > t.atrPips * 0.4) {
      const reason = `Live spread ${t.spreadPips.toFixed(1)} pips exceeds 40% of ATR (${t.atrPips.toFixed(1)} pips) — wide-spread gate`
      console.log(`[scalper/signal] ${reason} (${pair})`)
      logGateRejection(body, { filterName: 'spread_gate', reason, value: t.spreadPips, threshold: +(t.atrPips * 0.4).toFixed(1) }, pair, userId)
      return NextResponse.json({
        direction:            'HOLD' as Direction,
        confidence:           0,
        reasons:              [reason],
        risk_note:            'Signal blocked: live bid/ask spread too wide relative to ATR. Wait for spread to normalise.',
        entry:                t.price,
        sl:                   t.price,
        tp:                   t.price,
        fallback:             false,
        spreadGate:           true,
        spreadPips:           t.spreadPips,
        atrPips:              t.atrPips,
        bid:                  t.bid ?? null,
        ask:                  t.ask ?? null,
        ml:                   null,
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
    // Spot-check audit trail — captures the raw engine output and every gate
    // action so any persisted signal can be verified against a chart.
    let rawResponse: string | null = null
    let disciplineAction: string | null = null
    let htfAction: string | null = null

    const hasKey = hasLlmKey()

    if (!hasKey) {
      console.warn(`[scalper/signal] LLM key for provider "${providerLabel()}" not set or is placeholder — using rule-based fallback`)
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
        const { text } = await llmComplete({
          system:    systemPrompt,
          user:      userMsg,
          maxTokens: 600,
        })
        const clean = (text || '{}').replace(/```json|```/g, '').trim()
        rawResponse = clean.slice(0, 500)
        const parsed = JSON.parse(clean)
        // Schema validation — parseable-but-junk JSON ({} or a non-enum
        // direction) must not flow downstream: an unvalidated direction skips
        // the discipline gate and the worker's mirror inversion maps any
        // non-'BUY' string to 'BUY'.
        const validDirection = parsed?.direction === 'BUY' || parsed?.direction === 'SELL' || parsed?.direction === 'HOLD'
        const numConfidence  = Number(parsed?.confidence)
        const validConfidence = Number.isFinite(numConfidence) && numConfidence >= 0 && numConfidence <= 100
        if (!validDirection || !validConfidence) {
          console.warn(`[scalper/signal] LLM response failed validation (direction=${JSON.stringify(parsed?.direction)}, confidence=${JSON.stringify(parsed?.confidence)}) — using rule-based fallback. Raw: ${clean.slice(0, 500)}`)
          result   = fallbackSignal(t, strategy, pair)
          fallback = true
        } else {
          parsed.confidence = numConfidence
          result = parsed
        }
      } catch (e: any) {
        console.error(`[scalper/signal] LLM error (${providerLabel()}):`, e?.status, e?.message)
        result   = fallbackSignal(t, strategy, pair)
        fallback = true
      }
    }

    // Engine output before any gate touches it — the discipline and ML gates
    // below may demote direction/confidence; the audit block records both.
    const preGateDirection:  Direction | null = result.direction  ?? null
    const preGateConfidence: number | null    = typeof result.confidence === 'number' ? result.confidence : null

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
        disciplineAction = `demoted-to-HOLD: AI ${aiDir} vs consensus ${voteStr}`
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
    const mlQueryDirection = result.direction as Direction
    // Phase 3 (item 11): route the ML request to a regime-specific model when
    // one exists. Uses the same ADX→regime classification the gate uses.
    const mlRegime = strategy === 'Scalp' ? classifyRegime(t.adx).regime : undefined
    mlData = await queryMlService(body, pair, mlQueryDirection, result.confidence, mlRegime)

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

    // ── Multi-timeframe 15M/1H bias filter (audit Phase 2, item 6) ────────────
    // Scalp previously skipped the 15M HTF check in the worker and the browser
    // path had no 1H/15M bias filter. This server-side filter applies the same
    // top-down discipline to both paths: when the 5m direction contradicts a
    // CLEAR 15m or 1H trend, the signal is penalised; when it contradicts BOTH
    // higher-timeframe biases, the signal is demoted to HOLD. Ambiguous HTF
    // (null bias — ranging regime) is NOT a penalty: ranging is Scalp's
    // highest-edge condition and a null HTF means "no trend to respect".
    let htfBias15m: Direction | null = null
    let htfBias1h:  Direction | null = null
    if (strategy === 'Scalp' && result.direction !== 'HOLD') {
      const [b15, b1h] = await Promise.all([
        fetchHtfBias(pair, '15m'),
        fetchHtfBias(pair, '1H'),
      ])
      htfBias15m = b15
      htfBias1h  = b1h

      const dir    = result.direction as Direction
      const opp15  = b15 !== null && b15 !== dir
      const opp1h  = b1h !== null && b1h !== dir
      const align15 = b15 === dir
      const align1h = b1h === dir

      if (opp15 && opp1h) {
        // Both HTFs clearly oppose the 5m scalp direction → hard block.
        htfAction = `HTF-block: 5m ${dir} opposes 15m ${b15} AND 1H ${b1h}`
        console.log(`[scalper/signal] ${htfAction} (${pair})`)
        result.direction = 'HOLD' as Direction
        result.reasons   = [
          ...(result.reasons || []).slice(0, 3),
          `Multi-TF filter: 15m=${b15} 1H=${b1h} both oppose ${dir} — blocked`,
        ]
      } else if (opp15 || opp1h) {
        // One HTF opposes — confidence penalty (not a block; the other HTF is
        // either aligned or ambiguous).
        const penalty = 10
        result.confidence = Math.max(0, result.confidence - penalty)
        htfAction = `HTF-penalty: 5m ${dir} vs ${opp15 ? `15m ${b15}` : ''}${opp15 && opp1h ? ' + ' : ''}${opp1h ? `1H ${b1h}` : ''} (−${penalty} conf)`
        result.reasons = [...(result.reasons || []), htfAction]
      } else if (align15 && align1h) {
        // Both HTFs confirm → small confidence boost.
        result.confidence = Math.min(98, result.confidence + 5)
        htfAction = `HTF-confirm: 15m ${b15} + 1H ${b1h} confirm ${dir} (+5)`
      }
      // Any null HTF bias (ambiguous trend) → no change. Ranging is valid for
      // Scalp; only a clear opposing bias is filtered.
    }

    // ── Unified Signal Agreement Score (audit Phase 2, item 8) ────────────────
    // How many independent engines agree with the FINAL direction:
    //   5M rule consensus · 15M bias · 1H bias · ML win-prob · rule engine.
    // Each component contributes a directional vote; the score is the fraction
    // of non-null votes matching the final direction (0-100). The worker
    // auto-trade gate consumes this as an additional quality filter.
    let agreementScore: number | null = null
    let agreementVotes: { source: string; direction: Direction | null }[] = []
    if (result.direction !== 'HOLD') {
      const { bullVotes, bearVotes } = scalpConsensus(t)
      const m5Dir: Direction | null = bullVotes >= 4 ? 'BUY' : bearVotes >= 4 ? 'SELL' : null
      const ruleDir = fallbackSignal(t, strategy, pair).direction
      const mlDir: Direction | null = (mlData && typeof mlData.win_probability === 'number' && mlQueryDirection !== 'HOLD')
        ? (mlData.win_probability >= 0.5 ? mlQueryDirection : (mlQueryDirection === 'BUY' ? 'SELL' : 'BUY'))
        : null
      agreementVotes = [
        { source: '5M',  direction: m5Dir },
        { source: '15M', direction: htfBias15m },
        { source: '1H',  direction: htfBias1h },
        { source: 'ML',  direction: mlDir },
        { source: 'rule', direction: ruleDir === 'HOLD' ? null : ruleDir },
      ]
      const opinionated = agreementVotes.filter(v => v.direction !== null)
      const agreeing    = opinionated.filter(v => v.direction === result.direction).length
      agreementScore    = opinionated.length > 0 ? Math.round((agreeing / opinionated.length) * 100) : null
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

    // Spot-check audit trail (audit 2026-07-02): everything needed to verify
    // this prediction against a chart — which engine decided, what it said
    // verbatim, and what each gate did to it afterwards.
    const audit = {
      engine:            fallback ? 'rules' : providerLabel(),
      rawResponse,       // LLM raw text (≤500 chars); null on rules engine
      disciplineAction,  // non-null when the consensus guard demoted to HOLD
      htfAction,         // non-null when the multi-TF bias filter modified the signal
      agreementScore,    // 0-100 unified agreement across 5M/15M/1H/ML/rule
      agreementVotes,
      mlWinProb:         mlData?.win_probability ?? null,
      // Phase 3 provenance — which ML model + calibration produced the gate input
      mlModel:           mlData?.model ?? null,
      mlRegime:          mlData?.regime ?? mlRegime ?? null,
      mlCalibration:     mlData?.calibration_method ?? null,
      mlModelAuc:        mlData?.model_auc ?? null,
      preGateDirection,
      preGateConfidence,
    }

    // Attach market-regime metadata (Scalp only — other strategies have their
    // own ADX semantics). AutoTradePage and worker use these to gate execution
    // and to override section bias per-signal.
    //
    // Phase 2 (item 7): the NO-TRADE minStrength threshold is now taken from
    // calibrated historical evidence (win rate by regime/confidence band in
    // lib/threshold-calibration.ts) when enough resolved signals exist, falling
    // back to the original heuristic classifyRegime() values otherwise.
    const regimeInfo = strategy === 'Scalp' ? classifyRegime(t.adx) : null
    let thresholdSource: 'calibrated' | 'heuristic' = 'heuristic'
    if (regimeInfo) {
      const calibrated = await getCalibratedMinStrengths()
      const calibMin   = calibrated[regimeInfo.regime]
      if (typeof calibMin === 'number') {
        regimeInfo.effectiveMinStrength = calibMin
        thresholdSource = 'calibrated'
      }
    }
    const regimeMeta = regimeInfo ? { ...regimeInfo, adx: t.adx } : null

    // ── Canonical prediction contract (Phase 2) ──────────────────────────────
    // Prediction start = the server timestamp of THIS evaluation. The DB's
    // created_at (insert default) and prediction_expires_at are anchored to the
    // same instant, so the API/UI/database never disagree on the window. The
    // evaluated candle is the latest fully-closed M5 candle: broker-frame OPEN
    // = closed-candle close time − 5 min.
    const evalStartedAtIso = new Date().toISOString()
    const evalCandleOpenIso = (() => {
      const closeMs = closeTimeMs(body)
      return closeMs === null ? null : new Date(closeMs - 5 * 60_000).toISOString()
    })()
    const predictionMeta = buildPredictionMeta(evalStartedAtIso, result.entry ?? null)

    // Persist to signals table (audit Phase 1.5)
    // `direction` remains the final gated direction. `predicted_direction`
    // stores the raw engine output before any gate (discipline/ML) touched it,
    // so we can later measure whether the filters actually improve accuracy.
    // `_regime` is persisted so the threshold calibration (item 7) can read the
    // regime for EVERY signal, not just worker-generated rows.
    const gatingReasons = [
      ...(audit.disciplineAction ? [audit.disciplineAction] : []),
      ...(htfAction ? [htfAction] : []),
    ]
    if (userId && result.direction !== 'HOLD') {
      try {
        const admin = getAdminClient()
        const predictionRow = {
          user_id:             userId,
          pair,
          timeframe:           'scalper',
          direction:           result.direction,
          predicted_direction: preGateDirection,
          gating_reasons:      gatingReasons,
          confidence:          result.confidence,
          entry:               result.entry ?? null,
          sl:                  result.sl ?? null,
          tp:                  result.tp ?? null,
          candle_close_time:   closeTimeIso(body),
          // Canonical prediction metadata (Phase 2 — lib/prediction-contract.mjs)
          prediction_window_ms:   PREDICTION_WINDOW_MS,
          prediction_timeframe:   PREDICTION_TIMEFRAME,
          prediction_candles:     PREDICTION_FUTURE_CANDLES,
          resolution_rule:        PREDICTION_RESOLUTION_RULE,
          prediction_expires_at:  predictionMeta?.expiresAt ?? null,
          evaluated_candle_time:  evalCandleOpenIso,
          regime:              regimeMeta?.regime ?? null,
          agreement_score:     agreementScore ?? null,
          ml_model:            audit.mlModel ?? null,
          ml_regime:           audit.mlRegime ?? null,
          ml_calibration:      audit.mlCalibration ?? null,
          ml_model_auc:        audit.mlModelAuc ?? null,
          indicator_snapshot:  {
            ...body,
            _computed: { entry: result.entry, sl: result.sl, tp: result.tp },
            _regime:   regimeMeta ? {
              marketRegime:         regimeMeta.regime,
              effectiveMinStrength: regimeMeta.effectiveMinStrength,
              suggestedSection:     regimeMeta.suggestedSection,
              adx:                  regimeMeta.adx,
            } : null,
            _audit:    audit,
          },
        }
        await admin.from('signals').upsert({
          user_id:            userId,
          pair,
          timeframe:          'scalper',
          direction:          result.direction,
          predicted_direction: preGateDirection,
          gating_reasons:     gatingReasons,
          confidence:         result.confidence,
          checklist_score:    0,
          reasons:            result.reasons,
          risk_note:          result.risk_note,
          acted_on:           false,
          outcome:            'PENDING',
          candle_close_time:  closeTimeIso(body),
          indicator_snapshot: {
            ...body,
            _computed: { entry: result.entry, sl: result.sl, tp: result.tp },
            // Phase 2 (item 7): feed threshold calibration — same shape the
            // worker writes (marketRegime key) so calibration reads both paths.
            _regime: regimeMeta ? {
              marketRegime:         regimeMeta.regime,
              effectiveMinStrength: regimeMeta.effectiveMinStrength,
              suggestedSection:     regimeMeta.suggestedSection,
              adx:                  regimeMeta.adx,
            } : null,
            _audit:    audit,
          },
        }, { onConflict: 'user_id,pair,candle_close_time', ignoreDuplicates: true })
        // Phase 4 (item 13): prediction_logs — the same prediction, captured in
        // the auditable log the worker resolves into MFE/MAE + price samples.
        // Fire-and-forget: a logging failure must never affect the signal path.
        try {
          await admin.from('prediction_logs').upsert(predictionRow, { onConflict: 'user_id,pair,candle_close_time', ignoreDuplicates: true })
        } catch (e: any) {
          console.warn('[scalper/signal] prediction_logs insert skipped:', e?.message)
        }
      } catch { /* non-critical */ }
    }


    // ── Expectancy / Safety / Authority — SHADOW layer (2026-09-02) ──────────
    // Advisory only: evaluates the final gated signal against historical
    // segment expectancy + safety + authority, records the decision snapshot,
    // and alerts only when a setup is genuinely qualified. NEVER alters the
    // direction/confidence or the execution path above. Runs for Scalp (the
    // canonical 5m XAU/XAG path) so both the browser AND the 24/7 worker
    // benefit from the same server-side evaluation.
    let intel: { expectancy: any; safety: any; authority: any; setupOutcome: any } | null = null
    if (strategy === 'Scalp' && result.direction !== 'HOLD') {
      try {
        const slDistPips = result.sl && result.entry
          ? Math.abs(result.sl - result.entry) / pip
          : null
        intel = await evaluateSetup({
          pair,
          direction: result.direction,
          userId: userId || undefined,
          mode: 'shadow',
          timeframe: '5m',
          regime: regimeMeta?.regime ?? null,
          session: sessionOf(new Date()),
          spreadPips: t.spreadPips,
          atrPips: t.atrPips,
          spreadSource: t.spreadSource ?? 'default',
          slPips: slDistPips,
          htfBias15m: htfBias15m as 'BUY' | 'SELL' | null,
          htfBias1h: htfBias1h as 'BUY' | 'SELL' | null,
          signalScore: result.confidence,
          mlWinProb: mlData?.win_probability ?? null,
          agreementScore: agreementScore,
          reasons: result.reasons ?? [],
          entry: result.entry ?? null,
          sl: result.sl ?? null,
          tp: result.tp ?? null,
          snapshot: {
            engine: fallback ? 'rules' : providerLabel(),
            preGateDirection,
            preGateConfidence,
            regimeAdx: regimeMeta?.adx ?? null,
            effectiveMinStrength: regimeMeta?.effectiveMinStrength ?? null,
            tick: { price: t.price, spreadPips: t.spreadPips, atrPips: t.atrPips, adx: t.adx, rsi14: t.rsi14 },
          },
        })
      } catch (e: any) {
        console.warn('[scalper/signal] shadow intelligence skipped:', e?.message)
      }
    }

    const payload = {
      ...result,
      fallback,
      ml: mlData,
      _audit: audit,
      // Canonical prediction contract (Phase 2). expiresAt is server-fixed for
      // the evaluated candle — repeat polls for the same candle return this same
      // block (the frontend must never extend it).
      prediction:       predictionMeta,
      evaluatedCandleTime: typeof body?.candleCloseTime === 'string'
        ? body.candleCloseTime
        : (candleKey ? new Date(Number(candleKey.slice(candleKey.indexOf(':') + 1))).toISOString() : null),
      marketRegime:         regimeMeta?.regime ?? null,
      effectiveMinStrength: regimeMeta?.effectiveMinStrength ?? null,
      thresholdSource,       // Phase 2 (item 7): 'calibrated' | 'heuristic'
      suggestedSection:     regimeMeta?.suggestedSection ?? null,
      adx:                  regimeMeta?.adx ?? null,
      // Phase 2 (item 8): unified agreement score across 5M/15M/1H/ML/rule.
      agreementScore,        // 0-100, null when the signal was gated to HOLD
      agreementVotes,        // [{ source, direction }] per component
      htfBias15m,            // Phase 2 (item 6): 15m trend bias at signal time
      htfBias1h,             // Phase 2 (item 6): 1H trend bias at signal time
      htfAction,             // human-readable multi-TF filter outcome
      // New expectancy-intelligence layer (shadow; see migration 20260902).
      expectancy: intel?.expectancy ?? null,
      safety:     intel?.safety ?? null,
      authority:  intel?.authority ?? null,
    }

    // Cache the evaluation against its closed-candle identity so repeat polls
    // for the same candle are served (deduplicated) instead of re-run.
    if (candleKey) evalCache.set(candleKey, { at: Date.now(), body: payload })

    // Separate evaluation time from candle time (auditability): evaluatedAt =
    // when this API request ran; evaluatedCandleTime = the candle that was
    // evaluated (may be minutes older — that is valid and expected).
    return NextResponse.json({
      ...payload,
      candleDuplicate:   false,
      cachedEvaluation:  false,
      evaluatedAt:       new Date().toISOString(),
      evaluatedCandleTime: typeof body?.candleCloseTime === 'string'
        ? body.candleCloseTime
        : (candleKey ? new Date(Number(candleKey.slice(candleKey.indexOf(':') + 1))).toISOString() : null),
      formingCandle:     body?.formingCandle === true,
    })

    return NextResponse.json({
      ...result,
      fallback,
      ml: mlData,
      _audit: audit,
      marketRegime:         regimeMeta?.regime ?? null,
      effectiveMinStrength: regimeMeta?.effectiveMinStrength ?? null,
      thresholdSource,       // Phase 2 (item 7): 'calibrated' | 'heuristic'
      suggestedSection:     regimeMeta?.suggestedSection ?? null,
      adx:                  regimeMeta?.adx ?? null,
      // Phase 2 (item 8): unified agreement score across 5M/15M/1H/ML/rule.
      agreementScore,        // 0-100, null when the signal was gated to HOLD
      agreementVotes,        // [{ source, direction }] per component
      htfBias15m,            // Phase 2 (item 6): 15m trend bias at signal time
      htfBias1h,             // Phase 2 (item 6): 1H trend bias at signal time
      htfAction,             // human-readable multi-TF filter outcome
    })
  } catch (error: any) {
    console.error('[scalper/signal]', error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}
