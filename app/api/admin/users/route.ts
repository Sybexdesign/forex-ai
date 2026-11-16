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
  //
  // Phase 4.2.1 (P-H): an admin total is a number somebody will act on, so it
  // may not silently absorb unknowns. `t.pl_usd || 0` both hid how many rows
  // were unaccounted and let them inflate the *count* of trades used for the
  // per-user win rate. Each user now carries `unknownPL` (rows with no number)
  // and `knownPL` (the sum of the rest), and the endpoint reports the totals so
  // a reader can see the denominator instead of trusting a single figure.
  const userStats: Record<string, any> = {}
  for (const t of trades || []) {
    if (!userStats[t.user_id]) userStats[t.user_id] = { trades: 0, wins: 0, totalPL: 0, knownPL: 0, unknownPL: 0 }
    const s = userStats[t.user_id]
    s.trades++
    if (t.result === 'WIN') s.wins++
    if (typeof t.pl_usd === 'number' && Number.isFinite(t.pl_usd)) {
      s.knownPL += t.pl_usd
      s.totalPL += t.pl_usd
    } else {
      s.unknownPL++
    }
  }

  const profileMap: Record<string, any> = {}
  for (const p of profiles || []) profileMap[p.id] = p

  const result = (users || []).map(u => {
    const s = userStats[u.id] || { trades: 0, wins: 0, totalPL: 0, knownPL: 0, unknownPL: 0 }
    const knownTrades = s.trades - s.unknownPL
    return {
      id: u.id,
      email: u.email,
      fullName: profileMap[u.id]?.full_name || '',
      createdAt: u.created_at,
      lastSignIn: u.last_sign_in_at,
      confirmed: !!u.email_confirmed_at,
      trades: s.trades,
      wins: s.wins,
      // `totalPL` is kept for existing callers but is now explicitly the KNOWN
      // subtotal — the companion `unknownPL` counter says how much is missing.
      totalPL: +s.knownPL.toFixed(2),
      knownPL: +s.knownPL.toFixed(2),
      unknownPL: s.unknownPL,
      knownTrades,
      // win rate is over rows whose outcome is recorded, so an unaccounted row
      // cannot flatter the percentage
      winRate: knownTrades > 0 ? Math.round((s.wins / knownTrades) * 100) : 0,
    }
  })

  const totals = result.reduce(
    (acc, u) => ({
      users: acc.users + 1,
      trades: acc.trades + u.trades,
      knownPL: +(acc.knownPL + u.knownPL).toFixed(2),
      unknownPL: acc.unknownPL + u.unknownPL,
    }),
    { users: 0, trades: 0, knownPL: 0, unknownPL: 0 },
  )

  return NextResponse.json({ users: result, totals })
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
