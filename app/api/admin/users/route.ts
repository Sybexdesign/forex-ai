// app/api/admin/users/route.ts — Admin-only: list users, stats, delete
import { NextRequest, NextResponse } from 'next/server'
import { getAdminClient } from '@/lib/supabase'

const ADMIN_EMAIL = 'sybexdesigns@gmail.com'

async function verifyAdmin(req: NextRequest) {
  const token = req.headers.get('Authorization')?.replace('Bearer ', '') ?? ''
  if (!token) return null
  const { data: { user } } = await getAdminClient().auth.getUser(token)
  if (user?.email !== ADMIN_EMAIL) return null
  return user
}

export async function GET(req: NextRequest) {
  const admin = await verifyAdmin(req)
  if (!admin) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const sb = getAdminClient()

  // Get all users from auth
  const { data: { users }, error: authErr } = await sb.auth.admin.listUsers()
  if (authErr) return NextResponse.json({ error: authErr.message }, { status: 500 })

  // Get per-user trade stats
  const { data: trades } = await sb
    .from('trades')
    .select('user_id, pl_usd, result, created_at')

  const { data: profiles } = await sb
    .from('profiles')
    .select('id, email, full_name, created_at')

  // Aggregate stats per user
  const userStats: Record<string, any> = {}
  for (const t of trades || []) {
    if (!userStats[t.user_id]) userStats[t.user_id] = { trades: 0, wins: 0, totalPL: 0 }
    userStats[t.user_id].trades++
    if (t.result === 'WIN') userStats[t.user_id].wins++
    userStats[t.user_id].totalPL += t.pl_usd || 0
  }

  const profileMap: Record<string, any> = {}
  for (const p of profiles || []) profileMap[p.id] = p

  const result = (users || []).map(u => ({
    id: u.id,
    email: u.email,
    fullName: profileMap[u.id]?.full_name || '',
    createdAt: u.created_at,
    lastSignIn: u.last_sign_in_at,
    confirmed: !!u.email_confirmed_at,
    trades: userStats[u.id]?.trades || 0,
    wins: userStats[u.id]?.wins || 0,
    totalPL: +(userStats[u.id]?.totalPL || 0).toFixed(2),
    winRate: userStats[u.id]?.trades
      ? Math.round((userStats[u.id].wins / userStats[u.id].trades) * 100)
      : 0,
  }))

  return NextResponse.json({ users: result })
}

export async function DELETE(req: NextRequest) {
  const admin = await verifyAdmin(req)
  if (!admin) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  const { userId } = await req.json()
  if (!userId) return NextResponse.json({ error: 'userId required' }, { status: 400 })

  const { error } = await getAdminClient().auth.admin.deleteUser(userId)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ success: true })
}
