// app/api/indicators/route.ts
import { NextRequest, NextResponse } from 'next/server'
import { getMarketCandles } from '@/lib/marketdata'
import { calculateIndicators } from '@/lib/indicators'

export async function GET(req: NextRequest) {
  const pair = req.nextUrl.searchParams.get('pair') || 'EUR/USD'
  const timeframe = req.nextUrl.searchParams.get('timeframe') || '1H'
  const authToken = req.headers.get('Authorization')?.replace('Bearer ', '') || undefined
  try {
    const { candles, source: brokerName, simulated } = await getMarketCandles(authToken, pair, timeframe, 200)
    const indicators = calculateIndicators(candles)
    return NextResponse.json({ indicators, pair, timeframe, broker: brokerName, candleCount: candles.length, simulated })
  } catch (error: any) {
    console.error('[indicators]', error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}
