// app/api/indicators/route.ts
import { NextRequest, NextResponse } from 'next/server'
import { getBroker } from '@/lib/brokers'
import { calculateIndicators } from '@/lib/indicators'

export async function GET(req: NextRequest) {
  const pair = req.nextUrl.searchParams.get('pair') || 'EUR/USD'
  const timeframe = req.nextUrl.searchParams.get('timeframe') || '1H'
  try {
    let candles: any[]
    let brokerName: string
    try {
      const broker = await getBroker()
      candles = await broker.getCandles(pair, timeframe, 200)
      brokerName = broker.name
      if (!candles || candles.length < 60) throw new Error('insufficient candle data')
    } catch {
      const { SimulationBroker } = await import('@/lib/brokers/simulation.adapter')
      const sim = new SimulationBroker()
      candles = await sim.getCandles(pair, timeframe, 200)
      brokerName = 'Simulation (fallback)'
    }
    const indicators = calculateIndicators(candles)
    return NextResponse.json({ indicators, pair, timeframe, broker: brokerName, candleCount: candles.length })
  } catch (error: any) {
    console.error('[indicators]', error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}
