// app/api/profit-protection/telemetry/route.ts
// Query/report path for the durable profit-protection shadow telemetry
// (profit_protection_telemetry). Returns:
//   • per-trade chronological lifecycle rows
//   • per-trade ACTUAL vs COUNTERFACTUAL/ESTIMATED close summaries
//   • sample-wide aggregate report (zones, round-trips, capture, strong runners)
// Read-only. Observability only — no trading impact.
export const dynamic = 'force-dynamic'

import { NextResponse } from 'next/server'
import { getAdminClient } from '@/lib/supabase'
import { closeSummaryFromRows, aggregateTrades } from '@/lib/profit-telemetry.mjs'

export async function GET(request: Request) {
  try {
    const url = new URL(request.url)
    const days = Math.max(1, Math.min(90, parseInt(url.searchParams.get('days') || '14', 10)))
    const ticketFilter = url.searchParams.get('ticket')?.trim() || null
    const admin = getAdminClient()
    const since = new Date(Date.now() - days * 24 * 3600_000).toISOString()

    let q = admin.from('profit_protection_telemetry')
      .select('*')
      .gte('created_at', since)
      .order('created_at', { ascending: true })
      .limit(10_000)
    if (ticketFilter) q = q.eq('broker_ticket', ticketFilter)
    const { data } = await q
    const rows: any[] = data || []

    // Group chronological lifecycles by broker ticket.
    const groups = new Map<string, any[]>()
    for (const r of rows) {
      const key = r.broker_ticket != null ? String(r.broker_ticket) : `row:${r.id}`
      if (!groups.has(key)) groups.set(key, [])
      groups.get(key)!.push(r)
    }

    // Overlay broker-realised ACTUAL values from trades where available.
    const tickets = Array.from(groups.keys()).filter((k) => !k.startsWith('row:'))
    const overrides = new Map<string, { actualRealisedPnlUsd: number | null; actualMfeUsd: number | null }>()
    for (let i = 0; i < tickets.length; i += 50) {
      const batch = tickets.slice(i, i + 50)
      const tr = await admin.from('trades')
        .select('broker_ticket,pl_usd,mfe_usd')
        .in('broker_ticket', batch)
        .limit(50)
      for (const t of (tr.data || [])) {
        const k = String(t.broker_ticket)
        const prev = overrides.get(k)
        const pl = t.pl_usd != null ? Number(t.pl_usd) : prev?.actualRealisedPnlUsd ?? null
        const mfe = t.mfe_usd != null ? Number(t.mfe_usd) : prev?.actualMfeUsd ?? null
        overrides.set(k, { actualRealisedPnlUsd: pl, actualMfeUsd: mfe })
      }
    }

    const perTrade: any[] = []
    const closed: any[] = []
    for (const [key, groupRows] of groups) {
      const hasClose = groupRows.some((r) => r.row_kind === 'close')
      const summary = closeSummaryFromRows(groupRows, overrides.get(key) || {})
      summary.lifecycleRowCount = groupRows.length
      summary.open = !hasClose
      perTrade.push(summary)
      if (hasClose) closed.push(summary)
    }
    perTrade.sort((a, b) => String(a.brokerTicket || '').localeCompare(String(b.brokerTicket || '')))

    const shadowCommandEmitted = rows.filter((r) => r.shadow_command_emitted === true && r.protection_mode === 'shadow').length
    return NextResponse.json({
      generatedAt: new Date().toISOString(),
      scope: { days, ticketFilter },
      shadowSafety: {
        telemetryRowCount: rows.length,
        shadowRows: rows.filter((r) => r.protection_mode === 'shadow').length,
        shadowCommandEmitted, // CRITICAL if > 0 while mode=shadow
      },
      perTrade,
      aggregate: aggregateTrades(closed),
      caveats: [
        'ACTUAL values are broker-realised where trades.pl_usd/mfe_usd exist; otherwise they are the close decision-time profit/peak (source flagged per trade).',
        'All estShadow* values are COUNTERFACTUAL / ESTIMATED — never broker-realised.',
      ],
    })
  } catch (e: any) {
    console.error('[profit-protection/telemetry]', e?.message)
    return NextResponse.json({ error: e?.message || 'telemetry query failed' }, { status: 500 })
  }
}
