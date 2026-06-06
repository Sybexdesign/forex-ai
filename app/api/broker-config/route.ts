// app/api/broker-config/route.ts — CRUD for per-user broker configurations
import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { resetBroker } from '@/lib/brokers'
import { getAdminClient } from '@/lib/supabase'

function userClient(token: string) {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { global: { headers: { Authorization: `Bearer ${token}` } }, auth: { autoRefreshToken: false, persistSession: false } }
  )
}

function getToken(req: NextRequest) {
  return req.headers.get('Authorization')?.replace('Bearer ', '') ?? ''
}

// GET — list user's broker configs
export async function GET(req: NextRequest) {
  const token = getToken(req)
  if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const sb = userClient(token)
  const { data, error } = await sb.from('broker_configs').select('*').order('created_at')
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  // Mask secrets in response
  const masked = (data || []).map(row => ({
    ...row,
    config: maskSecrets(row.config, row.broker_type),
  }))
  return NextResponse.json({ configs: masked })
}

// POST — create or update broker config
export async function POST(req: NextRequest) {
  const token = getToken(req)
  if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const body = await req.json()
  const { id, broker_type, label, config, is_active } = body

  const sb = userClient(token)
  const { data: { user } } = await sb.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  // Account-switch safety: when activating a NEW row (or any change to is_active=true),
  // block if the user has any OPEN trades. Switching with open positions risks
  // orphaning them against the wrong broker_configs balance/credentials.
  // (trades.status doesn't exist — the open-state column is `result`.)
  if (is_active) {
    const admin = getAdminClient()
    const { count: openCount } = await admin
      .from('trades')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', user.id)
      .eq('result', 'OPEN')
    if (typeof openCount === 'number' && openCount > 0) {
      return NextResponse.json({
        error: `Cannot switch accounts — ${openCount} open position${openCount === 1 ? '' : 's'} exist. Close all trades first.`,
        code: 'OPEN_POSITIONS_EXIST',
        openCount,
      }, { status: 409 })
    }
  }

  // If setting active, deactivate all others first
  if (is_active) {
    await sb.from('broker_configs').update({ is_active: false }).eq('user_id', user.id)
  }

  // Common timestamp for the activation stamp so worker + UI see the same value.
  const switchedAt = new Date().toISOString()

  if (id) {
    // Update existing — only update config if new values provided (don't overwrite masked)
    const updatePayload: any = { label, is_active, updated_at: switchedAt }
    if (config && !hasOnlyMasked(config)) updatePayload.config = config
    // Stamp last_switched_at only on the row being activated; deactivations are not
    // worth signalling, and re-saving an already-active row without flipping the
    // flag shouldn't reset the worker.
    if (is_active === true) updatePayload.last_switched_at = switchedAt
    const { data, error } = await sb.from('broker_configs').update(updatePayload).eq('id', id).select().single()
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    // Drop the env-default broker singleton on any active-flag change so subsequent
    // tokenless requests rebuild fresh and never serve the old account's cached
    // adapter instance. (The JWT path already rebuilds per request.)
    if (is_active !== undefined) resetBroker()
    return NextResponse.json({ config: data })
  }

  // Insert new
  const insertPayload: any = {
    user_id: user.id, broker_type, label, config: config || {}, is_active: is_active ?? false,
  }
  if (is_active === true) insertPayload.last_switched_at = switchedAt
  const { data, error } = await sb.from('broker_configs').insert(insertPayload).select().single()
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  if (is_active) resetBroker()
  return NextResponse.json({ config: data })
}

// PATCH — clear pending orders queue for an MT5/Exness config
export async function PATCH(req: NextRequest) {
  const token = getToken(req)
  if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const { id } = await req.json()
  const sb = userClient(token)
  const { data: row, error: fetchErr } = await sb.from('broker_configs').select('config').eq('id', id).single()
  if (fetchErr) return NextResponse.json({ error: fetchErr.message }, { status: 500 })
  const { error } = await sb.from('broker_configs')
    .update({ config: { ...row.config, pendingOrders: [] }, updated_at: new Date().toISOString() })
    .eq('id', id)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ success: true })
}

// DELETE — remove a broker config
export async function DELETE(req: NextRequest) {
  const token = getToken(req)
  if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const { id } = await req.json()
  const sb = userClient(token)
  const { error } = await sb.from('broker_configs').delete().eq('id', id)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ success: true })
}

function maskSecrets(config: Record<string, string>, brokerType: string): Record<string, string> {
  const secretFields = ['password', 'secretKey', 'token']
  const result = { ...config }
  for (const f of secretFields) {
    if (result[f]) result[f] = '••••••••'
  }
  return result
}

function hasOnlyMasked(config: Record<string, string>): boolean {
  return Object.values(config).every(v => v === '••••••••' || v === '')
}
