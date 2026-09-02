// app/api/strategy-health/route.ts
// Strategy health snapshots.
//   GET ?window=1d|7d|30d&userId=&refresh=1
export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { getStrategyHealth } from '@/lib/strategy-health'

export async function GET(req: NextRequest) {
  try {
    const window = (req.nextUrl.searchParams.get('window') || '30d') as '1d' | '7d' | '30d'
    if (!['1d', '7d', '30d'].includes(window)) {
      return NextResponse.json({ error: 'window must be 1d, 7d or 30d' }, { status: 400 })
    }
    const userId = req.nextUrl.searchParams.get('userId') || null
    const refresh = req.nextUrl.searchParams.get('refresh') === '1'
    const health = await getStrategyHealth(window, userId, { refresh })
    return NextResponse.json(health)
  } catch (e: any) {
    console.error('[strategy-health GET]', e?.message)
    return NextResponse.json({ error: e?.message || 'strategy-health failed' }, { status: 500 })
  }
}
