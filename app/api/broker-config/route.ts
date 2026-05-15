// app/api/broker-config/route.ts — CRUD for per-user broker configurations
import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

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

  // If setting active, deactivate all others first
  if (is_active) {
    await sb.from('broker_configs').update({ is_active: false }).eq('user_id', user.id)
  }

  if (id) {
    // Update existing — only update config if new values provided (don't overwrite masked)
    const updatePayload: any = { label, is_active, updated_at: new Date().toISOString() }
    if (config && !hasOnlyMasked(config)) updatePayload.config = config
    const { data, error } = await sb.from('broker_configs').update(updatePayload).eq('id', id).select().single()
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ config: data })
  }

  // Insert new
  const { data, error } = await sb.from('broker_configs').insert({
    user_id: user.id, broker_type, label, config: config || {}, is_active: is_active ?? false,
  }).select().single()
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
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
