// app/api/backtest/route.ts
// Phase 10 — walk-forward backtest harness API.
//
//   GET ?window=90&userId=&refresh=1&confFloor=60&strictSafety=80&minSamples=20
//
// Compares CURRENT SYSTEM vs CURRENT+EXPECTANCY vs +AUTHORITY vs +SAFETY on the
// same resolved-prediction history, with point-in-time segment statistics (no
// lookahead). Results are cached 10 minutes; refresh=1 forces a recompute.
export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { runBacktest } from '@/lib/backtest'

export async function GET(req: NextRequest) {
  try {
    const sp = req.nextUrl.searchParams
    const window = parseInt(sp.get('window') || '90', 10)
    const confFloor = parseInt(sp.get('confFloor') || '', 10)
    const strictSafety = parseInt(sp.get('strictSafety') || '', 10)
    const minSamples = parseInt(sp.get('minSamples') || '', 10)
    const userId = sp.get('userId') || null
    const refresh = sp.get('refresh') === '1'

    // Cache is inside runBacktest; refresh=1 bypasses it.
    const result = await runBacktest({
      days: Number.isFinite(window) ? window : 90,
      userId,
      confFloor: Number.isFinite(confFloor) ? confFloor : undefined,
      strictSafetyMin: Number.isFinite(strictSafety) ? strictSafety : undefined,
      minSamples: Number.isFinite(minSamples) ? minSamples : undefined,
      force: refresh,
    })

    return NextResponse.json(result)
  } catch (e: any) {
    console.error('[backtest]', e?.message)
    return NextResponse.json({ error: e?.message || 'backtest failed' }, { status: 500 })
  }
}
