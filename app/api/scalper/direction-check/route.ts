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
// endpoints. No new LLM prompts here; the 5 strategy prompts are the
// canonical ones that already power the per-strategy signal route.
export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { classifyRegime, type MarketRegime } from '@/app/api/scalper/signal/route'
import { getAdminClient } from '@/lib/supabase'

type Direction = 'BUY' | 'SELL' | 'HOLD'
type StrategyName = 'Momentum' | 'Mean Reversion' | 'Breakout' | 'Order Flow' | 'Scalp'

const STRATEGIES: StrategyName[] = ['Momentum', 'Mean Reversion', 'Breakout', 'Order Flow', 'Scalp']

interface PerStrategyResult {
  strategy: StrategyName
  direction: Direction
  confidence: number
  fallback: boolean
  // True when the signal call itself failed (HTTP error / network throw) —
  // distinct from fallback, which also covers a successful call that used the
  // rule-based engine. Failed results carry no market information and must
  // not count toward the quorum.
  failed?: boolean
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
        if (!r.ok) return { strategy, direction: 'HOLD', confidence: 0, fallback: true, failed: true }
        const j = await r.json()
        return {
          strategy,
          direction:  (j.direction as Direction) ?? 'HOLD',
          confidence: Number(j.confidence ?? 0),
          fallback:   Boolean(j.fallback),
        }
      } catch {
        return { strategy, direction: 'HOLD', confidence: 0, fallback: true, failed: true }
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
    let direction = majorityDirection(winningGroup)

    // Quorum guard: with fewer than 3 of 5 strategy calls succeeding, the
    // recommendation would rest on 1-2 signals — abstain rather than persist
    // a direction the worker could act on. HOLD rows still block auto-trade
    // (deadman-switch stays conservative).
    const succeededCalls = scalpResults.filter(r => !r.failed).length
    const quorumMet = succeededCalls >= 3
    if (!quorumMet) {
      console.warn(`[direction-check] ${pair}: only ${succeededCalls}/5 strategy calls succeeded — abstaining with HOLD`)
      direction = 'HOLD'
    }

    // Step 6: blended confidence — 60% agreement rate, 40% signal quality
    const agreementCount = recommended === 'scalp' ? scalpAgreement : mirrorAgreement
    const agreementRate  = agreementCount / 5
    const groupAvgConf   = recommended === 'scalp' ? scalpAvgConf : mirrorAvgConf
    let confidence = Math.round((agreementRate * 0.6 + (groupAvgConf / 100) * 0.4) * 100)

    // Step 7: background confirmation against live price
    // ────────────────────────────────────────────────────────────────────────
    // Independent verification before we return a recommendation. Re-fetches
    // the live bid/ask AFTER the AI fan-out so we can confirm the recommended
    // direction aligns with the most recent real-time price drift, not just
    // the candle-close indicators the AI saw. Three outcomes:
    //
    //   confirmed    — live drift matches direction (+5 conf, cap 100)
    //   contradicted — live drift opposes direction (-20 conf, never below 0)
    //   neutral      — drift inside epsilon (no change)
    //   unavailable  — live fetch failed; reasoning notes it, no auto-pass
    //
    // Epsilon = 0.1 × ATR (tick's own ATR field) so the threshold scales with
    // volatility. No hardcoded per-pair epsilons; everything derives from
    // live indicators on this tick.
    type ConfirmationStatus = 'confirmed' | 'contradicted' | 'neutral' | 'unavailable'
    let confirmationStatus: ConfirmationStatus = 'unavailable'
    let livePrice:   number | null = null
    let priceDrift:  number | null = null
    let driftPips:   number | null = null
    try {
      const priceResp = await fetch(
        `${origin}/api/oanda/prices?pairs=${encodeURIComponent(pair)}`,
        { headers: { Authorization: authHeader }, cache: 'no-store' },
      )
      if (priceResp.ok) {
        const priceData = await priceResp.json()
        const row = (priceData?.prices || []).find((p: any) => p.pair === pair)
        if (row && typeof row.bid === 'number' && row.bid > 0) {
          const lp: number = direction === 'SELL' ? row.bid : (typeof row.ask === 'number' ? row.ask : row.bid)
          livePrice = lp
          // Drift = (live - candle close) signed; positive = price moved up
          priceDrift = lp - Number(tick.price ?? 0)
          const pipFor = pair.includes('JPY') ? 0.01
                       : pair.startsWith('XAU') ? 0.1
                       : pair.startsWith('XAG') ? 0.01
                       : 0.0001
          driftPips = priceDrift / pipFor
          const atr     = Number(tick.atr ?? 0)
          const epsilon = atr > 0 ? atr * 0.1 : Math.abs(lp) * 0.0001 // fallback: 1 bp of price
          if (Math.abs(priceDrift) < epsilon) {
            confirmationStatus = 'neutral'
          } else if (direction === 'BUY') {
            confirmationStatus = priceDrift > 0 ? 'confirmed' : 'contradicted'
          } else if (direction === 'SELL') {
            confirmationStatus = priceDrift < 0 ? 'confirmed' : 'contradicted'
          } else {
            // direction = HOLD — drift doesn't confirm or contradict a non-stance
            confirmationStatus = 'neutral'
          }
        }
      }
    } catch (e: any) {
      console.warn('[direction-check] confirmation fetch failed:', e?.message)
    }

    // Apply confidence adjustment from confirmation. Capped to [0, 100].
    let confidenceAdj = 0
    if (confirmationStatus === 'confirmed')    confidenceAdj = +5
    if (confirmationStatus === 'contradicted') confidenceAdj = -20
    confidence = Math.max(0, Math.min(100, confidence + confidenceAdj))

    // Step 8: reasoning
    const reasons: string[] = [
      `Market: ${marketType} (ADX ${adx.toFixed(1)}, regime=${regimeInfo.regime})`,
      `Bias from indicators: ${bias} (${bullVotes} bull / ${bearVotes} bear votes out of 5)`,
      `Scalp: ${scalpAgreement}/5 signals aligned with bias · avg confidence ${scalpAvgConf}%`,
      `Mirror: ${mirrorAgreement}/5 signals aligned with bias · avg confidence ${mirrorAvgConf}%`,
      recommended === 'scalp'
        ? 'Scalp side better aligned with current market structure'
        : 'Mirror side better aligned with current market structure',
    ]
    if (!quorumMet) {
      reasons.push(`Quorum not met: only ${succeededCalls}/5 strategy calls succeeded — abstaining (HOLD)`)
    } else if (direction === 'HOLD') {
      reasons.push('Winning group is split with no majority — direction inconclusive')
    }
    if (bias === 'NEUTRAL') {
      reasons.push('Market bias is neutral — both groups score 0; recommendation falls back to confidence tiebreak')
    }
    // Background confirmation line — always present so the operator sees the
    // verification step ran. "unavailable" is explicit, not silently passed.
    if (confirmationStatus === 'confirmed' && livePrice !== null && driftPips !== null) {
      reasons.push(`Live confirmation: drift ${driftPips >= 0 ? '+' : ''}${driftPips.toFixed(1)} pips matches ${direction} — confirmed (+${confidenceAdj} conf)`)
    } else if (confirmationStatus === 'contradicted' && driftPips !== null) {
      reasons.push(`Live confirmation: drift ${driftPips >= 0 ? '+' : ''}${driftPips.toFixed(1)} pips contradicts ${direction} — demoted (${confidenceAdj} conf)`)
    } else if (confirmationStatus === 'neutral') {
      reasons.push('Live confirmation: drift inside epsilon — neutral, no adjustment')
    } else {
      reasons.push('Live confirmation: live-price fetch unavailable — confirmation skipped')
    }

    // Expiry is bound to the timeframe — confirmation is valid for exactly one
    // candle period from the moment it was generated. 1m -> 60s, 5m -> 300s.
    // The frontend re-derives ACTIVE/EXPIRED status per tick from these times.
    const analyzedAtMs = Date.now()
    const expirySpanMs = timeframe === '1m' ? 60_000 : 300_000
    const expiresAtMs  = analyzedAtMs + expirySpanMs

    // Worker deadman-switch: persist 5m confirmations so the 24/7 scalper
    // worker can read the latest unexpired row before auto-executing. 1m is
    // operator-advisory only — gating auto-trade on a 60-second window would
    // be impractical, and the migration check constraint mirrors that policy.
    // Failures here MUST NOT abort the response; the analysis itself succeeded
    // and the operator still gets the card. Worker just won't see this row.
    if (userId && timeframe === '5m') {
      try {
        const admin = getAdminClient()
        await admin.from('direction_confirmations').insert({
          user_id:      userId,
          pair,
          timeframe,
          direction,
          recommended,
          confidence,
          regime:       regimeInfo.regime,
          adx,
          market_type:  marketType,
          analyzed_at:  new Date(analyzedAtMs).toISOString(),
          expires_at:   new Date(expiresAtMs).toISOString(),
        })
      } catch (e: any) {
        console.error('[direction-check] persist failed', e?.message)
      }
    }

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
      confidence,            // blended 0-100 (after confirmation adjustment)
      reasons,
      analyzedAt: new Date(analyzedAtMs).toISOString(),
      expiresAt:  new Date(expiresAtMs).toISOString(),
      // Background confirmation surfaced so the UI/operator can audit it.
      confirmation: {
        status:    confirmationStatus,
        livePrice,
        candleClose: Number(tick.price ?? 0),
        driftPips,
        adjustment:  confidenceAdj,
      },
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
