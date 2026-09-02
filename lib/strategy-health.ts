// lib/strategy-health.ts
// ─────────────────────────────────────────────────────────────────────────────
// Strategy health snapshots (Phase 7/10): aggregates the evidence required to
// answer "is the bot healthy?" — trade volume, expectancy, filter bottlenecks,
// signal scarcity, authority decisions and recurring failure patterns — and
// stores it in strategy_health (1d / 7d / 30d windows, idempotent upsert).
// ─────────────────────────────────────────────────────────────────────────────
import { getAdminClient } from '@/lib/supabase'
import { computeExpectancyMetrics, fetchExpectancyData } from '@/lib/expectancy-engine'
import { recurringFailurePatterns } from '@/lib/loss-diagnosis'

export interface StrategyHealth {
  window: '1d' | '7d' | '30d'
  days: number
  payload: {
    recordedAt: string
    trades: {
      closed: number; wins: number; losses: number; winRate: number | null
      expectancyR: number | null; avgR: number | null
    }
    signalsPer24h: number | null
    authority: { approved: number; denied: number; review: number; noop: number }
    setupAlerts: { sent: number; total: number }
    filterBottlenecks: { filter: string; count: number }[]
    rejectionCount: number
    failurePatterns: { code: string; count: number }[]
    diagnosisCritical: number
  }
}

const windows = { '1d': 1, '7d': 7, '30d': 30 } as const
export type HealthWindow = keyof typeof windows
const HEALTH_TTL_MS = 15 * 60_000
const _cache = new Map<string, { at: number; value: StrategyHealth }>()

/** Clear the in-memory strategy-health cache (admin cache resets). */
export function clearStrategyHealthCache(): void {
  _cache.clear()
}

export async function computeStrategyHealth(w: HealthWindow = '30d', userId?: string | null): Promise<StrategyHealth> {
  const days = windows[w]
  const admin = getAdminClient()
  const cutoff = new Date(Date.now() - days * 86400_000).toISOString()
  const nowIso = new Date().toISOString()

  // ── Closed trades (WIN/LOSS) in window → win rate + expectancy ─────────────
  let q = admin
    .from('trades')
    .select('result')
    .in('result', ['WIN', 'LOSS'])
    .gte('opened_at', cutoff)
    .limit(5000)
  if (userId) q = q.eq('user_id', userId)
  const { data: trades, error: tradesErr } = await q
  if (tradesErr) throw tradesErr
  const wins = (trades || []).filter(t => t.result === 'WIN').length
  const losses = (trades || []).filter(t => t.result === 'LOSS').length
  const closed = wins + losses
  const winRate = closed ? wins / closed : null

  // Realised-R expectancy from the engine's closed-trade samples.
  let expectancyR: number | null = null
  let avgR: number | null = null
  try {
    const data = await fetchExpectancyData({ userId, days })
    const pool = data.data.samples.filter(s => typeof s.usd === 'number')
    const m = computeExpectancyMetrics(pool)
    expectancyR = m.expectancyR
    avgR = m.n ? pool.reduce((a, s) => a + s.r, 0) / m.n : null
  } catch (e: any) {
    console.warn('[strategy-health] expectancy fetch failed:', e?.message)
  }


  // ── Signal scarcity: tradable (non-HOLD) signals per 24h ───────────────────
  let signalsPer24h: number | null = null
  {
    let sq = admin
      .from('signals')
      .select('id', { count: 'exact', head: true })
      .gte('created_at', cutoff)
      .neq('direction', 'HOLD')
      .limit(1)
    if (userId) sq = sq.eq('user_id', userId)
    const { count } = await sq
    if (typeof count === 'number') signalsPer24h = +(count / Math.max(1, days)).toFixed(1)
  }

  // ── Authority decisions ─────────────────────────────────────────────────────
  const authorityCounts = { approved: 0, denied: 0, review: 0, noop: 0 }
  {
    let aq = admin
      .from('trade_authority_decisions')
      .select('status')
      .gte('created_at', cutoff)
      .limit(5000)
    if (userId) aq = aq.eq('user_id', userId)
    const { data: ad } = await aq
    for (const r of (ad || [])) {
      const key = (r.status || '').toLowerCase() as keyof typeof authorityCounts
      if (key in authorityCounts) authorityCounts[key]++
    }
  }

  // ── Setup alerts ────────────────────────────────────────────────────────────
  let alertsSent = 0, alertsTotal = 0
  {
    let aq = admin
      .from('setup_alerts')
      .select('status')
      .gte('created_at', cutoff)
      .limit(5000)
    if (userId) aq = aq.eq('user_id', userId)
    const { data: al } = await aq
    alertsTotal = (al || []).length
    alertsSent = (al || []).filter(a => a.status === 'SENT').length
  }

  // ── Filter bottlenecks (who rejects the most?) ──────────────────────────────
  const rejectionCounts: Record<string, number> = {}
  let rejectionCount = 0
  {
    let fq = admin
      .from('filter_rejections')
      .select('filter_name')
      .gte('created_at', cutoff)
      .limit(5000)
    if (userId) fq = fq.eq('user_id', userId)
    const { data: fr } = await fq
    for (const r of (fr || [])) {
      rejectionCounts[r.filter_name] = (rejectionCounts[r.filter_name] ?? 0) + 1
      rejectionCount++
    }
  }

  // ── Recurring failure patterns ──────────────────────────────────────────────
  const patterns = await recurringFailurePatterns(days, userId)

  const health: StrategyHealth = {
    window: w, days,
    payload: {
      recordedAt: nowIso,
      trades: { closed, wins, losses, winRate, expectancyR, avgR },
      signalsPer24h,
      authority: authorityCounts,
      setupAlerts: { sent: alertsSent, total: alertsTotal },
      filterBottlenecks: Object.entries(rejectionCounts)
        .map(([filter, count]) => ({ filter, count }))
        .sort((a, b) => b.count - a.count),
      rejectionCount,
      failurePatterns: patterns.ranked,
      diagnosisCritical: patterns.critical,
    },
  }
  return health
}
export async function getStrategyHealth(
  w: HealthWindow = '30d',
  userId?: string | null,
  opts: { refresh?: boolean } = {},
): Promise<StrategyHealth> {
  const key = `${w}:${userId ?? 'global'}`
  const cached = _cache.get(key)
  if (!opts.refresh && cached && Date.now() - cached.at < HEALTH_TTL_MS) return cached.value

  // Prefer the persisted snapshot when fresh enough, else recompute + persist.
  try {
    const admin = getAdminClient()
    let hq = admin.from('strategy_health').select('payload').eq('window', w)
    hq = userId ? hq.eq('user_id', userId) : hq.is('user_id', null)
    const { data } = await hq.maybeSingle()
    const recorded = data?.payload?.recordedAt ? new Date(data.payload.recordedAt).getTime() : 0
    if (data?.payload && Date.now() - recorded < HEALTH_TTL_MS) {
      const value = { window: w, days: windows[w], payload: data.payload } as StrategyHealth
      _cache.set(key, { at: Date.now(), value })
      return value
    }
  } catch { /* fall through to recompute */ }

  const value = await computeStrategyHealth(w, userId)
  try {
    const admin = getAdminClient()
    // Replace the prior snapshot for this scope + window. NULL user_id rows
    // can't use ON CONFLICT, so this is delete-then-insert per scope.
    let del = admin.from('strategy_health').delete().eq('window', w)
    del = userId ? del.eq('user_id', userId) : del.is('user_id', null)
    await del
    await admin.from('strategy_health').insert({
      user_id: userId ?? null,
      window: w,
      payload: value.payload,
      recorded_at: new Date().toISOString(),
    })
  } catch (e: any) {
    console.warn('[strategy-health] persist failed:', e?.message)
  }
  _cache.set(key, { at: Date.now(), value })
  return value
}

