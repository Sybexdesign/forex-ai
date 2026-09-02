// lib/counterfactual.ts
// ─────────────────────────────────────────────────────────────────────────────
// Counterfactual replay: given a proposed trade plan (entry/sl/tp) and the
// current indicator snapshot, finds the N most similar RESOLVED historical
// setups (feature-distance over scale-invariant indicators) and replays the
// proposed plan against each one's measured MFE/MAE path:
//
//   • TP distance reached first        → simulated WIN at +planned R
//   • SL distance reached first        → simulated LOSS at −1R
//   • both reached → ordering by recorded time_to_tp_s / time_to_sl_s
//   • neither      → INCONCLUSIVE (no bet — market never activated the plan)
//
// This answers "what would statistically have happened if we had taken THIS
// exact trade when the market looked like THIS before?"
// ─────────────────────────────────────────────────────────────────────────────
import { getAdminClient } from '@/lib/supabase'
import { pipSizeOf } from '@/lib/expectancy-engine'

export interface ReplayRequest {
  pair: string
  direction: 'BUY' | 'SELL'
  entry: number
  sl: number
  tp: number
  indicators?: Record<string, unknown>   // current tick/indicator snapshot
  topK?: number
  userId?: string | null
  persist?: boolean
}

export interface ReplayMatch {
  distance: number | null
  createdAt: string
  regime: string | null
  confidence: number | null
  agreement: number | null
  outcome: string
  mfePips: number | null
  maePips: number | null
  simulated: 'WIN' | 'LOSS' | 'INCONCLUSIVE'
  simulatedR: number | null
}

export interface ReplayResult {
  pair: string
  direction: 'BUY' | 'SELL'
  slPips: number
  tpPips: number
  matchedCount: number
  conclusive: number
  wins: number
  losses: number
  winRate: number | null
  expectancyR: number | null
  wouldHitTpPct: number | null
  wouldHitSlPct: number | null
  avgMfePips: number | null
  avgMaePips: number | null
  matches: ReplayMatch[]
  replayedAt: string
  replayKey: string
}

const MAX_CANDIDATES = 1500
const nn = (v: unknown): number | null => {
  const x = Number(v)
  return Number.isFinite(x) ? x : null
}

/** Scale-invariant feature vector — identical to the Similar-Pattern Engine. */
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
  if (!Number.isFinite(v.rsi14) || !Number.isFinite(v.adx)) return null
  return v
}

export function replayKeyOf(req: ReplayRequest): string {
  const priceBucket = Math.round((req.entry ?? 0) * 10) / 10
  return `${req.pair}|${req.direction}|${priceBucket}|${Math.floor(Date.now() / (30 * 60_000))}`
}

export async function runCounterfactualReplay(req: ReplayRequest): Promise<ReplayResult | null> {
  const pip = pipSizeOf(req.pair)
  const slPips = Math.abs(req.sl - req.entry) / pip
  const tpPips = Math.abs(req.tp - req.entry) / pip
  if (!(slPips > 0) || !(tpPips > 0)) return null
  const requestedK = Number(req.topK)
  const topK = Number.isFinite(requestedK) && requestedK > 0
    ? Math.min(50, Math.max(3, Math.round(requestedK)))
    : 10

  const admin = getAdminClient()
  const queryVec = featureVector(req.indicators)

  let q = admin
    .from('prediction_logs')
    .select('pair, direction, confidence, agreement_score, outcome, mfe_pips, mae_pips,'
          + ' time_to_tp_s, time_to_sl_s, regime, created_at, indicator_snapshot')
    .eq('pair', req.pair)
    .not('outcome', 'is', null)
    .neq('outcome', 'PENDING')
    .order('created_at', { ascending: false })
    .limit(MAX_CANDIDATES)
  if (req.userId) q = q.eq('user_id', req.userId)
  const { data, error } = await q
  if (error) throw error

  // Build candidate pool with feature vectors.
  const candidates: { row: any; vec: Record<string, number> | null; distance: number | null }[] = []
  for (const row of (data || []) as any[]) {
    const vec = featureVector(row.indicator_snapshot)
    candidates.push({ row, vec, distance: null })
  }
  if (candidates.length < 3) {
    return {
      pair: req.pair, direction: req.direction, slPips, tpPips,
      matchedCount: 0, conclusive: 0, wins: 0, losses: 0, winRate: null,
      expectancyR: null, wouldHitTpPct: null, wouldHitSlPct: null,
      avgMfePips: null, avgMaePips: null, matches: [],
      replayedAt: new Date().toISOString(), replayKey: replayKeyOf(req),
    }
  }

  // Z-normalise across the pool and rank by distance. Without a query vector
  // (no indicators) we fall back to the newest candidates so the replay still
  // works blind.
  let pool = candidates.filter(c => c.vec !== null) as { row: any; vec: Record<string, number>; distance: number | null }[]
  if (pool.length < 3) pool = candidates as any
  if (queryVec) {
    const FEATURES = Object.keys(queryVec)
    const means: Record<string, number> = {}
    const stds: Record<string, number> = {}
    for (const f of FEATURES) {
      const vals = pool.map(c => c.vec[f])
      const mean = vals.reduce((a, b) => a + b, 0) / vals.length
      const var_ = vals.reduce((a, b) => a + (b - mean) ** 2, 0) / vals.length
      means[f] = mean
      stds[f] = Math.sqrt(var_) || 1
    }
    const norm = (v: Record<string, number>) => {
      const o: Record<string, number> = {}
      for (const f of FEATURES) o[f] = (v[f] - means[f]) / stds[f]
      return o
    }
    const qv = norm(queryVec)
    for (const c of pool) {
      let s = 0
      const nv = norm(c.vec)
      for (const f of FEATURES) { const d = qv[f] - nv[f]; s += d * d }
      c.distance = Math.sqrt(s)
    }
    pool.sort((a, b) => (a.distance ?? Infinity) - (b.distance ?? Infinity))
    pool = pool.slice(0, Math.max(topK * 4, 50))
  }

  // ── Replay the proposed plan against each candidate's measured path ─────────
  const simulate = (row: any): ReplayMatch['simulated'] => {
    const mfe = nn(row.mfe_pips)
    const mae = nn(row.mae_pips)
    const hitTp = mfe !== null && mfe >= tpPips
    const hitSl = mae !== null && mae >= slPips
    if (!hitTp && !hitSl) return 'INCONCLUSIVE'
    if (hitTp && !hitSl) return 'WIN'
    if (!hitTp && hitSl) return 'LOSS'
    // Both distances were reached → ordering decides. Prefer recorded hit times
    // when both exist; otherwise fall back to the actual outcome ordering.
    const tTp = nn(row.time_to_tp_s)
    const tSl = nn(row.time_to_sl_s)
    if (tTp !== null && tSl !== null) return tTp <= tSl ? 'WIN' : 'LOSS'
    return row.outcome === 'WIN' ? 'WIN' : 'LOSS'
  }

  const matches: ReplayMatch[] = pool.slice(0, topK).map((c: any) => {
    const sim = simulate(c.row)
    const mfe = nn(c.row.mfe_pips)
    const mae = nn(c.row.mae_pips)
    return {
      distance: c.distance !== null && c.distance !== undefined ? +c.distance.toFixed(3) : null,
      createdAt: c.row.created_at,
      regime: c.row.regime ?? null,
      confidence: c.row.confidence ?? null,
      agreement: c.row.agreement_score ?? null,
      outcome: c.row.outcome,
      mfePips: mfe,
      maePips: mae,
      simulated: sim,
      simulatedR: sim === 'WIN' ? tpPips / slPips : sim === 'LOSS' ? -1 : null,
    }
  })

  const conclusiveMatches = matches.filter(m => m.simulated !== 'INCONCLUSIVE')
  const wins = conclusiveMatches.filter(m => m.simulated === 'WIN').length
  const losses = conclusiveMatches.filter(m => m.simulated === 'LOSS').length
  const winRate = conclusiveMatches.length ? wins / conclusiveMatches.length : null
  const sumR = conclusiveMatches.reduce((a, m) => a + (m.simulatedR ?? 0), 0)
  const hitTpCount = matches.filter(m => (m.mfePips ?? 0) >= tpPips).length
  const hitSlCount = matches.filter(m => (m.maePips ?? 0) >= slPips).length

  const result: ReplayResult = {
    pair: req.pair, direction: req.direction, slPips, tpPips,
    matchedCount: matches.length,
    conclusive: conclusiveMatches.length,
    wins, losses,
    winRate: winRate === null ? null : +winRate.toFixed(4),
    expectancyR: conclusiveMatches.length ? +(sumR / conclusiveMatches.length).toFixed(4) : null,
    wouldHitTpPct: matches.length ? +((hitTpCount / matches.length) * 100).toFixed(1) : null,
    wouldHitSlPct: matches.length ? +((hitSlCount / matches.length) * 100).toFixed(1) : null,
    avgMfePips: matches.length
      ? +(matches.reduce((a, m) => a + (m.mfePips ?? 0), 0) / matches.length).toFixed(2)
      : null,
    avgMaePips: matches.length
      ? +(matches.reduce((a, m) => a + (m.maePips ?? 0), 0) / matches.length).toFixed(2)
      : null,
    matches,
    replayedAt: new Date().toISOString(),
    replayKey: replayKeyOf(req),
  }

  // ── Persist (deduplicated by replay_key, best-effort) ──────────────────────
  if (req.persist !== false) {
    try {
      await admin.from('counterfactual_results').upsert({
        user_id: req.userId ?? null,
        replay_key: result.replayKey,
        pair: req.pair,
        direction: req.direction,
        entry: req.entry,
        sl: req.sl,
        tp: req.tp,
        matched_count: result.matchedCount,
        win_count: result.wins,
        loss_count: result.losses,
        win_rate: result.winRate,
        expectancy_r: result.expectancyR,
        would_hit_tp: result.wouldHitTpPct ? result.wouldHitTpPct / 100 : null,
        would_hit_sl: result.wouldHitSlPct ? result.wouldHitSlPct / 100 : null,
        avg_mfe_pips: result.avgMfePips,
        avg_mae_pips: result.avgMaePips,
        matches: result.matches.slice(0, 20),
        snapshot: { indicators: req.indicators ?? null },
      }, { onConflict: 'replay_key', ignoreDuplicates: true })
    } catch (e: any) {
      console.warn('[counterfactual] persist failed:', e?.message)
    }
  }
  return result
}
