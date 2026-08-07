// app/api/admin/cache/route.ts — Admin-only: clear server-side caches
// Clears all in-memory caches that could cause stale data, stalled signals,
// or incorrect trading decisions. Admin-only (sybexdesigns@gmail.com).
import { NextRequest, NextResponse } from 'next/server'
import { getAdminClient } from '@/lib/supabase'
import { clearAllServerCaches } from '@/lib/cache'

const ADMIN_EMAIL = 'sybexdesigns@gmail.com'

async function verifyAdmin(req: NextRequest) {
  const token = req.headers.get('Authorization')?.replace('Bearer ', '') ?? ''
  if (!token) return null
  const { data: { user } } = await getAdminClient().auth.getUser(token)
  if (user?.email !== ADMIN_EMAIL) return null
  return user
}

export async function POST(req: NextRequest) {
  const admin = await verifyAdmin(req)
  if (!admin) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  try {
    const { cleared, errors } = await clearAllServerCaches()

    // Also revalidate Next.js route cache for key API routes
    const { revalidatePath } = await import('next/cache')
    try {
      revalidatePath('/api/account')
      revalidatePath('/api/oanda/prices')
      revalidatePath('/api/scalper/tick')
      revalidatePath('/api/scan')
      revalidatePath('/api/news')
      cleared.push('nextjs-route-cache')
    } catch { /* revalidate is best-effort */ }

    // Signal the background worker to reset its in-memory caches
    try {
      const sb = getAdminClient()
      const { error: resetErr } = await sb.from('worker_cache_resets').insert({
        requested_at: new Date().toISOString(),
        consumed: false,
      })
      if (!resetErr) cleared.push('worker-in-memory')
      else errors.push(`worker-in-memory: ${resetErr.message}`)
    } catch (e: any) {
      errors.push(`worker-in-memory: ${e?.message}`)
    }

    return NextResponse.json({
      success: true,
      cleared,
      errors,
      message: `Cleared ${cleared.length} cache layer(s)${errors.length ? ` (${errors.length} error(s))` : ''}`,
    })
  } catch (e: any) {
    console.error('[admin/cache]', e)
    return NextResponse.json({ error: e.message }, { status: 500 })
  }
}

// GET — return current cache status (what layers exist, whether they're active)
export async function GET(req: NextRequest) {
  const admin = await verifyAdmin(req)
  if (!admin) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  return NextResponse.json({
    layers: [
      { id: 'broker-singleton', name: 'Broker Singleton', description: 'Cached default broker instance. Reset forces re-instantiation from env vars.' },
      { id: 'capital-session', name: 'Capital.com Session', description: 'Cached session token + CST. Reset forces re-authentication.' },
      { id: 'capital-epic-cache', name: 'Capital.com Epic Cache', description: 'Cached market epic IDs + scale factors (1h TTL). Reset forces re-discovery.' },
      { id: 'capital-circuit-breaker', name: 'Capital.com Circuit Breaker', description: '5-min cooldown after network failure. Reset forces immediate retry.' },
      { id: 'nextjs-route-cache', name: 'Next.js Route Cache', description: 'Server-side route cache for API endpoints.' },
      { id: 'client-localstorage', name: 'Client localStorage', description: 'Browser-side strategy + account size cache.' },
      { id: 'worker-in-memory', name: 'Worker In-Memory', description: 'Scalper worker risk cache, HTF cache, cooldowns, pending signals.' },
    ],
  })
}
