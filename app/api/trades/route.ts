// app/api/trades/route.ts
export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { getAdminClient } from '@/lib/supabase'
import { describeWindow, parseLimit } from '@/lib/api-query.mjs'

/**
 * Phase 4.2.1 (M-4 / A-5, phase 1).
 *
 * Two corrections to the read path:
 *
 *  - **Bounded, reported window.** The old `.limit(200)` dropped the oldest rows
 *    silently, so any client-side ratio was computed over an unknowable slice.
 *    The window is now an explicit, clamped `?limit=` (default 1000, cap 5000)
 *    and the response carries `truncated`/`rows` so a caller can tell "this is
 *    everything" from "this is the newest N".
 *
 *  - **Opportunistic authorisation.** The endpoint is still addressable without
 *    a token, because two shipped callers (`hooks/useForex.ts`,
 *    `AutoTradePage.tsx`) fetch without an `Authorization` header and enforcing a
 *    session today would break them. What changes: when a Bearer token IS
 *    supplied it must resolve to the requested `userId`, otherwise 403. A
 *    malformed or expired token fails closed rather than being ignored. A caller
 *    cannot use a token to widen scope either — the query is always scoped to the
 *    verified id.
 *
 * Mandatory authentication (and converting those two callers to `authFetch`) is
 * an owner decision, recorded in PHASE42_1_OWNER_ACTIONS.md — it changes who can
 * read what, which is a product decision, not a defect fix.
 */
async function resolveBearerUser(req: NextRequest) {
  const header = req.headers.get('Authorization') ?? ''
  if (!header.trim()) return { supplied: false as const, userId: null as string | null }
  const token = header.replace(/^Bearer\s+/i, '').trim()
  if (!token) return { supplied: true as const, userId: null }
  try {
    const { data, error } = await getAdminClient().auth.getUser(token)
    if (error || !data?.user?.id) return { supplied: true as const, userId: null }
    return { supplied: true as const, userId: data.user.id }
  } catch {
    return { supplied: true as const, userId: null }
  }
}

export async function GET(req: NextRequest) {
  const userId = req.nextUrl.searchParams.get('userId')
  const result = req.nextUrl.searchParams.get('result') // optional: 'OPEN', 'WIN', 'LOSS', 'CLOSED'
  const rawLimit = req.nextUrl.searchParams.get('limit')
  const requested = rawLimit === null ? null : Number(rawLimit)
  const limit = parseLimit(rawLimit)

  if (!userId || userId === 'demo') {
    return NextResponse.json({ trades: [], ...describeWindow({ limit, rows: 0, requested }) })
  }

  // A supplied token must match the requested user. No token → unchanged
  // behaviour (phase 1); a token that does not verify → refuse.
  const auth = await resolveBearerUser(req)
  if (auth.supplied && auth.userId !== userId) {
    return NextResponse.json(
      { error: 'Forbidden — token does not match requested userId', trades: [] },
      { status: 403 },
    )
  }

  try {
    const admin = getAdminClient()
    let query = admin
      .from('trades')
      .select('*')
      .eq('user_id', userId)
      .order('opened_at', { ascending: false })
      // Read one extra row purely to detect that the window was cut short.
      .limit(limit + 1)

    if (result) query = query.eq('result', result)

    const { data, error } = await query
    if (error) throw error

    const rows = data || []
    const window = describeWindow({ limit, rows: rows.length, requested })
    const page = rows.length > limit ? rows.slice(0, limit) : rows
    return NextResponse.json({
      trades: page,
      ...window,
      truncated: rows.length > limit || window.truncated,
      limit,
      rows: page.length,
    })
  } catch (error: any) {
    console.error('[trades GET]', error.message)
    return NextResponse.json({ trades: [], ...describeWindow({ limit, rows: 0, requested }) })
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const admin = getAdminClient()
    const { data, error } = await admin.from('trades').insert(body).select().single()
    if (error) throw error
    return NextResponse.json({ trade: data })
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}

export async function PATCH(req: NextRequest) {
  try {
    const body = await req.json()
    const { id, ...updates } = body
    const admin = getAdminClient()
    const { data, error } = await admin.from('trades').update(updates).eq('id', id).select().single()
    if (error) throw error
    return NextResponse.json({ trade: data })
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}
