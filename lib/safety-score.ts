// lib/safety-score.ts
// ─────────────────────────────────────────────────────────────────────────────
// Safety Score — a 0–100 score about HOW SAFE it is to take this setup right
// now. Deliberately INDEPENDENT of signal strength: a 95%-confidence AI signal
// into a wide live spread during a thin session scores poorly here.
//
// Components (weighted; each 0–100):
//   spread_cost     0.20 — live spread vs ATR; static default spread = partial
//   trend_clarity   0.15 — regime from ADX (chop unsafe, ranging fine)
//   session_quality 0.15 — London/NY overlap best, Asia worst, closed = 0
//   htf_alignment   0.15 — 15m/1H agreement with the trade direction
//   news_proximity  0.10 — high-impact news inside the no-trade window
//   stop_viability  0.10 — stop distance vs ATR (noise floor check)
//   exposure        0.15 — open positions + daily drawdown headroom
// ─────────────────────────────────────────────────────────────────────────────

export type SafetyComponentName =
  | 'spread_cost' | 'trend_clarity' | 'session_quality' | 'htf_alignment'
  | 'news_proximity' | 'stop_viability' | 'exposure'

export interface SafetyComponent {
  score: number        // 0..100
  weight: number       // 0..1
  reason: string
}

export interface SafetyInputs {
  pair: string
  direction: 'BUY' | 'SELL'
  regime?: string | null
  session?: string                 // ASIA | LONDON | NEW_YORK | OTHER | CLOSED
  spreadPips?: number
  atrPips?: number
  spreadSource?: 'live' | 'default' | null
  slPips?: number
  htfBias15m?: 'BUY' | 'SELL' | null
  htfBias1h?: 'BUY' | 'SELL' | null
  newsInWindow?: boolean
  newsMinutesAway?: number | null
  openPositions?: number
  maxPositions?: number
  dailyLossUsedPct?: number | null  // fraction of maxLoss already consumed
  maxDailyLossPct?: number
}

export interface SafetyResult {
  total: number
  grade: 'A' | 'B' | 'C' | 'D' | 'F'
  components: Record<SafetyComponentName, SafetyComponent>
  reasons: string[]
}

// ── Config (env-overridable) ─────────────────────────────────────────────────
const fenv = (key: string, def: number): number => {
  const v = parseFloat(process.env[key] || '')
  return Number.isFinite(v) ? v : def
}
const WEIGHTS: Record<SafetyComponentName, number> = {
  spread_cost:     fenv('SAFETY_WEIGHT_SPREAD',  0.20),
  trend_clarity:   fenv('SAFETY_WEIGHT_TREND',   0.15),
  session_quality: fenv('SAFETY_WEIGHT_SESSION', 0.15),
  htf_alignment:   fenv('SAFETY_WEIGHT_HTF',     0.15),
  news_proximity:  fenv('SAFETY_WEIGHT_NEWS',    0.10),
  stop_viability:  fenv('SAFETY_WEIGHT_STOP',    0.10),
  exposure:        fenv('SAFETY_WEIGHT_EXPOSURE',0.15),
}
// Authority gate thresholds
export const SAFETY_EXECUTE_MIN   = () => fenv('SAFETY_EXECUTE_MIN', 60)   // ≥ this → tradeable on safety
export const SAFETY_HARD_BLOCK_AT = () => fenv('SAFETY_HARD_BLOCK_AT', 40)  // < this → unsafe regardless of edge

const clamp = (n: number) => Math.max(0, Math.min(100, n))

function gradeOf(total: number): SafetyResult['grade'] {
  if (total >= 85) return 'A'
  if (total >= 70) return 'B'
  if (total >= 55) return 'C'
  if (total >= 40) return 'D'
  return 'F'
}

/** Compute the safety score. Pure function — no I/O, no DB. */
export function computeSafetyScore(inputs: SafetyInputs): SafetyResult {
  const c = {} as Record<SafetyComponentName, SafetyComponent>
  const reasons: string[] = []

  // 1. spread_cost — trading through a wide spread hands back the edge.
  {
    const sp = inputs.spreadPips ?? null
    const atr = inputs.atrPips ?? null
    const isLive = inputs.spreadSource === 'live'
    if (sp === null || atr === null || !(atr > 0)) {
      c.spread_cost = { score: 60, weight: WEIGHTS.spread_cost, reason: 'Spread unknown — assume normal' }
      reasons.push('Spread unknown')
    } else {
      const ratio = sp / atr
      let score = 100
      let note = `Spread ${sp.toFixed(1)}p / ATR ${atr.toFixed(1)}p = ${(ratio * 100).toFixed(0)}%`
      if (ratio > 0.40) { score = 10; note += ' — exceeds 40% hard gate' }
      else if (ratio > 0.30) score = 40
      else if (ratio > 0.20) score = 70
      if (!isLive) { score = Math.min(score, 60); note += ' (estimate, not live feed)' }
      c.spread_cost = { score: clamp(score), weight: WEIGHTS.spread_cost, reason: note }
      if (score < 50) reasons.push('Wide/uncertain spread')
    }
  }

  // 2. trend_clarity — chop (ADX<15) already hard-blocks in the engine; safety
  //    discounts anything that is not a clear macro state.
  {
    const r = inputs.regime
    let score = 100, note = 'Regime clear'
    if (r === 'chop')           { score = 0;   note = 'Chop — no directional edge' }
    else if (r === 'weak-trend'){ score = 65;  note = 'Weak trend — partial edge' }
    else if (r === 'ranging')   { score = 80;  note = 'Ranging — mean-reversion context' }
    else if (r === 'strong-trend') { score = 100; note = 'Strong trend' }
    else if (r === 'trending')  { score = 95;  note = 'Trending' }
    else { score = 70; note = 'Regime unknown' }
    c.trend_clarity = { score, weight: WEIGHTS.trend_clarity, reason: note }
    if (score < 50) reasons.push(note)
  }

  // 3. session_quality
  {
    const s = inputs.session
    let score = 100, note = 'Prime session'
    if (s === 'CLOSED')        { score = 0;  note = 'Market closed' }
    else if (s === 'ASIA')     { score = 55; note = 'Asia session — thinner liquidity' }
    else if (s === 'LONDON')   { score = 100; note = 'London session' }
    else if (s === 'NEW_YORK') { score = 90; note = 'New York session' }
    else { score = 70; note = 'Session unknown' }
    c.session_quality = { score, weight: WEIGHTS.session_quality, reason: note }
  }


  // 4. htf_alignment
  {
    const dir = inputs.direction
    const b15 = inputs.htfBias15m
    const b1h = inputs.htfBias1h
    const has15 = b15 !== null && b15 !== undefined
    const has1h = b1h !== null && b1h !== undefined
    if (!has15 && !has1h) {
      c.htf_alignment = { score: 85, weight: WEIGHTS.htf_alignment, reason: 'HTF ambiguous — no trend to violate' }
    } else {
      const opp15 = has15 && b15 !== dir
      const opp1h = has1h && b1h !== dir
      if (opp15 && opp1h) {
        c.htf_alignment = { score: 0, weight: WEIGHTS.htf_alignment, reason: 'Both 15m & 1H oppose the trade direction' }
        reasons.push('Counter-trend vs 15m AND 1H')
      } else if (opp15 || opp1h) {
        c.htf_alignment = { score: 55, weight: WEIGHTS.htf_alignment,
          reason: `${opp15 ? '15m' : '1H'} opposes — partial conflict` }
      } else {
        c.htf_alignment = { score: 100, weight: WEIGHTS.htf_alignment, reason: '15m & 1H align' }
      }
    }
  }

  // 5. news_proximity
  {
    if (inputs.newsInWindow) {
      const mins = inputs.newsMinutesAway ?? 0
      const score = mins >= 20 ? 60 : mins >= 10 ? 30 : 0
      c.news_proximity = { score, weight: WEIGHTS.news_proximity,
        reason: `High-impact news ${mins > 0 ? `in ~${mins}m` : 'imminent'} — risk rules block entries` }
      reasons.push('News in window')
    } else {
      c.news_proximity = { score: 100, weight: WEIGHTS.news_proximity, reason: 'No high-impact news in window' }
    }
  }

  // 6. stop_viability — the stop must sit outside the ATR noise floor.
  {
    const sl = inputs.slPips ?? null
    const atr = inputs.atrPips ?? null
    if (sl === null || atr === null || !(atr > 0)) {
      c.stop_viability = { score: 60, weight: WEIGHTS.stop_viability, reason: 'SL/ATR unknown' }
    } else {
      const mult = sl / atr
      let score: number, note: string
      if (mult >= 1.5)      { score = 100; note = `SL ${sl.toFixed(0)}p is ${mult.toFixed(1)}× ATR` }
      else if (mult >= 1.0) { score = 80;  note = `SL ${sl.toFixed(0)}p is ${mult.toFixed(1)}× ATR` }
      else if (mult >= 0.6) { score = 50;  note = `SL ${sl.toFixed(0)}p < 1× ATR — noise risk` }
      else                  { score = 10;  note = `SL ${sl.toFixed(0)}p ≪ ATR — stop sits inside noise` }
      c.stop_viability = { score, weight: WEIGHTS.stop_viability, reason: note }
      if (score < 40) reasons.push(note)
    }
  }

  // 7. exposure — open positions and daily-loss headroom.
  {
    let score = 100, note = 'Exposure clear'
    const open = inputs.openPositions ?? 0
    const max = inputs.maxPositions ?? 0
    if (max > 0) {
      if (open >= max) {
        score = 0; note = `Max positions open (${open}/${max})`
        reasons.push(note)
      } else if (open >= max - 1) {
        score = 50; note = `${open}/${max} positions open — last slot`
      } else {
        note = `${open}/${max} positions open`
      }
    }
    if (typeof inputs.dailyLossUsedPct === 'number' && typeof inputs.maxDailyLossPct === 'number' && inputs.maxDailyLossPct > 0) {
      const used = inputs.dailyLossUsedPct / inputs.maxDailyLossPct
      if (used >= 0.95) { score = 0; note += ' — daily loss limit reached'; reasons.push('Daily loss limit') }
      else if (used >= 0.75) score = Math.min(score, 45)
      else if (used >= 0.5)  score = Math.min(score, 75)
    }
    c.exposure = { score, weight: WEIGHTS.exposure, reason: note }
  }

  const total = Math.round(
    (Object.keys(c) as SafetyComponentName[]).reduce((acc, k) => acc + c[k].score * c[k].weight, 0)
  )
  return { total: clamp(total), grade: gradeOf(total), components: c, reasons }
}
