// app/api/worker/cache-reset/route.ts
// Admin-triggered worker cache reset signal.
//
// The scalper worker runs as a separate process with its own in-memory caches
// (risk cache, HTF cache, cooldowns, pending signals, stale price tracking).
// When the admin clears caches from the Admin page, this endpoint stores a
// "reset requested" flag in Supabase. The worker polls this endpoint every
// sweep and resets its in-memory state when the flag is set.
//
// POST (admin-only):  Set the reset flag
// GET  (worker):      Check + consume the reset flag

export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { getAdminClient } from '@/lib/supabase'

const ADMIN_EMAIL = 'sybexdesigns@gmail.com'
const TABLE = 'worker_cache_resets'

async function verifyAdmin(req: NextRequest) {
  const token = req.headers.get('Authorization')?.replace('Bearer ', '') ?? ''
  if (!token) return null
  const { data: { user } } = await getAdminClient().auth.getUser(token)
  if (user?.email !== ADMIN_EMAIL) return null
  return user
}

// POST — admin triggers a worker cache reset
export async function POST(req: NextRequest) {
  const admin = await verifyAdmin(req)
  if (!admin) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  try {
    const sb = getAdminClient()
    const { error } = await sb.from(TABLE).insert({
      requested_at: new Date().toISOString(),
      consumed: false,
    })
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ success: true, message: 'Worker cache reset requested' })
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 })
  }
}

// GET — worker polls this to check for a pending reset
export async function GET() {
  try {
    const sb = getAdminClient()
    const { data, error } = await sb
      .from(TABLE)
      .select('id, requested_at')
      .eq('consumed', false)
      .order('requested_at', { ascending: false })
      .limit(1)
      .maybeSingle()

    if (error) return NextResponse.json({ error: error.message }, { status: 500 })

    if (data) {
      // Mark as consumed so the worker only resets once per request
      await sb.from(TABLE).update({ consumed: true }).eq('id', data.id)
      return NextResponse.json({ reset: true, requestedAt: data.requested_at })
    }

    return NextResponse.json({ reset: false })
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 })
  }
}
