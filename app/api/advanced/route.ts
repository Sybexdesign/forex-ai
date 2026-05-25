// app/api/advanced/route.ts
export const dynamic = 'force-dynamic'  // live candle data — must never be cached

import { NextRequest, NextResponse } from 'next/server'
import { getMarketCandles } from '@/lib/marketdata'
import { runAdvancedAnalysis } from '@/lib/advanced-indicators'

export async function GET(req: NextRequest) {
  const pair      = req.nextUrl.searchParams.get('pair')      || 'EUR/USD'
  const timeframe = req.nextUrl.searchParams.get('timeframe') || '1H'
  const authToken = req.headers.get('Authorization')?.replace('Bearer ', '') || undefined

  try {
    const { candles, simulated } = await getMarketCandles(authToken, pair, timeframe, 200)
    const analysis = runAdvancedAnalysis(candles, pair)
    return NextResponse.json({ analysis, pair, timeframe, candleCount: candles.length, simulated })
  } catch (error: any) {
    console.error('[advanced]', error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}
