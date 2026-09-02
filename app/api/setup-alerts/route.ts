// app/api/setup-alerts/route.ts
// Qualified-setup alerts + setup lifecycle API for the Auto Trade page.
//   GET ?userId=&limit=50 → { alerts: setup_alerts, setups: trade_setups }
// Realtime channel 'setup_alerts' pushes new rows live (publication added in
// the 20260902 migration) so the page updates without polling.
export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { getAdminClient } from '@/lib/supabase'

export async function GET(req: NextRequest) {
  try {
    const userId = req.nextUrl.searchParams.get('userId') || null
    const limit = Math.min(200, Math.max(1, parseInt(req.nextUrl.searchParams.get('limit') || '50', 10)))
    const admin = getAdminClient()

    // Query a scope: user's own rows, or global rows when no user is supplied.
    // trade_setups timestamps use detected_at (no created_at column).
    const query = (t: string, uid: string | null) => {
      const orderCol = t === 'trade_setups' ? 'detected_at' : 'created_at'
      let q = admin.from(t).select('*').order(orderCol, { ascending: false }).limit(limit)
      return uid ? q.eq('user_id', uid) : q.is('user_id', null)
    }
    const mergeUnique = (a: any[], b: any[]) => {
      const seen = new Set<string>()
      return [...(a ?? []), ...(b ?? [])].filter((r: any) => {
        if (seen.has(r.id)) return false
        seen.add(r.id)
        return true
      }).slice(0, limit)
    }

    if (userId) {
      const [ownA, ownS, gA, gS] = await Promise.all([
        query('setup_alerts', userId), query('trade_setups', userId),
        query('setup_alerts', null), query('trade_setups', null),
      ])
      return NextResponse.json({
        userId,
        alerts: mergeUnique(ownA.data ?? [], gA.data ?? []),
        setups: mergeUnique(ownS.data ?? [], gS.data ?? []),
        errors: [ownA.error?.message, ownS.error?.message, gA.error?.message, gS.error?.message].filter(Boolean),
      })
    }

    const [alertsRes, setupsRes] = await Promise.all([
      query('setup_alerts', null),
      query('trade_setups', null),
    ])
    return NextResponse.json({
      userId: null,
      alerts: alertsRes.data ?? [],
      setups: setupsRes.data ?? [],
      errors: [alertsRes.error?.message, setupsRes.error?.message].filter(Boolean),
    })
  } catch (e: any) {
    console.error('[setup-alerts GET]', e?.message)
    return NextResponse.json({ error: e?.message || 'setup-alerts failed' }, { status: 500 })
  }
}
