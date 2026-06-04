// app/api/broker/profit-target/route.ts
// Syncs profit target to broker_configs. Stores three fields:
//   profitTargetUsd  — precomputed close threshold (fixedUsd × pct / 100)
//   profitFixedUsd   — base dollar target
//   profitTargetPct  — percentage applied to the base
// EA reads all three from PULL and computes the formula itself for transparency.
export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { getAdminClient } from '@/lib/supabase'
import { getBroker } from '@/lib/brokers'

export async function POST(req: NextRequest) {
  try {
    const { value, fixedUsd, targetPct } = await req.json()
    if (typeof value !== 'number' || value < 0) {
      return NextResponse.json({ error: 'value must be a non-negative number' }, { status: 400 })
    }

    const token = req.headers.get('Authorization')?.replace('Bearer ', '') || undefined
    const broker = await getBroker(token)

    // Read the webhook token from the broker config to call set_profit_target RPC
    const sb = getAdminClient()
    const parts = token?.split('.') ?? []
    if (parts.length < 3) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString())
    const userId = payload?.sub
    if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const { data: row } = await sb
      .from('broker_configs')
      .select('id, config')
      .eq('user_id', userId)
      .in('broker_type', ['mt5direct', 'exness'])
      .single()

    if (!row) return NextResponse.json({ error: 'No MT5 broker config found' }, { status: 404 })

    const webhookToken = row.config?.webhookToken
    if (!webhookToken) return NextResponse.json({ error: 'No webhook token in config' }, { status: 400 })

    const { error } = await sb.rpc('set_profit_target', {
      p_token:      webhookToken,
      p_value:      value,
      p_fixed_usd:  typeof fixedUsd  === 'number' ? fixedUsd  : null,
      p_target_pct: typeof targetPct === 'number' ? targetPct : null,
    })

    if (error) throw new Error(error.message)

    return NextResponse.json({ ok: true, profitTargetUsd: value })
  } catch (e: any) {
    console.error('[broker/profit-target]', e)
    return NextResponse.json({ error: e.message }, { status: 500 })
  }
}
