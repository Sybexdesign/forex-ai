// app/api/data-health/route.ts
// Data Health + early-gate bottleneck counters (audit 2026-09-03).
// One endpoint answering "is the pipeline producing and resolving enough
// data, and where are opportunities being lost?" — counts straight from the
// production database, no frontend involved.
export const dynamic = 'force-dynamic'

import { NextResponse } from 'next/server'
import { getAdminClient } from '@/lib/supabase'
import { classifyAutoTradeHealth } from '@/lib/auto-trade-health.mjs'

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

export async function GET(request: Request) {
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

    // ── Phase 4 — execution data health (graceful: falls back when the Phase 4
    // columns are not yet applied). Lifecycle and profitability are counted
    // separately from prediction health. ────────────────────────────────────
    let executionHealth: any = { available: false }
    try {
      const t = (b: any) => b.select('id', { count: 'exact', head: true })
      const [{ count: total7 }, { count: open7 }, { count: closed7 }, { count: closedNoPnl }, { count: noTicket }, { count: noSignal }] = await Promise.all([
        t(admin.from('trades')).gte('opened_at', d7),
        t(admin.from('trades')).gte('opened_at', d7).eq('trade_status', 'OPEN'),
        t(admin.from('trades')).gte('opened_at', d7).eq('trade_status', 'CLOSED'),
        t(admin.from('trades')).gte('opened_at', d7).eq('trade_status', 'CLOSED').is('pl_usd', null),
        t(admin.from('trades')).gte('opened_at', d7).is('broker_ticket', null),
        t(admin.from('trades')).gte('opened_at', d7).is('signal_id_ref', null),
      ])
      executionHealth = {
        available: true, total7d: total7 ?? 0, open: open7 ?? 0, closed: closed7 ?? 0,
        closedMissingNetPnl: closedNoPnl ?? 0, missingBrokerTicket: noTicket ?? 0,
        missingSignalLink: noSignal ?? 0,
      }
    } catch { /* Phase 4 columns not applied yet — execution health unavailable */ }

    // ── Auto Trade / Signal health (account-scoped classifier) ───────────────
    let autoTradeHealth: any = { available: true }
    try {
      // Optional explicit account/config identifier. When absent the classifier
      // targets the newest ACTIVE account — but sibling accounts are always
      // listed so one healthy account can never mask a stale one.
      const url = new URL(request?.url ?? 'http://local')
      const configId = url.searchParams.get('configId')?.trim() || null

      const logsResp = await admin.from('worker_logs')
        .select('level,message,metadata,created_at')
        .order('created_at', { ascending: false })
        .limit(300)
      const rows = logsResp.data || []

      // Account rows (ids passed to the classifier for internal selection only —
      // the classifier never emits raw ids; only anonymised acct-<n> labels).
      const cfgRes = await admin.from('broker_configs')
        .select('id,is_active,updated_at')
        .order('updated_at', { ascending: false })
      const cfgRows = (cfgRes.data || []).map((c: any) => ({
        id: String(c.id),
        isActive: !!c.is_active,
        lastSyncMs: c.updated_at ? new Date(c.updated_at).getTime() : null,
      }))

      const nowMsH = Date.now()
      const lastSeenMs = lastSeen ? new Date(lastSeen).getTime() : null

      let lastSigCheckMs: number | null = null
      let lastSignalMs: number | null = null
      let lastOrderMs: number | null = null
      let lastActionableMs: number | null = null
      let lastHoldMs: number | null = null
      let marketOpen: boolean | null = null
      // Phase J — distinct observable counters. A routinely-old closed candle is
      // operational filtering (staleCandleSkip), NOT an order-level rejection.
      const gates = { staleCandleSkip: 0, staleSignalReject: 0, duplicateSignalReject: 0, entryDriftReject: 0 }
      for (const r of rows) {
        const m = r.metadata || {}
        if (lastSigCheckMs === null && (m.sigChecks || 0) > 0) lastSigCheckMs = new Date(r.created_at).getTime()
        if (marketOpen === null && m.market) marketOpen = String(m.market).includes('OPEN')
        const msg = String(r.message || '')
        const gateHit = String(m.gate || '')
        if (r.level === 'signal') {
          if (lastSignalMs === null) lastSignalMs = new Date(r.created_at).getTime()
          if (/HOLD/.test(msg) && lastHoldMs === null) lastHoldMs = new Date(r.created_at).getTime()
          if (!/HOLD/.test(msg) && lastActionableMs === null) lastActionableMs = new Date(r.created_at).getTime()
        }
        if (r.level === 'order' && lastOrderMs === null) lastOrderMs = new Date(r.created_at).getTime()
        if (/stale closed candle/i.test(msg)) gates.staleCandleSkip++
        else if (/stale_signal|signal expired/i.test(msg) || gateHit === 'stale_signal') gates.staleSignalReject++
        else if (/duplicate_signal|duplicate execution/i.test(msg) || gateHit === 'duplicate_signal') gates.duplicateSignalReject++
        else if (/entry_drift|beyond entry/i.test(msg) || gateHit === 'entry_drift') gates.entryDriftReject++
      }

      autoTradeHealth = classifyAutoTradeHealth({
        nowMs: nowMsH,
        configId,
        accounts: cfgRows,
        workerLastSeenMs: lastSeenMs,
        lastSigCheckMs,
        marketOpen,
        events: { lastSignalMs, lastActionableMs, lastHoldMs, lastOrderMs },
        gates,
      })
    } catch { autoTradeHealth = { available: false } }

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
      execution: executionHealth,
      autoTradeHealth,
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
