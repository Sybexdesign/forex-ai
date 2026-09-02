// lib/expectancy-engine.ts
// ─────────────────────────────────────────────────────────────────────────────
// Expectancy Engine (Phase 1) — evaluates whether a setup has statistically
// positive expected value, in R, per segment.
//
//   Expectancy = P(win) × Average Win R − P(loss) × Average Loss R
//
// R-multiple samples come from two sources:
//   • closed_trades — real broker fills:  r = realised P&L ÷ planned 1R risk
//     (1R = |entry − sl| in pips × pip-value-per-lot × lots).
//   • predictions   — resolved prediction_logs (SL/TP-touch semantics):
//       WIN  → r = +min(mfe, |entry−tp|) ÷ |entry−sl|   (reward captured)
//       LOSS → r = −max(1, mae ÷ |entry−sl|)            (stop taken / gap)
//     INCONCLUSIVE rows are noise (no SL/TP touch) and are excluded.
//
// Samples are grouped by: pair · direction · timeframe/setup-type · regime ·
// session · volatility regime · signal-strength band · ML-confidence band ·
// spread condition. Small-sample protection downgrades the authority of any
// bucket below the configured thresholds (<20 insufficient, 20–49 low,
// 50–99 moderate, 100+ strong) — configurable via env.
// ─────────────────────────────────────────────────────────────────────────────
import { getAdminClient } from '@/lib/supabase'
import { getPipValuePerLot } from '@/lib/brokers/interface'

export type ExpectancyStatus =
  | 'VERY_STRONG' | 'STRONG' | 'POSITIVE' | 'NEUTRAL' | 'NEGATIVE' | 'INSUFFICIENT_DATA'
export type SampleConfidence = 'insufficient' | 'low' | 'moderate' | 'strong'
export type RegimeName = 'chop' | 'ranging' | 'weak-trend' | 'trending' | 'strong-trend'

// ── Config (env-overridable, defaults safe) ───────────────────────────────────
const windowDays   = () => Math.max(7, Math.min(365, parseInt(process.env.EXPECTANCY_WINDOW_DAYS || '60', 10) || 60))
const confMin      = () => parseInt(process.env.EXPECTANCY_SAMPLE_LOW       || '20', 10)
const confMid      = () => parseInt(process.env.EXPECTANCY_SAMPLE_MODERATE  || '50', 10)
const confStrong   = () => parseInt(process.env.EXPECTANCY_SAMPLE_STRONG    || '100', 10)
export const EXPECTANCY_MIN_R = () => parseFloat(process.env.EXPECTANCY_MIN_POSITIVE_R || '0.15')
export const CACHE_TTL_MS     = 10 * 60_000
const MAX_ROWS_PER_SOURCE     = 4000

export interface ExpectancyMetrics {
  n: number
  wins: number
  losses: number
  winRate: number | null            // 0..1
  avgWinR: number | null
  avgLossR: number | null           // magnitude, positive
  expectancyR: number | null
  profitFactor: number | null
  avgWinUsd: number | null
  avgLossUsd: number | null
  medianWinR: number | null
  medianLossR: number | null
  maxDrawdownR: number | null       // peak-to-trough of cumulative R
  recentExpectancyR: number | null  // last 25% of samples
  longTermExpectancyR: number | null
  sampleConfidence: SampleConfidence
  status: ExpectancyStatus
}

export interface RSample {
  r: number
  win: boolean
  usd?: number
  ts: string                        // ISO timestamp — session + recency derived
  dims: {
    pair: string
    direction: 'BUY' | 'SELL'
    setupType?: string              // scalper | scalper-worker | mirror | generic…
    regime?: RegimeName | null
    session?: string                // ASIA | LONDON | NEW_YORK | OTHER
    volRegime?: string              // LOW | MEDIUM | HIGH
    confidence?: number             // signal strength (0-100)
    mlWinProb?: number              // 0..1
    spreadCond?: string             // tight | normal | wide
  }
}

export interface ExpectancyFetchOptions {
  userId?: string | null            // when set, per-user samples are also produced
  days?: number
}

export interface ExpectancyDataSet {
  samples: RSample[]
  byUserSamples: RSample[]
}


// ── Dimension + maths helpers (pure) ──────────────────────────────────────────

export function pipSizeOf(pair: string): number {
  if (pair.includes('JPY')) return 0.01
  if (pair.startsWith('XAU')) return 0.1
  if (pair.startsWith('XAG')) return 0.01
  if (pair.startsWith('BTC') || pair.startsWith('ETH')) return 1
  return 0.0001
}

/** UTC session of a timestamp — matches the app's worker session definitions. */
export function sessionOf(iso: string | Date): string {
  const h = new Date(iso).getUTCHours()
  if (h >= 22 || h < 7)  return 'ASIA'
  if (h >= 7  && h < 13) return 'LONDON'
  if (h >= 13 && h < 21) return 'NEW_YORK'
  return 'OTHER'
}

export function spreadConditionOf(spreadPips: number, atrPips: number): string {
  if (!(atrPips > 0) || !(spreadPips >= 0)) return 'unknown'
  const ratio = spreadPips / atrPips
  if (ratio < 0.15) return 'tight'
  if (ratio <= 0.40) return 'normal'
  return 'wide'
}

export function sampleConfidenceOf(n: number): SampleConfidence {
  if (n >= confStrong()) return 'strong'
  if (n >= confMid())     return 'moderate'
  if (n >= confMin())     return 'low'
  return 'insufficient'
}

function splitOutcomes(samples: RSample[]): { wins: number[]; losses: number[] } {
  const wins: number[] = []
  const losses: number[] = []
  for (const s of samples) {
    if (s.win) wins.push(s.r)
    else losses.push(s.r)
  }
  return { wins, losses }
}

const median = (a: number[]): number | null => {
  if (a.length === 0) return null
  const sorted = [...a].sort((x, y) => x - y)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

const num = (v: any): number | null => {
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}


// ── Core Expectancy math ──────────────────────────────────────────────────────

export function computeExpectancyMetrics(samples: RSample[]): ExpectancyMetrics {
  const n = samples.length
  const empty: ExpectancyMetrics = {
    n: 0, wins: 0, losses: 0, winRate: null, avgWinR: null, avgLossR: null,
    expectancyR: null, profitFactor: null, avgWinUsd: null, avgLossUsd: null,
    medianWinR: null, medianLossR: null, maxDrawdownR: null,
    recentExpectancyR: null, longTermExpectancyR: null,
    sampleConfidence: 'insufficient', status: 'INSUFFICIENT_DATA',
  }
  if (n === 0) return empty

  const sortedByTs = [...samples].sort((a, b) => (a.ts < b.ts ? -1 : 1))
  const { wins, losses } = splitOutcomes(sortedByTs)
  const winCount  = wins.length
  const lossCount = losses.length
  const scored    = winCount + lossCount

  // Peak-to-trough of the cumulative R curve.
  let peak = 0, drawdown = 0, cum = 0
  for (const s of sortedByTs) {
    cum += s.r
    if (cum > peak) peak = cum
    const dd = peak - cum
    if (dd > drawdown) drawdown = dd
  }

  // Recent expectancy = last 25% of samples (min 5).
  const recentCount = Math.max(5, Math.ceil(n * 0.25))
  const recent = sortedByTs.slice(-recentCount)
  const recentR = recent.reduce((a, s) => a + s.r, 0) / recent.length

  const avgWinR = winCount ? wins.reduce((a, b) => a + b, 0) / winCount : null
  const avgLossRmag = lossCount ? Math.abs(losses.reduce((a, b) => a + b, 0)) / lossCount : null
  const expectancyR = scored ? (winCount * (avgWinR ?? 0) - lossCount * (avgLossRmag ?? 0)) / scored : null
  const grossWin = wins.reduce((a, b) => a + b, 0)
  const grossLoss = Math.abs(losses.reduce((a, b) => a + b, 0))

  const withUsd = samples.filter(s => typeof s.usd === 'number')
  const usdWins = withUsd.filter(s => s.win).map(s => s.usd as number)
  const usdLosses = withUsd.filter(s => !s.win).map(s => Math.abs(s.usd as number))

  return {
    n, wins: winCount, losses: lossCount,
    winRate: scored ? winCount / scored : null,
    avgWinR, avgLossR: avgLossRmag,
    expectancyR,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : (grossWin > 0 ? Infinity : null),
    avgWinUsd: usdWins.length ? usdWins.reduce((a, b) => a + b, 0) / usdWins.length : null,
    avgLossUsd: usdLosses.length ? usdLosses.reduce((a, b) => a + b, 0) / usdLosses.length : null,
    medianWinR: median(wins),
    medianLossR: median(losses.map(x => Math.abs(x))),
    maxDrawdownR: scored ? Math.max(0, drawdown) : null,
    recentExpectancyR: recent.length ? recentR : null,
    longTermExpectancyR: expectancyR,
    sampleConfidence: sampleConfidenceOf(n),
    status: classifyExpectancy(expectancyR, n),
  }
}

/**
 * 70% win @ +0.5R / 30% @ −2R → −0.25R is NEGATIVE — never rely on win rate
 * alone. Status blends the R expectation with the sample's statistical weight.
 */
export function classifyExpectancy(
  expectancyR: number | null,
  n: number,
): ExpectancyStatus {
  const conf = sampleConfidenceOf(n)
  if (conf === 'insufficient' || expectancyR === null) return 'INSUFFICIENT_DATA'
  const minR = EXPECTANCY_MIN_R()
  if (expectancyR <= -0.05) return 'NEGATIVE'
  if (expectancyR >= minR * 3 && conf === 'strong') return 'VERY_STRONG'
  if (expectancyR >= minR * 2) return 'STRONG'
  if (expectancyR >= minR)     return 'POSITIVE'
  return 'NEUTRAL'
}


// ── Data acquisition ──────────────────────────────────────────────────────────

/** Closed broker trades → realised R multiples. */
async function fetchClosedTradeSamples(userId: string | null, days: number, limit: number): Promise<RSample[]> {
  const admin = getAdminClient()
  let q = admin
    .from('trades')
    .select('id, pair, direction, entry_price, sl_price, lots, pl_usd, result, closed_at, opened_at, source')
    .in('result', ['WIN', 'LOSS'])
    .gte('opened_at', new Date(Date.now() - days * 86400_000).toISOString())
    .order('opened_at', { ascending: false })
    .limit(limit)
  if (userId) q = q.eq('user_id', userId)
  const { data, error } = await q
  if (error) throw error

  const out: RSample[] = []
  for (const row of (data || []) as any[]) {
    const pair = row.pair
    const entry = num(row.entry_price)
    const sl = num(row.sl_price)
    const lots = num(row.lots)
    const pl = num(row.pl_usd)
    if (!entry || !sl || entry === sl || !lots || !pl) continue
    const pip = pipSizeOf(pair)
    const slPips = Math.abs(entry - sl) / pip
    const riskUsd = slPips * getPipValuePerLot(pair) * lots
    if (!(riskUsd > 0)) continue
    const r = pl / riskUsd
    if (!Number.isFinite(r)) continue
    out.push({
      r,
      win: row.result === 'WIN',
      usd: pl,
      ts: row.closed_at || row.opened_at,
      dims: {
        pair,
        direction: row.direction,
        setupType: row.source === 'mirror' ? 'mirror' : (row.source || 'manual'),
        regime: null,          // broker trades carry no regime snapshot
        session: sessionOf(row.closed_at || row.opened_at),
      },
    })
  }
  return out
}

/** Resolved prediction_logs → R multiples from SL/TP-touch semantics. */
async function fetchPredictionSamples(userId: string | null, days: number, limit: number): Promise<RSample[]> {
  const admin = getAdminClient()
  let q = admin
    .from('prediction_logs')
    .select('id, pair, direction, entry, sl, tp, confidence, outcome, mfe_pips, mae_pips,'
          + ' regime, session, vol_regime, spread_condition, setup_type, sl_pips, r_multiple,'
          + ' indicator_snapshot, created_at, resolved_at')
    .in('outcome', ['WIN', 'LOSS'])
    .gte('created_at', new Date(Date.now() - days * 86400_000).toISOString())
    .order('created_at', { ascending: false })
    .limit(limit)
  if (userId) q = q.eq('user_id', userId)
  const { data, error } = await q
  if (error) throw error

  const out: RSample[] = []
  for (const row of (data || []) as any[]) {
    const pair = row.pair
    if (row.direction !== 'BUY' && row.direction !== 'SELL') continue
    const direction = row.direction as 'BUY' | 'SELL'
    const entry = num(row.entry)
    const sl = num(row.sl)
    if (!entry || !sl || entry === sl) continue
    const pip = pipSizeOf(pair)
    const slPips = num(row.sl_pips) ?? Math.abs(entry - sl) / pip
    if (!(slPips > 0)) continue

    const tp = num(row.tp)
    const tpPips = tp ? Math.abs(tp - entry) / pip : null
    const mfe = num(row.mfe_pips)
    const mae = num(row.mae_pips)

    // WIN → TP was touched (worker resolution semantics) → captured reward.
    // LOSS → SL touched → realised −R; mae_pips reveals any gap-through.
    let r: number | null = num(row.r_multiple)
    if (r === null) {
      if (row.outcome === 'WIN') {
        const measured = Math.max(0.5, (mfe ?? slPips) / slPips)
        r = tpPips ? tpPips / slPips : measured
      } else {
        r = -Math.max(1, (mae ?? slPips) / slPips)
      }
    }
    if (r === null || !Number.isFinite(r)) continue

    const snap: any = row.indicator_snapshot || {}
    const atrRaw = num(snap.atrPips) ?? num(snap.atr ? snap.atr / pip : null)
    const atrPips = atrRaw
    const spreadPips = num(snap.spreadPips) ?? 0
    const mlWinProbRaw = snap?._audit?.mlWinProb ?? snap?.mlWinProb

    out.push({
      r,
      win: row.outcome === 'WIN',
      ts: row.created_at,
      dims: {
        pair,
        direction,
        setupType: row.setup_type ?? (String(row.timeframe || 'generic') === '5m' ? 'scalper' : row.timeframe),
        regime: (row.regime || snap?._regime?.marketRegime || null) as RegimeName | null,
        session: row.session ?? sessionOf(row.created_at),
        volRegime: row.vol_regime
          ?? (atrPips ? (atrPips >= 12 ? 'HIGH' : atrPips >= 6 ? 'MEDIUM' : 'LOW') : undefined),
        confidence: num(row.confidence) ?? undefined,
        mlWinProb: mlWinProbRaw !== undefined && mlWinProbRaw !== null ? num(mlWinProbRaw) ?? undefined : undefined,
        spreadCond: row.spread_condition ?? spreadConditionOf(spreadPips, atrPips ?? 1),
      },
    })
  }
  return out
}


// ── Segmentation ──────────────────────────────────────────────────────────────

export type Segment = Partial<{
  pair: string
  direction: 'BUY' | 'SELL'
  setupType: string
  regime: RegimeName
  session: string
  volRegime: string
  signalStrengthLow: number
  signalStrengthHigh: number
  mlConfLow: number
  mlConfHigh: number
  spreadCond: string
}>

/** Stable, comparable segment key (dimension vector as JSON). */
export function segmentKeyOf(seg: Segment): string {
  const o: Record<string, unknown> = {}
  if (seg.pair) o.pair = seg.pair
  if (seg.direction) o.direction = seg.direction
  if (seg.setupType) o.setupType = seg.setupType
  if (seg.regime) o.regime = seg.regime
  if (seg.session) o.session = seg.session
  if (seg.volRegime) o.volRegime = seg.volRegime
  if (seg.signalStrengthLow !== undefined) o.conf = `${seg.signalStrengthLow}-${seg.signalStrengthHigh}`
  if (seg.mlConfLow !== undefined) o.ml = `${seg.mlConfLow}-${seg.mlConfHigh}`
  if (seg.spreadCond) o.spread = seg.spreadCond
  return JSON.stringify(o)
}

export interface SegmentedBucket {
  key: string
  segment: Segment
  metrics: ExpectancyMetrics
  samples: RSample[]
  specificity: number
}

/** One-dimension-at-a-time segments present in the dataset (no empty cross-product). */
export function computeSegments(samples: RSample[]): SegmentedBucket[] {
  const out: SegmentedBucket[] = []

  const uniquePairs = Array.from(new Set(samples.map(s => s.dims.pair)))
  const baseSegs: Segment[] = [{}, ...uniquePairs.map(pair => ({ pair }))]

  const refine: Segment[] = [
    {},
    { direction: 'BUY' }, { direction: 'SELL' },
    { regime: 'chop' }, { regime: 'ranging' }, { regime: 'weak-trend' },
    { regime: 'trending' }, { regime: 'strong-trend' },
    { session: 'ASIA' }, { session: 'LONDON' }, { session: 'NEW_YORK' },
    { volRegime: 'LOW' }, { volRegime: 'MEDIUM' }, { volRegime: 'HIGH' },
    { spreadCond: 'tight' }, { spreadCond: 'normal' }, { spreadCond: 'wide' },
  ]

  const matches = (s: RSample, seg: Segment): boolean => {
    const d = s.dims
    if (seg.pair && d.pair !== seg.pair) return false
    if (seg.direction && d.direction !== seg.direction) return false
    if (seg.setupType && d.setupType !== seg.setupType) return false
    if (seg.regime && d.regime !== seg.regime) return false
    if (seg.session && d.session !== seg.session) return false
    if (seg.volRegime && d.volRegime !== seg.volRegime) return false
    if (seg.spreadCond && d.spreadCond !== seg.spreadCond) return false
    if (seg.signalStrengthLow !== undefined && seg.signalStrengthHigh !== undefined) {
      const c = num(d.confidence)
      if (c === null || c < seg.signalStrengthLow || c >= seg.signalStrengthHigh) return false
    }
    if (seg.mlConfLow !== undefined && seg.mlConfHigh !== undefined) {
      const m = num(d.mlWinProb)
      if (m === null || m < seg.mlConfLow || m >= seg.mlConfHigh) return false
    }
    return true
  }

  for (const base of baseSegs) {
    for (const extra of refine) {
      const merged: Segment = { ...base, ...extra }
      const bucket = samples.filter(s => matches(s, merged))
      if (bucket.length === 0) continue
      const key = segmentKeyOf(merged)
      if (out.some(b => b.key === key)) continue
      out.push({
        key,
        segment: merged,
        metrics: computeExpectancyMetrics(bucket),
        samples: bucket,
        specificity:
          (merged.pair ? 1 : 0) + (merged.direction ? 1 : 0) + (merged.session ? 1 : 0)
          + (merged.regime ? 1 : 0) + (merged.volRegime ? 1 : 0) + (merged.spreadCond ? 1 : 0),
      })
    }
  }

  // Confidence + ML win-prob bands over the whole pool.
  for (const conf of [0, 60, 70, 80, 90]) {
    const bucket = samples.filter(s => {
      const c = num(s.dims.confidence)
      return c !== null && c >= conf && c < conf + 10
    })
    if (bucket.length === 0) continue
    const key = segmentKeyOf({ signalStrengthLow: conf, signalStrengthHigh: conf + 10 })
    out.push({ key, segment: { signalStrengthLow: conf, signalStrengthHigh: conf + 10 },
      metrics: computeExpectancyMetrics(bucket), samples: bucket, specificity: 0 })
  }
  for (const low of [0, 0.5, 0.6, 0.7, 0.8]) {
    const bucket = samples.filter(s => {
      const m = num(s.dims.mlWinProb)
      return m !== null && m >= low && m < low + 0.1
    })
    if (bucket.length === 0) continue
    const key = segmentKeyOf({ mlConfLow: low, mlConfHigh: low + 0.1 })
    out.push({ key, segment: { mlConfLow: low, mlConfHigh: low + 0.1 },
      metrics: computeExpectancyMetrics(bucket), samples: bucket, specificity: 0 })
  }
  return out
}


// ── Candidate-setup lookup (most-specific-first with fallback chain) ──────────

export interface SetupContext {
  pair: string
  direction: 'BUY' | 'SELL'
  regime?: RegimeName | string | null
  session?: string
  volRegime?: string
  confidence?: number
  mlWinProb?: number
  spreadCond?: string
  setupType?: string
}

export interface ExpectancyVerdict {
  metrics: ExpectancyMetrics
  segment: Segment
  matchedSegments: { key: string; segment: Segment; metrics: ExpectancyMetrics }[]
  source: 'closed_trades' | 'predictions' | 'mixed'
}

/**
 * Best-evidenced expectancy for a candidate setup. Tries the most specific
 * dimension vector first, then progressively drops dimensions until a bucket
 * with usable evidence is found. Never invents confidence.
 */
export function lookupSetupExpectancy(
  samples: RSample[],
  ctx: SetupContext,
  minSamples = confMin(),
): ExpectancyVerdict | null {
  if (samples.length === 0) return null
  const segments = computeSegments(samples)

  // Candidate buckets whose dimensions do not contradict the context.
  const candidates = segments.filter(seg => {
    const s = seg.segment
    if (ctx.pair && s.pair && s.pair !== ctx.pair) return false
    if (ctx.direction && s.direction && s.direction !== ctx.direction) return false
    if (ctx.regime && s.regime && s.regime !== ctx.regime) return false
    if (ctx.session && s.session && s.session !== ctx.session) return false
    if (ctx.volRegime && s.volRegime && s.volRegime !== ctx.volRegime) return false
    if (ctx.spreadCond && s.spreadCond && s.spreadCond !== ctx.spreadCond) return false
    return true
  }).sort((a, b) => b.specificity - a.specificity || b.metrics.n - a.metrics.n)

  if (candidates.length === 0) return null

  const best =
    // 1. Most specific bucket with evidence ≥ minSamples.
    candidates.find(c => c.specificity > 0 && c.metrics.n >= minSamples)
    // 2. Widest bucket with usable evidence.
    ?? candidates.find(c => c.metrics.n >= minSamples)
    // 3. Most specific bucket even with thin evidence (authority will
    //    downgrade it via sample_confidence).
    ?? candidates[0]

  const hasUsd = best.samples.some(s => typeof s.usd === 'number')
  const noUsd = best.samples.some(s => s.usd === undefined)

  return {
    metrics: best.metrics,
    segment: best.segment,
    matchedSegments: candidates.slice(0, 5).map(c => ({ key: c.key, segment: c.segment, metrics: c.metrics })),
    source: hasUsd && noUsd ? 'mixed' : (noUsd ? 'predictions' : 'closed_trades'),
  }
}


// ── Fetch + cache + persist ───────────────────────────────────────────────────

export interface ExpectancyCacheEntry {
  at: number
  data: ExpectancyDataSet
  segments: SegmentedBucket[]
  byUserSegments: SegmentedBucket[]
}
let _cache: ExpectancyCacheEntry | null = null

/** Clear the in-memory expectancy cache (used by admin cache-reset endpoints). */
export function clearExpectancyCache(): void {
  _cache = null
}

export async function fetchExpectancyData(opts: ExpectancyFetchOptions = {}): Promise<ExpectancyCacheEntry> {
  const days = opts.days ?? windowDays()
  if (_cache && Date.now() - _cache.at < CACHE_TTL_MS) return _cache
  const [trades, preds, userTrades, userPreds] = await Promise.all([
    fetchClosedTradeSamples(null, days, MAX_ROWS_PER_SOURCE),
    fetchPredictionSamples(null, days, MAX_ROWS_PER_SOURCE),
    opts.userId
      ? fetchClosedTradeSamples(opts.userId, days, MAX_ROWS_PER_SOURCE)
      : Promise.resolve([] as RSample[]),
    opts.userId
      ? fetchPredictionSamples(opts.userId, days, MAX_ROWS_PER_SOURCE)
      : Promise.resolve([] as RSample[]),
  ])
  const entry: ExpectancyCacheEntry = {
    at: Date.now(),
    data: { samples: [...trades, ...preds], byUserSamples: [...userTrades, ...userPreds] },
    segments: computeSegments([...trades, ...preds]),
    byUserSegments: computeSegments([...userTrades, ...userPreds]),
  }
  _cache = entry
  return entry
}

const round4 = (v: number | null): number | null => (v === null || v === undefined ? null : +v.toFixed(4))
const round2 = (v: number | null): number | null => (v === null || v === undefined ? null : +v.toFixed(2))

function toStatRow(scopeUserId: string | null, key: string, segment: Segment, metrics: ExpectancyMetrics, computedFrom: string, days: number) {
  return {
    user_id: scopeUserId,
    segment_key: key,
    segment,
    computed_from: computedFrom,
    window_days: days,
    pair: segment.pair ?? null,
    direction: segment.direction ?? null,
    session: segment.session ?? null,
    regime: segment.regime ?? null,
    vol_regime: segment.volRegime ?? null,
    setup_type: segment.setupType ?? null,
    signal_strength_low: segment.signalStrengthLow ?? null,
    signal_strength_high: segment.signalStrengthHigh ?? null,
    sample_size: metrics.n,
    wins: metrics.wins,
    losses: metrics.losses,
    win_rate: round4(metrics.winRate),
    avg_win_r: round4(metrics.avgWinR),
    avg_loss_r: round4(metrics.avgLossR),
    expectancy_r: round4(metrics.expectancyR),
    profit_factor: metrics.profitFactor === null || metrics.profitFactor === Infinity ? null : round4(metrics.profitFactor),
    avg_win_usd: round2(metrics.avgWinUsd),
    avg_loss_usd: round2(metrics.avgLossUsd),
    median_win_r: round4(metrics.medianWinR),
    median_loss_r: round4(metrics.medianLossR),
    max_drawdown_r: round4(metrics.maxDrawdownR),
    recent_expectancy_r: round4(metrics.recentExpectancyR),
    long_term_expectancy_r: round4(metrics.longTermExpectancyR),
    sample_confidence: metrics.sampleConfidence,
    expectancy_status: metrics.status,
    computed_at: new Date().toISOString(),
  }
}

function computedFromOf(samples: RSample[]): 'closed_trades' | 'predictions' | 'mixed' {
  const hasUsd = samples.some(x => typeof x.usd === 'number')
  const noUsd = samples.some(x => x.usd === undefined)
  return hasUsd && noUsd ? 'mixed' : (noUsd ? 'predictions' : 'closed_trades')
}

/**
 * Recomputes segmented expectancy from live data and persists the statistics
 * table (idempotent per scope). Rows are replaced for the current window scope
 * (global user_id=NULL OR one user) — see migration 20260902. Because NULL
 * user_id rows cannot participate in Postgres ON CONFLICT, replacement uses a
 * delete-then-insert per scope.
 */
export async function refreshExpectancyStatistics(opts: ExpectancyFetchOptions = {}): Promise<ExpectancyCacheEntry> {
  const days = opts.days ?? windowDays()
  const entry = await fetchExpectancyData({ ...opts, days })
  const admin = getAdminClient()
  const computedFrom = computedFromOf(entry.data.samples)

  const insertScoped = async (scopeUserId: string | null, segments: SegmentedBucket[]) => {
    const rows = segments.map(sg => toStatRow(scopeUserId, sg.key, sg.segment, sg.metrics, computedFrom, days))
    if (rows.length === 0) return
    try {
      // Replace prior statistics for this scope + window (single materialised
      // snapshot per scope/window keeps the table lean and queries simple).
      let del = admin.from('expectancy_statistics').delete()
        .eq('window_days', days)
        .eq('computed_from', computedFrom)
      del = scopeUserId ? del.eq('user_id', scopeUserId) : del.is('user_id', null)
      await del
      const { error } = await admin.from('expectancy_statistics').insert(rows)
      if (error) console.warn('[expectancy] stats insert failed:', error.message)
    } catch (e: any) {
      console.warn('[expectancy] stats refresh failed:', e?.message)
    }
  }

  await Promise.all([
    insertScoped(null, entry.segments),
    opts.userId ? insertScoped(opts.userId, entry.byUserSegments) : Promise.resolve(),
  ])
  return entry
}

const STAT_PERSIST_COOLDOWN_MS = 15 * 60_000
let _lastStatPersistAt = 0

/**
 * Idempotent, throttled statistics persistence. Cheap no-op when the stats were
 * written recently — safe to call from every hot-path evaluation.
 */
export async function maybePersistExpectancyStats(opts: ExpectancyFetchOptions = {}): Promise<void> {
  if (_lastStatPersistAt && Date.now() - _lastStatPersistAt < STAT_PERSIST_COOLDOWN_MS) return
  try {
    await refreshExpectancyStatistics(opts)
    _lastStatPersistAt = Date.now()
  } catch (e: any) {
    console.warn('[expectancy] stats refresh failed:', e?.message)
  }
}

/** Public configuration surface for dashboards. */
export function expectancyConfig() {
  return {
    minPositiveR: EXPECTANCY_MIN_R(),
    sampleThresholds: { low: confMin(), moderate: confMid(), strong: confStrong() },
    windowDaysDefault: windowDays(),
    cacheTtlMs: CACHE_TTL_MS,
  }
}
