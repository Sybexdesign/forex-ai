// app/api/counterfactual/route.ts
// Counterfactual replay — "what would have happened if we took THIS plan when
// the market looked like THIS before?"
//   POST { pair, direction, entry, sl, tp, indicators?, topK?, userId? }
export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { runCounterfactualReplay } from '@/lib/counterfactual'

export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const { pair, direction, entry, sl, tp, indicators, topK, userId } = body as {
      pair: string
      direction: 'BUY' | 'SELL'
      entry: number
      sl: number
      tp: number
      indicators?: Record<string, unknown>
      topK?: number
      userId?: string | null
    }
    if (!pair || !['BUY', 'SELL'].includes(direction) || ![entry, sl, tp].every(Number.isFinite)) {
      return NextResponse.json({ error: 'pair, direction (BUY|SELL) and finite entry/sl/tp required' }, { status: 400 })
    }
    const result = await runCounterfactualReplay({ pair, direction, entry, sl, tp, indicators, topK, userId })
    if (!result) return NextResponse.json({ error: 'unable to replay (invalid stop/target distances)' }, { status: 400 })
    return NextResponse.json(result)
  } catch (e: any) {
    console.error('[counterfactual]', e?.message)
    return NextResponse.json({ error: e?.message || 'counterfactual replay failed' }, { status: 500 })
  }
}
