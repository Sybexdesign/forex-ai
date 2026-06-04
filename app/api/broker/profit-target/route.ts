// app/api/broker/profit-target/route.ts
// Syncs the user's fixed profit target (USD) to broker_configs.config.profitTargetUsd.
// The EA reads this on every PULL (every 2s) and enforces it locally in MT5 — no browser needed.
export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { getAdminClient } from '@/lib/supabase'
import { getBroker } from '@/lib/brokers'

export async function POST(req: NextRequest) {
  try {
    const { value } = await req.json()
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
      p_token: webhookToken,
      p_value: value,
    })

    if (error) throw new Error(error.message)

    return NextResponse.json({ ok: true, profitTargetUsd: value })
  } catch (e: any) {
    console.error('[broker/profit-target]', e)
    return NextResponse.json({ error: e.message }, { status: 500 })
  }
}
