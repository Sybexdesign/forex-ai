// app/api/worker/status/route.ts
// Reports the freshness of the background scalper worker: when it last booted,
// what broker it resolved to at startup, and how long ago the most recent
// sweep/heartbeat was. Used by the post-switch health check in BrokerPage to
// confirm the worker reconnected to the newly active account.

export const dynamic = 'force-dynamic'

import { NextResponse } from 'next/server'
import { getAdminClient } from '@/lib/supabase'

export async function GET() {
  try {
    const sb = getAdminClient()

    // Two-row lookup in parallel:
    //   - Most recent startup banner ('Worker started — mode: …')
    //   - Most recent heartbeat / sweep ping (anything from the worker)
    const [bootRes, lastRes, brokerRes] = await Promise.all([
      sb.from('worker_logs')
        .select('created_at, message, metadata')
        .ilike('message', 'Worker started%')
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle(),
      sb.from('worker_logs')
        .select('created_at')
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle(),
      sb.from('worker_logs')
        .select('created_at, message, metadata')
        .ilike('message', 'Broker resolved at startup%')
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle(),
    ])

    const lastStartupAt = bootRes.data?.created_at ?? null
    const lastSeenAt    = lastRes.data?.created_at ?? null
    const bootMeta      = bootRes.data?.metadata   as { mode?: string; pairs?: string[]; threshold?: number } | null
    const brokerMeta    = brokerRes.data?.metadata as { broker?: string; balance?: number; currency?: string } | null

    const now = Date.now()
    const ageSec = (iso: string | null) =>
      iso ? Math.round((now - new Date(iso).getTime()) / 1000) : null

    const lastSeenAgeS = ageSec(lastSeenAt)
    // Worker is considered "alive" if anything from it was logged in the last 5 min
    const isAlive = lastSeenAgeS !== null && lastSeenAgeS < 300

    return NextResponse.json({
      isAlive,
      lastStartupAt,
      lastStartupAgeS:  ageSec(lastStartupAt),
      lastSeenAt,
      lastSeenAgeS,
      // Worker mode comes from the boot banner metadata.mode field. Either
      // 'paper' or 'live'. Used by the UI to show whether auto_trade_enabled=true
      // will actually result in real orders or just decision logs.
      mode:             (bootMeta?.mode || '').toLowerCase() || null,
      broker:           brokerMeta?.broker   ?? null,
      balance:          brokerMeta?.balance  ?? null,
      currency:         brokerMeta?.currency ?? null,
    })
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || 'worker-status failed' }, { status: 500 })
  }
}
