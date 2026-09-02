// app/api/scalper/similar-patterns/route.ts
// Audit Phase 4 (item 13): Similar-Pattern Engine.
//
// Given the current 5m tick indicators, finds the N most similar RESOLVED
// historical predictions (from prediction_logs) by feature distance and
// returns how each one played out (WIN/LOSS, MFE/MAE, price after 1/3/5/15m).
// This is the "historical intelligence" layer: instead of asking the model to
// be right, we ask "when the market looked like this before, what happened?"
//
// Feature vector (all scale-invariant, matching ml/train.py conventions):
//   rsi14, adx, bb_width_rel, macd_hist_atr, ema9_vs_ema21, price_vs_ema20,
//   buy_pressure, spread_atr_ratio. Each is z-normalised against the pool of
//   candidate rows so no single feature dominates the distance metric.
//
// POST body: { pair, indicators, topK? }
//   indicators — the tick object (same shape /api/scalper/tick returns).
//   topK       — default 10, max 50.
export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { getAdminClient } from '@/lib/supabase'

const DEFAULT_TOP_K = 10
const MAX_TOP_K = 50
const MAX_CANDIDATES = 2000

// Feature keys extracted from an indicator snapshot / tick object. Only
// scale-invariant features — raw prices/EMAs are excluded (the ML pipeline
// proved price-level features don't generalise).
function featureVector(snap: any): Record<string, number> | null {
  if (!snap || typeof snap !== 'object') return null
  const price = Number(snap.price ?? snap.currentPrice ?? 0)
  const atr   = Number(snap.atr ?? 0)
  const bbU   = Number(snap.bbUpper ?? 0)
  const bbL   = Number(snap.bbLower ?? 0)
  const bbW   = bbU - bbL
  const atrP  = Number(snap.atrPips ?? 0)
  const spP   = Number(snap.spreadPips ?? 0)

  const v: Record<string, number> = {
    rsi14:           Number(snap.rsi14 ?? 50),
    adx:             Number(snap.adx ?? 20),
    bb_width_rel:    price > 0 ? bbW / price : 0,
    macd_hist_atr:   atr > 0 ? (Number(snap.macdHistogram ?? 0) / atr) : 0,
    ema9_vs_ema21:   atr > 0 ? ((Number(snap.ema9 ?? 0) - Number(snap.ema21 ?? 0)) / atr) : 0,
    price_vs_ema20:  atr > 0 ? ((price - Number(snap.ema20 ?? 0)) / atr) : 0,
    buy_pressure:    Number(snap.buyPressure ?? 0.5),
    spread_atr_ratio: atrP > 0 ? spP / atrP : 0,
  }
  // Reject rows missing the core features entirely (distance would be garbage).
  if (!Number.isFinite(v.rsi14) || !Number.isFinite(v.adx)) return null
  return v
}


export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const pair: string | undefined = body?.pair
    const indicators: any = body?.indicators
    const topK = Math.min(MAX_TOP_K, Math.max(1, Number(body?.topK ?? DEFAULT_TOP_K)))

    if (!pair || !indicators) {
      return NextResponse.json({ error: 'pair and indicators required' }, { status: 400 })
    }

    const queryVec = featureVector(indicators)
    if (!queryVec) {
      return NextResponse.json({ error: 'indicators missing required features' }, { status: 400 })
    }

    const sb = getAdminClient()
    const { data, error } = await sb
      .from('prediction_logs')
      .select('pair, direction, confidence, outcome, mfe_pips, mae_pips, '
              + 'price_after_1m, price_after_3m, price_after_5m, price_after_15m, '
              + 'regime, agreement_score, created_at, indicator_snapshot')
      .eq('pair', pair)
      .not('outcome', 'is', null)
      .neq('outcome', 'PENDING')
      .order('created_at', { ascending: false })
      .limit(MAX_CANDIDATES)

    if (error) throw error

    // ── Build candidate pool + z-normalise across the whole pool ──────────
    const candidates: { row: any; vec: Record<string, number> }[] = []
    for (const row of (data || []) as any[]) {
      const vec = featureVector(row.indicator_snapshot)
      if (vec) candidates.push({ row, vec })
    }
    if (candidates.length === 0) {
      return NextResponse.json({ pair, matches: [], stats: null,
        message: 'No resolved prediction_logs yet — run the worker for a few hours and retry.' })
    }

    const FEATURES = Object.keys(queryVec)
    const means: Record<string, number> = {}
    const stds:  Record<string, number> = {}
    for (const f of FEATURES) {
      const vals = candidates.map(c => c.vec[f])
      const mean = vals.reduce((a, b) => a + b, 0) / vals.length
      const var_ = vals.reduce((a, b) => a + (b - mean) ** 2, 0) / vals.length
      means[f] = mean
      stds[f]  = Math.sqrt(var_) || 1
    }

    const norm = (v: Record<string, number>) =>
      FEATURES.reduce((acc, f) => { acc[f] = (v[f] - means[f]) / stds[f]; return acc }, {} as Record<string, number>)
    const q = norm(queryVec)

    const dist = (v: Record<string, number>) => {
      let s = 0
      for (const f of FEATURES) { const d = q[f] - v[f]; s += d * d }
      return Math.sqrt(s)
    }

    // ── Score, sort, take top K ────────────────────────────────────────────
    const scored = candidates.map(c => ({ ...c, distance: dist(norm(c.vec)) }))
    scored.sort((a, b) => a.distance - b.distance)
    const matches = scored.slice(0, topK).map(m => ({
      distance:      +m.distance.toFixed(3),
      direction:     m.row.direction,
      confidence:    m.row.confidence,
      outcome:       m.row.outcome,
      mfePips:       m.row.mfe_pips,
      maePips:       m.row.mae_pips,
      priceAfter1m:  m.row.price_after_1m,
      priceAfter3m:  m.row.price_after_3m,
      priceAfter5m:  m.row.price_after_5m,
      priceAfter15m: m.row.price_after_15m,
      regime:        m.row.regime,
      agreement:     m.row.agreement_score,
      createdAt:     m.row.created_at,
    }))

    // ── Aggregate stats over the top K ─────────────────────────────────────
    const scoredRows = matches.filter(m => m.outcome === 'WIN' || m.outcome === 'LOSS')
    const wins  = scoredRows.filter(m => m.outcome === 'WIN').length
    const losses = scoredRows.filter(m => m.outcome === 'LOSS').length
    const avgMfe = scoredRows.length
      ? +(scoredRows.reduce((s, m) => s + (m.mfePips ?? 0), 0) / scoredRows.length).toFixed(2)
      : null
    const avgMae = scoredRows.length
      ? +(scoredRows.reduce((s, m) => s + (m.maePips ?? 0), 0) / scoredRows.length).toFixed(2)
      : null

    const stats = scoredRows.length
      ? {
          n:        scoredRows.length,
          wins,
          losses,
          winRate:  Math.round((wins / scoredRows.length) * 100),
          avgMfePips: avgMfe,
          avgMaePips: avgMae,
          expectancyPips: avgMfe !== null && avgMae !== null ? +(avgMfe - avgMae).toFixed(2) : null,
        }
      : null

    return NextResponse.json({ pair, query: queryVec, topK, matches, stats })
  } catch (e: any) {
    console.error('[similar-patterns]', e?.message)
    return NextResponse.json({ error: e?.message || 'similar-patterns failed' }, { status: 500 })
  }
}
