// app/api/data-health/route.ts
// Data Health + early-gate bottleneck counters (audit 2026-09-03).
// One endpoint answering "is the pipeline producing and resolving enough
// data, and where are opportunities being lost?" — counts straight from the
// production database, no frontend involved.
export const dynamic = 'force-dynamic'

import { NextResponse } from 'next/server'
import { getAdminClient } from '@/lib/supabase'

const iso = (h: number) => new Date(Date.now() - h * 3600_000).toISOString()

async function count(table: string, col: string, gte?: string, extra: Record<string, string> = {}): Promise<number> {
  const admin = getAdminClient()
  let q: any = admin.from(table).select('id', { count: 'exact', head: true })
  if (gte) q = q.gte(col, gte)
  for (const [k, v] of Object.entries(extra)) {
    if (v === 'null') q = q.is(k, null)
    else if (v.startsWith('in:')) q = q.in(k, v.slice(3).split(','))
    else if (v.startsWith('neq:')) q = q.neq(k, v.slice(4))
    else q = q.eq(k, v)
  }
  const { count: c } = await q
  return typeof c === 'number' ? c : 0
}

export async function GET() {
  try {
    const admin = getAdminClient()
    const h24 = iso(24), d7 = iso(24 * 7), d30 = iso(24 * 30)

    // Prediction logs — the core evidence pool for expectancy.
    const [pl7, pl30, plWin, plLoss, plInc, plUnresolved, plStale] = await Promise.all([
      count('prediction_logs', 'created_at', d7),
      count('prediction_logs', 'created_at', d30),
      count('prediction_logs', 'created_at', d7, { outcome: 'WIN' }),
      count('prediction_logs', 'created_at', d7, { outcome: 'LOSS' }),
      count('prediction_logs', 'created_at', d7, { outcome: 'INCONCLUSIVE' }),
      count('prediction_logs', 'created_at', d7, { outcome: 'null' }),
      count('prediction_logs', 'created_at', d7, { outcome: 'null', resolved_at: 'null' }),
    ])

    // Signals / reconciliations / trades / worker liveness.
    const [sig24, sig7, recon7, reconPending, trades7] = await Promise.all([
      count('signals', 'created_at', h24, { direction: 'neq:HOLD' }),
      count('signals', 'created_at', d7, { direction: 'neq:HOLD' }),
      count('signal_reconciliation', 'created_at', d7),
      count('signal_reconciliation', 'created_at', d7, { outcome: 'PENDING' }),
      count('trades', 'opened_at', d7, { result: 'in:WIN,LOSS' }),
    ])

    const [setups7, alerts7] = await Promise.all([
      count('trade_setups', 'detected_at', d7),
      count('setup_alerts', 'created_at', d7),
    ])

    // Rejection breakdown (early gates + authority). Grab 7d rows and bucket.
    const { data: rej } = await admin
      .from('filter_rejections')
      .select('filter_name, filter_stage, created_at')
      .gte('created_at', d7)
      .order('created_at', { ascending: false })
      .limit(6000)
    const rej7 = new Map<string, number>()
    const rej24 = new Map<string, number>()
    for (const r of rej || []) {
      rej7.set(r.filter_name, (rej7.get(r.filter_name) ?? 0) + 1)
      if ((r.created_at || '') >= h24) rej24.set(r.filter_name, (rej24.get(r.filter_name) ?? 0) + 1)
    }
    const bucket = (m: Map<string, number>) =>
      Array.from(m.entries()).map(([filter, n]) => ({ filter, n })).sort((a, b) => b.n - a.n)

    // Worker heartbeat freshness.
    const { data: lastLog } = await admin
      .from('worker_logs').select('created_at').order('created_at', { ascending: false }).limit(1)
    const lastSeen = lastLog?.[0]?.created_at ?? null

    return NextResponse.json({
      generatedAt: new Date().toISOString(),
      predictionLogs: {
        last7d: pl7, last30d: pl30,
        resolved: { win: plWin, loss: plLoss, inconclusive: plInc },
        resolvedTotal: plWin + plLoss + plInc,
        unresolved: plUnresolved,
        unresolvedStaleOlder30m: plStale,
      },
      signals: { last24h: sig24, last7d: sig7 },
      reconciliations: { last7d: recon7, pending: reconPending },
      trades: { closed7d: trades7 },
      setups: { tradeSetups7d: setups7, alerts7d: alerts7 },
      rejections: { last24h: bucket(rej24), last7d: bucket(rej7) },
      worker: { alive: !!lastSeen, lastSeenAt: lastSeen },
      status: plWin + plLoss + plInc >= 20 ? '🟢 DATA PIPELINE HEALTHY' : '🟡 COLLECTING RESOLVED OUTCOMES',
    })
  } catch (e: any) {
    console.error('[data-health]', e?.message)
    return NextResponse.json({ error: e?.message || 'data-health failed' }, { status: 500 })
  }
}
