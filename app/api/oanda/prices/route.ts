// app/api/oanda/prices/route.ts
import { NextRequest, NextResponse } from 'next/server'
import { getBroker } from '@/lib/brokers'

export async function GET(req: NextRequest) {
  try {
    const pairs = req.nextUrl.searchParams.get('pairs')?.split(',')
      || ['EUR/USD', 'GBP/USD', 'USD/JPY', 'AUD/USD', 'XAU/USD']
    const authToken = req.headers.get('Authorization')?.replace('Bearer ', '') || undefined
    const broker = await getBroker(authToken)
    const prices = await broker.getPrices(pairs)
    return NextResponse.json({ prices, broker: broker.name, timestamp: new Date().toISOString() })
  } catch (error: any) {
    console.error('[prices]', error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}
