// app/api/debug-broker/route.ts — temporary diagnostic endpoint
import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

export async function GET(req: NextRequest) {
  const token = req.headers.get('Authorization')?.replace('Bearer ', '') || ''

  if (!token) {
    return NextResponse.json({ error: 'No auth token — are you logged in?' })
  }

  const sb = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { global: { headers: { Authorization: `Bearer ${token}` } }, auth: { autoRefreshToken: false, persistSession: false } }
  )

  const { data: user } = await sb.auth.getUser()
  const { data: configs, error } = await sb.from('broker_configs').select('id, broker_type, label, is_active, config').order('created_at')

  const safeConfigs = (configs || []).map((c: any) => ({
    id: c.id,
    broker_type: c.broker_type,
    label: c.label,
    is_active: c.is_active,
    config_keys: Object.keys(c.config || {}),
    has_token: !!(c.config?.token),
    has_account_id: !!(c.config?.accountId),
    has_webhook_token: !!(c.config?.webhookToken),
    balance_in_config: c.config?.balance,
  }))

  // Try fetching account
  let accountResult: any = null
  try {
    const { getBroker } = await import('@/lib/brokers')
    const broker = await getBroker(token)
    const summary = await broker.getAccountSummary()
    accountResult = { broker: broker.name, ...summary }
  } catch (e: any) {
    accountResult = { error: e.message }
  }

  return NextResponse.json({
    user_id: user?.user?.id,
    user_email: user?.user?.email,
    broker_configs: safeConfigs,
    db_error: error?.message,
    account_fetch: accountResult,
  })
}
