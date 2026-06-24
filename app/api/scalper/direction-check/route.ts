// app/api/scalper/direction-check/route.ts
//
// Direction-confirmation analysis for a single pair.
// Runs the 5 scalp strategies in parallel (5 fresh signals), then evaluates
// each side (as-is = "scalp" / inverted = "mirror") against a market-bias
// proxy computed from the live indicator tick. Returns which side is better
// aligned with current market behaviour, the recommended direction, a
// blended confidence score, and human-readable reasoning.
//
// Pure server-side wiring — uses the existing /api/scalper/tick + signal
// endpoints. No new Claude prompts here; the 5 strategy prompts are the
// canonical ones that already power the per-strategy signal route.
export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { classifyRegime, type MarketRegime } from '@/app/api/scalper/signal/route'

type Direction = 'BUY' | 'SELL' | 'HOLD'
type StrategyName = 'Momentum' | 'Mean Reversion' | 'Breakout' | 'Order Flow' | 'Scalp'

const STRATEGIES: StrategyName[] = ['Momentum', 'Mean Reversion', 'Breakout', 'Order Flow', 'Scalp']

interface PerStrategyResult {
  strategy: StrategyName
  direction: Direction
  confidence: number
  fallback: boolean
}

// Volatility override threshold. ATR/price ratios above this read as
// "volatile" regardless of ADX — the trend may be present but the price
// action is too erratic to size aggressively.
const VOLATILE_ATR_RATIO = 0.0035   // 0.35% of price per ATR period

function regimeToMarketType(regime: MarketRegime | null, atr: number, price: number): string {
  if (price > 0 && atr / price > VOLATILE_ATR_RATIO) return 'Volatile'
  switch (regime) {
    case 'chop':         return 'Consolidating'
    case 'ranging':      return 'Ranging'
    case 'weak-trend':   return 'Weak Trend'
    case 'trending':     return 'Trending'
    case 'strong-trend': return 'Strong Trending'
    default:             return 'Unknown'
  }
}

// 5-indicator vote synthesises an independent "current market bias" that we
// then compare each signal's direction against. Mirrors the scalpConsensus
// helper in /api/scalper/signal but lives here so the route can be self-
// contained (avoids importing internal helpers across routes).
function marketBiasFromTick(tick: any): { bias: 'BUY' | 'SELL' | 'NEUTRAL'; bullVotes: number; bearVotes: number } {
  const rsi14         = Number(tick.rsi14 ?? 50)
  const ema9          = Number(tick.ema9  ?? 0)
  const ema21         = Number(tick.ema21 ?? 0)
  const macdHistogram = Number(tick.macdHistogram ?? 0)
  const buyPressure   = Number(tick.buyPressure   ?? 0.5)
  const bbUpper       = Number(tick.bbUpper ?? 0)
  const bbLower       = Number(tick.bbLower ?? 0)
  const price         = Number(tick.price   ?? 0)
  const bbMid         = (bbUpper + bbLower) / 2

  const votes = [
    rsi14 > 50,
    ema9 > ema21,
    macdHistogram > 0,
    buyPressure > 0.5,
    price > bbMid,
  ]
  const bullVotes = votes.filter(v => v).length
  const bearVotes = 5 - bullVotes
  const bias: 'BUY' | 'SELL' | 'NEUTRAL' =
    bullVotes >= 4 ? 'BUY' : bearVotes >= 4 ? 'SELL' : 'NEUTRAL'
  return { bias, bullVotes, bearVotes }
}

// Agreement check: did the signal pick the same direction as the bias?
// HOLD scores zero on both sides (it's not picking a side).
function scoreAgainstBias(direction: Direction, bias: 'BUY' | 'SELL' | 'NEUTRAL'): 1 | 0 | -1 {
  if (direction === 'HOLD' || bias === 'NEUTRAL') return 0
  return direction === bias ? 1 : -1
}

function majorityDirection(results: PerStrategyResult[]): Direction {
  let buy = 0, sell = 0
  for (const r of results) {
    if (r.direction === 'BUY')  buy++
    else if (r.direction === 'SELL') sell++
  }
  if (buy === sell) return 'HOLD'
  return buy > sell ? 'BUY' : 'SELL'
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const pair: string = body?.pair
    const userId: string | undefined = body?.userId
    // Timeframe is operator-controlled (1m or 5m). Default to 5m to match the
    // rest of the scalp pipeline; 1m gives finer-grained reads at the cost of
    // noisier ADX/MACD signals.
    const requestedTf = String(body?.timeframe ?? '5m').toLowerCase()
    const timeframe: '1m' | '5m' = requestedTf === '1m' ? '1m' : '5m'
    if (!pair) return NextResponse.json({ error: 'pair required' }, { status: 400 })

    const origin = req.nextUrl.origin
    const authHeader = req.headers.get('Authorization') || ''

    // Step 1: fetch tick once — used as input to all 5 strategy signal calls
    const tickResp = await fetch(
      `${origin}/api/scalper/tick?pair=${encodeURIComponent(pair)}&timeframe=${timeframe}`,
      { headers: { Authorization: authHeader }, cache: 'no-store' },
    )
    if (!tickResp.ok) {
      return NextResponse.json({ error: `tick fetch failed: ${tickResp.status}` }, { status: 502 })
    }
    const tick = await tickResp.json()
    if (tick?.simulated) {
      return NextResponse.json({
        pair,
        error: 'Live MT5 feed required — simulated data detected',
        simulated: true,
      }, { status: 200 })
    }

    // Step 2: fan-out 5 parallel signal calls, one per strategy
    const signalCalls = STRATEGIES.map(async (strategy): Promise<PerStrategyResult> => {
      try {
        const r = await fetch(`${origin}/api/scalper/signal`, {
          method:  'POST',
          headers: { 'Content-Type': 'application/json', Authorization: authHeader },
          body:    JSON.stringify({ ...tick, pair, strategy, userId }),
        })
        if (!r.ok) return { strategy, direction: 'HOLD', confidence: 0, fallback: true }
        const j = await r.json()
        return {
          strategy,
          direction:  (j.direction as Direction) ?? 'HOLD',
          confidence: Number(j.confidence ?? 0),
          fallback:   Boolean(j.fallback),
        }
      } catch {
        return { strategy, direction: 'HOLD', confidence: 0, fallback: true }
      }
    })
    const scalpResults = await Promise.all(signalCalls)

    // Mirror = same 5 results with direction inverted (HOLD stays HOLD)
    const mirrorResults: PerStrategyResult[] = scalpResults.map(r => ({
      strategy:   r.strategy,
      confidence: r.confidence,
      fallback:   r.fallback,
      direction:  r.direction === 'BUY' ? 'SELL'
                : r.direction === 'SELL' ? 'BUY'
                : 'HOLD',
    }))

    // Step 3: derive market bias + regime
    const { bias, bullVotes, bearVotes } = marketBiasFromTick(tick)
    const adx = Number(tick.adx ?? 0)
    const regimeInfo = classifyRegime(adx)
    const marketType = regimeToMarketType(regimeInfo.regime, Number(tick.atr ?? 0), Number(tick.price ?? 0))

    // Step 4: score both groups
    const scalpAgreement  = scalpResults.reduce((sum, r)  => sum + Math.max(0, scoreAgainstBias(r.direction,  bias)), 0)
    const mirrorAgreement = mirrorResults.reduce((sum, r) => sum + Math.max(0, scoreAgainstBias(r.direction, bias)), 0)
    const avgConf  = (xs: PerStrategyResult[]) =>
      xs.length ? xs.reduce((s, r) => s + r.confidence, 0) / xs.length : 0
    const scalpAvgConf  = Math.round(avgConf(scalpResults))
    const mirrorAvgConf = Math.round(avgConf(mirrorResults))

    // Step 5: pick the winning group
    // Primary tiebreak by agreement count. If tied, take the side with higher
    // average confidence; if still tied, prefer scalp (canonical direction).
    let recommended: 'scalp' | 'mirror'
    if (scalpAgreement !== mirrorAgreement) {
      recommended = scalpAgreement > mirrorAgreement ? 'scalp' : 'mirror'
    } else if (scalpAvgConf !== mirrorAvgConf) {
      recommended = scalpAvgConf > mirrorAvgConf ? 'scalp' : 'mirror'
    } else {
      recommended = 'scalp'
    }

    const winningGroup = recommended === 'scalp' ? scalpResults : mirrorResults
    const direction = majorityDirection(winningGroup)

    // Step 6: blended confidence — 60% agreement rate, 40% signal quality
    const agreementCount = recommended === 'scalp' ? scalpAgreement : mirrorAgreement
    const agreementRate  = agreementCount / 5
    const groupAvgConf   = recommended === 'scalp' ? scalpAvgConf : mirrorAvgConf
    const confidence = Math.round((agreementRate * 0.6 + (groupAvgConf / 100) * 0.4) * 100)

    // Step 7: reasoning
    const reasons: string[] = [
      `Market: ${marketType} (ADX ${adx.toFixed(1)}, regime=${regimeInfo.regime})`,
      `Bias from indicators: ${bias} (${bullVotes} bull / ${bearVotes} bear votes out of 5)`,
      `Scalp: ${scalpAgreement}/5 signals aligned with bias · avg confidence ${scalpAvgConf}%`,
      `Mirror: ${mirrorAgreement}/5 signals aligned with bias · avg confidence ${mirrorAvgConf}%`,
      recommended === 'scalp'
        ? 'Scalp side better aligned with current market structure'
        : 'Mirror side better aligned with current market structure',
    ]
    if (direction === 'HOLD') {
      reasons.push('Winning group is split with no majority — direction inconclusive')
    }
    if (bias === 'NEUTRAL') {
      reasons.push('Market bias is neutral — both groups score 0; recommendation falls back to confidence tiebreak')
    }

    // Expiry is bound to the timeframe — confirmation is valid for exactly one
    // candle period from the moment it was generated. 1m -> 60s, 5m -> 300s.
    // The frontend re-derives ACTIVE/EXPIRED status per tick from these times.
    const analyzedAtMs = Date.now()
    const expirySpanMs = timeframe === '1m' ? 60_000 : 300_000
    const expiresAtMs  = analyzedAtMs + expirySpanMs

    return NextResponse.json({
      pair,
      timeframe,
      marketType,
      regime:               regimeInfo.regime,
      effectiveMinStrength: regimeInfo.effectiveMinStrength,
      adx,
      bias,
      recommended,           // 'scalp' | 'mirror'
      direction,             // 'BUY' | 'SELL' | 'HOLD'
      confidence,            // blended 0-100
      reasons,
      analyzedAt: new Date(analyzedAtMs).toISOString(),
      expiresAt:  new Date(expiresAtMs).toISOString(),
      breakdown: {
        scalp:  { results: scalpResults,  agreement: scalpAgreement,  avgConfidence: scalpAvgConf  },
        mirror: { results: mirrorResults, agreement: mirrorAgreement, avgConfidence: mirrorAvgConf },
      },
    })
  } catch (e: any) {
    console.error('[direction-check]', e)
    return NextResponse.json({ error: e?.message || 'internal error' }, { status: 500 })
  }
}
