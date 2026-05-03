// app/api/indicators/route.ts
import { NextRequest, NextResponse } from 'next/server'
import { getBroker } from '@/lib/brokers'
import { calculateIndicators } from '@/lib/indicators'

export async function GET(req: NextRequest) {
  const pair = req.nextUrl.searchParams.get('pair') || 'EUR/USD'
  const timeframe = req.nextUrl.searchParams.get('timeframe') || '1H'
  try {
    const broker = await getBroker()
    const candles = await broker.getCandles(pair, timeframe, 200)
    if (candles.length < 60) {
      return NextResponse.json({ error: 'Insufficient candle data' }, { status: 422 })
    }
    const indicators = calculateIndicators(candles)
    return NextResponse.json({ indicators, pair, timeframe, broker: broker.name, candleCount: candles.length })
  } catch (error: any) {
    console.error('[indicators]', error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}
