// lib/backtest.ts
// ─────────────────────────────────────────────────────────────────────────────
// Phase 10 — walk-forward backtest harness.
//
// Answers: "If we had gated the last N days of tradable signals with the new
// Expectancy → Authority → Safety layers (instead of the current confidence /
// agreement gate alone), what would the P&L curve have been?"
//
// Method (no lookahead):
//   1. Load every RESOLVED prediction_logs episode (WIN/LOSS/INCONCLUSIVE)
//      with its SL/TP-touch R multiple (same semantics as the Expectancy
//      Engine). Each episode is both a candidate (decided at signal time) and
//      evidence (knowable only at resolution time).
//   2. Walk candidates in signal-time order. For each, the expectancy of its
//      segment is computed from the strict prefix of episodes whose outcome
//      was already knowable BEFORE the candidate fired — no future info leaks.
//      Segmented statistics are recomputed in buckets (every K resolved
//      episodes) for tractability.
//   3. Four configurations decide on every candidate:
//        current    — the live gate: confidence ≥ max(confFloor, regime
//                     effectiveMinStrength) AND not a low-agreement signal.
//        expectancy — current AND the candidate's segment shows a POSITIVE+
//                     expectancy with usable sample size.
//        authority  — expectancy AND the Trade Authority approves (includes
//                     the base safety gate, agreement & contradiction vetoes).
//        safety     — authority AND safety score ≥ strict bar (default 80),
//                     measuring the marginal value of a higher safety floor.
//   4. Outcomes are realised when each taken episode resolves; per-config
//      equity curves, R-expectancy, drawdown, losing streaks, Sharpe/Sortino,
//      missed opportunities and false positives are reported.
// ─────────────────────────────────────────────────────────────────────────────
import { getAdminClient } from '@/lib/supabase'
import {
  computeSegments, pipSizeOf, sessionOf, spreadConditionOf,
  type ExpectancyMetrics, type ExpectancyVerdict, type RegimeName, type RSample,
  type Segment, type SegmentedBucket,
} from '@/lib/expectancy-engine'
import { computeSafetyScore, type SafetyResult } from '@/lib/safety-score'
import { adjudicateAuthority, type AuthorityContext, type AuthorityVerdict } from '@/lib/trade-authority'

// ── Config (env-overridable) ─────────────────────────────────────────────────
const REGIME_MIN_STRENGTH: Record<string, number> = {
  chop: 100, ranging: 78, 'weak-trend': 75, trending: 72, 'strong-trend': 100,
}
const CONFIG_LABEL: Record<ConfigKey, string> = {
  current:   'CURRENT SYSTEM',
  expectancy: 'CURRENT + EXPECTANCY',
  authority: 'CURRENT + EXPECTANCY + AUTHORITY',
  safety:    'CURRENT + EXPECTANCY + AUTHORITY + SAFETY',
}
const BUCKET_SIZE = 40            // segment recompute granularity (episodes)
const RISK_PCT_PER_TRADE = 1      // assumed fixed fractional risk for total-return %

export type ConfigKey = 'current' | 'expectancy' | 'authority' | 'safety'

export interface BacktestOptions {
  days?: number
  userId?: string | null
  confFloor?: number
  strictSafetyMin?: number
  minSamples?: number
  force?: boolean         // bypass the 10-minute cache
}

export interface BacktestEpisode {
  id: string
  source: 'prediction'
  pair: string
  direction: 'BUY' | 'SELL'
  outcome: 'WIN' | 'LOSS' | 'INCONCLUSIVE'
  r: number
  tsIso: string
  signalTs: number
  knownTs: number
  // Segment + gate dimensions
  regime: string | null
  session: string
  volRegime: string
  spreadCond: string
  confidence: number | null
  effectiveMinStrength: number | null
  agreementScore: number | null
  agreementVotesCount: number | null
  mlWinProb: number | null
  spreadPips: number | null
  atrPips: number | null
  slPips: number | null
}

const nn = (v: unknown): number | null => {
  const x = Number(v)
  return Number.isFinite(x) ? x : null
}


// ── Load + normalise resolved prediction episodes ─────────────────────────────

function buildEpisode(row: any): BacktestEpisode | null {
  const pair = row.pair
  const direction = row.direction
  if (direction !== 'BUY' && direction !== 'SELL') return null
  const outcome = row.outcome
  if (outcome !== 'WIN' && outcome !== 'LOSS' && outcome !== 'INCONCLUSIVE') return null
  const entry = nn(row.entry)
  const sl = nn(row.sl)
  if (entry === null || sl === null || entry === sl) return null

  const pip = pipSizeOf(pair)
  const slPips = nn(row.sl_pips) ?? Math.abs(entry - sl) / pip
  if (!(slPips > 0)) return null

  const tp = nn(row.tp)
  const tpPips = tp ? Math.abs(tp - entry) / pip : null
  const mfe = nn(row.mfe_pips)
  const mae = nn(row.mae_pips)

  let r: number | null = nn(row.r_multiple)
  if (r === null) {
    if (outcome === 'WIN') {
      const measured = Math.max(0.5, (mfe ?? slPips) / slPips)
      r = tpPips ? tpPips / slPips : measured
    } else if (outcome === 'LOSS') {
      r = -Math.max(1, (mae ?? slPips) / slPips)
    } else {
      r = 0   // scratch — resolved without touching SL or TP
    }
  }
  if (r === null || !Number.isFinite(r)) return null

  const snap: any = row.indicator_snapshot || {}
  const audit: any = snap?._audit || {}
  const regime = row.regime ?? snap?._regime?.marketRegime ?? null
  const atrRaw = nn(snap.atrPips) ?? nn(snap.atr ? snap.atr / pip : null)
  const atrPips = atrRaw
  const spreadPips = nn(snap.spreadPips) ?? 0
  const votes = Array.isArray(audit.agreementVotes) ? audit.agreementVotes.length : null
  const createdMs = new Date(row.created_at).getTime()
  const resolvedAt = row.resolved_at ? new Date(row.resolved_at).getTime() : createdMs + 16 * 60_000

  return {
    id: String(row.id),
    source: 'prediction',
    pair,
    direction,
    outcome,
    r,
    tsIso: row.created_at,
    signalTs: createdMs,
    knownTs: resolvedAt,
    regime,
    session: row.session ?? sessionOf(row.created_at),
    volRegime: row.vol_regime
      ?? (atrPips ? (atrPips >= 12 ? 'HIGH' : atrPips >= 6 ? 'MEDIUM' : 'LOW') : 'MEDIUM'),
    spreadCond: row.spread_condition ?? spreadConditionOf(spreadPips, atrPips ?? 1),
    confidence: nn(row.confidence),
    effectiveMinStrength: nn(snap?._regime?.effectiveMinStrength) ?? null,
    agreementScore: nn(row.agreement_score),
    agreementVotesCount: votes,
    mlWinProb: audit.mlWinProb !== undefined ? nn(audit.mlWinProb) ?? null : null,
    spreadPips,
    atrPips,
    slPips,
  }
}

async function loadEpisodes(opts: BacktestOptions): Promise<BacktestEpisode[]> {
  const admin = getAdminClient()
  const days = Math.max(7, Math.min(365, opts.days ?? 90))
  const cutoff = new Date(Date.now() - days * 86400_000).toISOString()
  const limit = 5000
  let q = admin
    .from('prediction_logs')
    .select('id, pair, direction, entry, sl, tp, confidence, outcome, regime, session,'
          + ' vol_regime, spread_condition, setup_type, sl_pips, r_multiple,'
          + ' agreement_score, mfe_pips, mae_pips, indicator_snapshot, created_at, resolved_at')
    .in('outcome', ['WIN', 'LOSS', 'INCONCLUSIVE'])
    .gte('created_at', cutoff)
    .order('created_at', { ascending: false })
    .limit(limit)
  if (opts.userId) q = q.eq('user_id', opts.userId)
  const { data, error } = await q
  if (error) throw error
  const out: BacktestEpisode[] = []
  for (const row of (data || [])) {
    const ep = buildEpisode(row)
    if (ep) out.push(ep)
  }
  return out
}


// ── Point-in-time segment lookup over a known-pool segmentation ───────────────

export interface BtExpVerdict {
  metrics: ExpectancyMetrics
  segment: Segment
  matchedSegments: { key: string; segment: Segment; metrics: ExpectancyMetrics }[]
  source: 'predictions'
}

/** Same matching rules as the Expectancy Engine, but over an existing
 *  segmentation (no recompute) — used for every candidate in the walk. */
function lookupExpectancy(
  segments: SegmentedBucket[],
  ep: BacktestEpisode,
  minSamples: number,
): BtExpVerdict | null {
  if (segments.length === 0) return null
  const candidates = segments.filter(seg => {
    const s = seg.segment
    if (s.pair && s.pair !== ep.pair) return false
    if (s.direction && s.direction !== ep.direction) return false
    if (ep.regime && s.regime && s.regime !== ep.regime) return false
    if (s.session && s.session !== ep.session) return false
    if (s.volRegime && s.volRegime !== ep.volRegime) return false
    if (s.spreadCond && s.spreadCond !== ep.spreadCond) return false
    return true
  }).sort((a, b) => b.specificity - a.specificity || b.metrics.n - a.metrics.n)

  if (candidates.length === 0) return null
  const best =
    candidates.find(c => c.specificity > 0 && c.metrics.n >= minSamples)
    ?? candidates.find(c => c.metrics.n >= minSamples)
    ?? candidates[0]
  return {
    metrics: best.metrics,
    segment: best.segment,
    matchedSegments: candidates.slice(0, 5).map(c => ({ key: c.key, segment: c.segment, metrics: c.metrics })),
    source: 'predictions',
  }
}

const POSITIVE = new Set(['POSITIVE', 'STRONG', 'VERY_STRONG'])

/** BacktestEpisode → RSample (engine segmentation input). */
function epToSample(ep: BacktestEpisode): RSample {
  return {
    r: ep.r,
    win: ep.outcome === 'WIN',
    ts: ep.tsIso,
    dims: {
      pair: ep.pair,
      direction: ep.direction,
      regime: (ep.regime as RegimeName | null) ?? null,
      session: ep.session,
      volRegime: ep.volRegime,
      confidence: ep.confidence ?? undefined,
      mlWinProb: ep.mlWinProb ?? undefined,
      spreadCond: ep.spreadCond,
      setupType: 'prediction',
    },
  }
}

/** Safety inputs reconstructed from the stored signal snapshot. */
function safetyFor(ep: BacktestEpisode): SafetyResult {
  return computeSafetyScore({
    pair: ep.pair,
    direction: ep.direction,
    regime: ep.regime,
    session: ep.session,
    spreadPips: ep.spreadPips ?? undefined,
    atrPips: ep.atrPips ?? undefined,
    slPips: ep.slPips ?? undefined,
    // HTF bias is not persisted in prediction_logs — treat as ambiguous (no veto).
    htfBias15m: null,
    htfBias1h: null,
    newsInWindow: false,
    openPositions: 0,
    maxPositions: 2,
  })
}


// ── Decision evaluation for one candidate ─────────────────────────────────────

interface Decision {
  trade: boolean
  skip?: string          // first failing reason (diagnostics)
}

function evaluateCandidate(
  ep: BacktestEpisode,
  verdict: BtExpVerdict | null,
  safety: SafetyResult,
  auth: AuthorityVerdict,
  opts: { confFloor: number; strictSafetyMin: number; minSamples: number },
): Record<ConfigKey, Decision> {
  const out = {} as Record<ConfigKey, Decision>

  // Baseline (CURRENT): confidence gate + agreement veto (mirrors the worker).
  const effMin = ep.effectiveMinStrength ?? REGIME_MIN_STRENGTH[ep.regime ?? ''] ?? 70
  const confOk = ep.confidence !== null && ep.confidence >= Math.max(opts.confFloor, effMin)
  const opinionated = ep.agreementVotesCount !== null && ep.agreementVotesCount >= 3
  const agreementOk = !(opinionated && ep.agreementScore !== null && ep.agreementScore < 40)

  const current = confOk && agreementOk
  out.current = current ? { trade: true } : { trade: false, skip: !confOk ? 'confidence' : 'agreement' }

  // EXPECTANCY: segment shows a positive expectancy with usable sample size.
  const expPass = verdict !== null && POSITIVE.has(verdict.metrics.status) && verdict.metrics.n >= opts.minSamples
  out.expectancy = current && expPass
    ? { trade: true }
    : { trade: false, skip: current ? 'expectancy' : out.current.skip }

  // AUTHORITY: Trade Authority APPROVED (bundles the expectancy veto, the
  // agreement self-contradiction veto and base safety ≥ SAFETY_EXECUTE_MIN).
  const authPass = auth.status === 'APPROVED'
  out.authority = current && authPass
    ? { trade: true }
    : { trade: false, skip: current ? 'authority' : out.current.skip }

  // SAFETY: authority-approved AND score clears a stricter bar — measures the
  // marginal value of raising the safety floor above the authority minimum.
  const safetyPass = authPass && safety.total >= opts.strictSafetyMin
  out.safety = current && safetyPass
    ? { trade: true }
    : { trade: false, skip: current ? 'safety' : out.current.skip }

  return out
}


// ── Metrics + simulation ──────────────────────────────────────────────────────

export interface BacktestMonthly {
  month: string          // YYYY-MM
  trades: number
  wins: number
  losses: number
  r: number
}

export interface ConfigMetrics {
  config: ConfigKey
  label: string
  trades: number
  wins: number
  losses: number
  scratches: number
  winRate: number | null
  expectancyR: number | null          // mean R across all taken trades
  avgWinR: number | null
  avgLossR: number | null
  profitFactor: number | null
  totalReturnR: number
  totalReturnPct: number | null       // fixed 1% risk-per-trade approximation
  maxDrawdownR: number | null
  losingStreak: number
  averageTradeR: number | null        // identical to expectancyR (no fees modelled)
  sharpePerTrade: number | null
  sortinoPerTrade: number | null
  sharpeAnnualized: number | null     // × sqrt(tradesPerYear from observed span)
  missedWins: number                  // vs CURRENT: skipped by this config, CURRENT took, r>0
  missedWinSumR: number
  avoidedLosses: number               // vs CURRENT: skipped by this config, CURRENT took, r<0
  falsePositives: number              // vs CURRENT: extra trades this config took, r<0
  falsePositiveSumR: number
  skipReasons: Record<string, number>
  monthly: BacktestMonthly[]
}

export interface BacktestResult {
  ok: boolean
  warnings: string[]
  options: { days: number; userId: string | null; confFloor: number; strictSafetyMin: number; minSamples: number }
  dateFrom: string | null
  dateTo: string | null
  candidates: number
  evidence: number
  segmentsTracked: number
  runs: Record<ConfigKey, ConfigMetrics>
  timeline: BacktestMonthly[]
}

const mean = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null)
const stdev = (a: number[]) => {
  if (a.length < 2) return null
  const m = mean(a)!
  const v = a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)
  return Math.sqrt(v)
}

function computeMetrics(
  config: ConfigKey,
  events: { ep: BacktestEpisode }[],
  skipReasons: Record<string, number>,
): ConfigMetrics {
  const sorted = [...events].sort((a, b) => a.ep.knownTs - b.ep.knownTs)
  const rs = sorted.map(e => e.ep.r)
  const wins = sorted.filter(e => e.ep.outcome === 'WIN')
  const losses = sorted.filter(e => e.ep.outcome === 'LOSS')
  const scratches = sorted.filter(e => e.ep.outcome === 'INCONCLUSIVE')

  let cum = 0, peak = 0, maxDD = 0, losingStreak = 0, curLossStreak = 0
  for (const e of sorted) {
    cum += e.ep.r
    if (cum > peak) peak = cum
    const dd = peak - cum
    if (dd > maxDD) maxDD = dd
    curLossStreak = e.ep.r < 0 ? curLossStreak + 1 : 0
    if (curLossStreak > losingStreak) losingStreak = curLossStreak
  }

  const sd = stdev(rs)
  const downside = stdev(rs.map(r => Math.min(0, r)))
  const rMean = mean(rs)
  const spanDays = sorted.length > 1
    ? Math.max(1, (sorted[sorted.length - 1].ep.knownTs - sorted[0].ep.knownTs) / 86400_000)
    : 1
  const tradesPerYear = sorted.length > 0 ? (sorted.length / spanDays) * 365 : 0

  const grossWin = wins.reduce((s, e) => s + e.ep.r, 0)
  const grossLoss = Math.abs(losses.reduce((s, e) => s + e.ep.r, 0))

  // Monthly buckets over the backtest span.
  const monthMap = new Map<string, BacktestMonthly>()
  for (const e of sorted) {
    const month = new Date(e.ep.knownTs).toISOString().slice(0, 7)
    const b = monthMap.get(month) ?? { month, trades: 0, wins: 0, losses: 0, r: 0 }
    b.trades++; b.r += e.ep.r
    if (e.ep.outcome === 'WIN') b.wins++
    if (e.ep.outcome === 'LOSS') b.losses++
    monthMap.set(month, b)
  }
  const monthly = Array.from(monthMap.values()).sort((a, b) => (a.month < b.month ? -1 : 1))

  return {
    config, label: CONFIG_LABEL[config],
    trades: sorted.length, wins: wins.length, losses: losses.length, scratches: scratches.length,
    winRate: wins.length + losses.length ? wins.length / (wins.length + losses.length) : null,
    expectancyR: rMean,
    avgWinR: wins.length ? grossWin / wins.length : null,
    avgLossR: losses.length ? grossLoss / losses.length : null,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : (grossWin > 0 ? Infinity : null),
    totalReturnR: +cum.toFixed(4),
    totalReturnPct: rMean === null ? null : +(cum * RISK_PCT_PER_TRADE).toFixed(4),
    maxDrawdownR: sorted.length ? +maxDD.toFixed(4) : null,
    losingStreak,
    averageTradeR: rMean !== null ? +rMean.toFixed(4) : null,
    sharpePerTrade: rMean !== null && sd !== null && sd > 0 ? +(rMean / sd).toFixed(4) : null,
    sortinoPerTrade: rMean !== null && downside !== null && downside > 0 ? +(rMean / downside).toFixed(4) : null,
    sharpeAnnualized: rMean !== null && sd !== null && sd > 0 && tradesPerYear > 0
      ? +((rMean / sd) * Math.sqrt(tradesPerYear)).toFixed(2)
      : null,
    // Cross-system comparisons are filled by the runner (needs all configs' sets).
    missedWins: 0, missedWinSumR: 0, avoidedLosses: 0, falsePositives: 0, falsePositiveSumR: 0,
    skipReasons,
    monthly,
  }
}


// ── Walk-forward runner ───────────────────────────────────────────────────────

const BACKTEST_TTL_MS = 10 * 60_000
const _cache = new Map<string, { at: number; value: BacktestResult }>()

/** Clear the in-memory backtest cache (admin cache resets). */
export function clearBacktestCache(): void {
  _cache.clear()
}

const envInt = (key: string, def: number) => {
  const v = parseInt(process.env[key] || '', 10)
  return Number.isFinite(v) ? v : def
}

function blankMetrics(config: ConfigKey): ConfigMetrics {
  return {
    config, label: CONFIG_LABEL[config], trades: 0, wins: 0, losses: 0, scratches: 0,
    winRate: null, expectancyR: null, avgWinR: null, avgLossR: null, profitFactor: null,
    totalReturnR: 0, totalReturnPct: null, maxDrawdownR: null, losingStreak: 0,
    averageTradeR: null, sharpePerTrade: null, sortinoPerTrade: null, sharpeAnnualized: null,
    missedWins: 0, missedWinSumR: 0, avoidedLosses: 0, falsePositives: 0, falsePositiveSumR: 0,
    skipReasons: {}, monthly: [],
  }
}

function emptyResult(opts: BacktestOptions, warnings: string[]): BacktestResult {
  return {
    ok: false, warnings,
    options: {
      days: opts.days ?? 90,
      userId: opts.userId ?? null,
      confFloor: opts.confFloor ?? envInt('BACKTEST_CONF_FLOOR', 60),
      strictSafetyMin: opts.strictSafetyMin ?? envInt('BACKTEST_SAFETY_STRICT', 80),
      minSamples: opts.minSamples ?? envInt('BACKTEST_MIN_SAMPLES', 20),
    },
    dateFrom: null, dateTo: null, candidates: 0, evidence: 0, segmentsTracked: 0,
    runs: {
      current: blankMetrics('current'),
      expectancy: blankMetrics('expectancy'),
      authority: blankMetrics('authority'),
      safety: blankMetrics('safety'),
    },
    timeline: [],
  }
}

export async function runBacktest(rawOpts: BacktestOptions = {}): Promise<BacktestResult> {
  const days = Math.max(7, Math.min(365, rawOpts.days ?? envInt('BACKTEST_WINDOW_DAYS', 90)))
  const confFloor = Math.max(0, Math.min(100, rawOpts.confFloor ?? envInt('BACKTEST_CONF_FLOOR', 60)))
  const strictSafetyMin = Math.max(0, Math.min(100, rawOpts.strictSafetyMin ?? envInt('BACKTEST_SAFETY_STRICT', 80)))
  const minSamples = Math.max(5, rawOpts.minSamples ?? envInt('BACKTEST_MIN_SAMPLES', 20))
  const userId = rawOpts.userId ?? null

  const key = `${days}|${userId ?? 'global'}|${confFloor}|${strictSafetyMin}|${minSamples}`
  const cached = _cache.get(key)
  if (!rawOpts.force && cached && Date.now() - cached.at < BACKTEST_TTL_MS) return cached.value

  const warnings: string[] = []
  let episodes: BacktestEpisode[] = []
  try {
    episodes = await loadEpisodes({ days, userId })
  } catch (e: any) {
    return emptyResult({ days, userId }, [`Failed to load prediction_logs: ${e?.message ?? e}`])
  }
  if (episodes.length < 20) {
    return emptyResult({ days, userId }, [
      `Only ${episodes.length} resolved episodes in the last ${days}d — not enough for a meaningful comparison. ` +
      'Run the worker 24/7 for longer, then retry.',
    ])
  }

  // Candidates = every resolved tradable episode, ordered by signal time.
  const candidates = [...episodes].sort((a, b) => a.signalTs - b.signalTs)
  const evidence = [...episodes].sort((a, b) => a.knownTs - b.knownTs)

  const takenByConfig: Record<ConfigKey, Set<string>> = {
    current: new Set(), expectancy: new Set(), authority: new Set(), safety: new Set(),
  }
  const eventsByConfig: Record<ConfigKey, BacktestEpisode[]> = {
    current: [], expectancy: [], authority: [], safety: [],
  }
  const skipByConfig: Record<ConfigKey, Record<string, number>> = {
    current: {}, expectancy: {}, authority: {}, safety: {},
  }

  let eIdx = 0
  let segments: SegmentedBucket[] = []
  let lastBucket = -1
  let maxSegments = 0

  const bumpSkip = (cfg: ConfigKey, reason: string | undefined) => {
    if (!reason) return
    skipByConfig[cfg][reason] = (skipByConfig[cfg][reason] ?? 0) + 1
  }

  for (const cand of candidates) {
    while (eIdx < evidence.length && evidence[eIdx].knownTs <= cand.signalTs) eIdx++
    const bucket = Math.floor(eIdx / BUCKET_SIZE)
    if (bucket !== lastBucket) {
      // Evidence = episodes whose outcome was knowable before this candidate;
      // only WIN/LOSS outcomes seed the segment statistics (a scratch / no-touch
      // is not a realised R outcome — same exclusion the Expectancy Engine uses).
      const prefix = evidence.slice(0, eIdx).filter(e => e.outcome !== 'INCONCLUSIVE')
      segments = prefix.length > 0 ? computeSegments(prefix.map(epToSample)) : []
      if (segments.length > maxSegments) maxSegments = segments.length
      lastBucket = bucket
    }

    const verdict = eIdx > 0 ? lookupExpectancy(segments, cand, minSamples) : null
    const safety = safetyFor(cand)
    const ctx: AuthorityContext = {
      pair: cand.pair,
      direction: cand.direction,
      mode: 'shadow',
      signalConfidence: cand.confidence,
      agreementScore: cand.agreementScore,
      mlWinProb: cand.mlWinProb,
      htfBias15m: null,
      htfBias1h: null,
      expectancy: verdict as ExpectancyVerdict | null,
      safety,
      setupContext: {
        pair: cand.pair,
        direction: cand.direction,
        regime: cand.regime ?? undefined,
        session: cand.session,
        volRegime: cand.volRegime,
        confidence: cand.confidence ?? undefined,
        mlWinProb: cand.mlWinProb ?? undefined,
        spreadCond: cand.spreadCond,
        setupType: 'scalper',
      },
    }
    const auth = adjudicateAuthority(ctx)
    const dec = evaluateCandidate(cand, verdict, safety, auth, { confFloor, strictSafetyMin, minSamples })

    for (const cfg of Object.keys(dec) as ConfigKey[]) {
      if (dec[cfg].trade) {
        takenByConfig[cfg].add(cand.id)
        eventsByConfig[cfg].push(cand)
      } else {
        bumpSkip(cfg, dec[cfg].skip)
      }
    }
  }

  const order: ConfigKey[] = ['current', 'expectancy', 'authority', 'safety']
  const runs = {} as Record<ConfigKey, ConfigMetrics>
  for (const cfg of order) {
    runs[cfg] = computeMetrics(cfg, eventsByConfig[cfg].map(ep => ({ ep })), skipByConfig[cfg])
  }

  // Layer-to-layer comparisons: each tighter config vs its predecessor, plus
  // each system's executed failures ("false positives" = traded and lost).
  const byId = new Map<string, BacktestEpisode>(candidates.map(c => [c.id, c]))
  for (let i = 0; i < order.length; i++) {
    const cfg = order[i]
    const taken = takenByConfig[cfg]
    for (const id of taken) {
      const ep = byId.get(id)
      if (ep && ep.r < 0) { runs[cfg].falsePositives++; runs[cfg].falsePositiveSumR += ep.r }
    }
    runs[cfg].falsePositiveSumR = +runs[cfg].falsePositiveSumR.toFixed(4)
    if (i === 0) continue
    const prev = takenByConfig[order[i - 1]]
    for (const id of prev) {
      if (taken.has(id)) continue
      const ep = byId.get(id)
      if (!ep) continue
      if (ep.r > 0) { runs[cfg].missedWins++; runs[cfg].missedWinSumR += ep.r }
      else if (ep.r < 0) runs[cfg].avoidedLosses++
    }
    runs[cfg].missedWinSumR = +runs[cfg].missedWinSumR.toFixed(4)
  }

  if (takenByConfig.current.size === 0) {
    warnings.push('CURRENT config took zero trades — check confFloor/agreement thresholds against your data.')
  }

  const dates = candidates.map(c => c.signalTs).sort((a, b) => a - b)
  const result: BacktestResult = {
    ok: true,
    warnings,
    options: { days, userId, confFloor, strictSafetyMin, minSamples },
    dateFrom: dates.length ? new Date(dates[0]).toISOString() : null,
    dateTo: dates.length ? new Date(dates[dates.length - 1]).toISOString() : null,
    candidates: candidates.length,
    evidence: evidence.length,
    segmentsTracked: maxSegments,
    runs,
    timeline: runs.current.monthly,
  }
  _cache.set(key, { at: Date.now(), value: result })
  return result
}
