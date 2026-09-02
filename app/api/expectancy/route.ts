// app/api/expectancy/route.ts
// Expectancy Engine API.
//
//   GET  ?userId=&window=&refresh=1
//        Segmented expectancy snapshot (in-memory, cached; `refresh=1` also
//        materialises the expectancy_statistics table).
//   POST { ...SetupEvaluationInput }   → shadow evaluation of one setup
//        Returns { expectancy, safety, authority, setupOutcome } and records
//        the full decision snapshot. NEVER affects execution.
export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { fetchExpectancyData, refreshExpectancyStatistics, expectancyConfig } from '@/lib/expectancy-engine'
import { evaluateSetup } from '@/lib/setup-evaluator'

export async function GET(req: NextRequest) {
  try {
    const userId = req.nextUrl.searchParams.get('userId') || undefined
    const refresh = req.nextUrl.searchParams.get('refresh') === '1'
    const windowDays = parseInt(req.nextUrl.searchParams.get('window') || '60', 10)

    const entry = refresh
      ? await refreshExpectancyStatistics({ userId, days: windowDays })
      : await fetchExpectancyData({ userId, days: windowDays })

    const pool = userId && entry.data.byUserSamples.length > 0
      ? entry.data.byUserSamples
      : entry.data.samples

    return NextResponse.json({
      userId: userId ?? null,
      windowDays,
      config: expectancyConfig(),
      n: pool.length,
      nClosedTrades: pool.filter(s => typeof s.usd === 'number').length,
      nPredictions: pool.filter(s => s.usd === undefined).length,
      segments: entry.segments.map(s => ({ key: s.key, segment: s.segment, metrics: s.metrics })),
    })
  } catch (e: any) {
    console.error('[expectancy GET]', e?.message)
    return NextResponse.json({ error: e?.message || 'expectancy failed' }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    if (!body?.pair || !body?.direction) {
      return NextResponse.json({ error: 'pair and direction required' }, { status: 400 })
    }
    const result = await evaluateSetup(body)
    return NextResponse.json(result)
  } catch (e: any) {
    console.error('[expectancy POST]', e?.message)
    return NextResponse.json({ error: e?.message || 'evaluation failed' }, { status: 500 })
  }
}

