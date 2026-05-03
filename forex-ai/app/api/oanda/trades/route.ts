// app/api/oanda/trades/route.ts
import { NextRequest, NextResponse } from 'next/server'
import { getBroker } from '@/lib/brokers'
import { getAdminClient } from '@/lib/supabase'

export async function GET() {
  try {
    const broker = await getBroker()
    const trades = await broker.getOpenTrades()
    return NextResponse.json({ trades, broker: broker.name })
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const { tradeId, userId } = await req.json()
    const broker = await getBroker()
    const result = await broker.closeTrade(tradeId)

    if (result.success && userId) {
      try {
        const admin = getAdminClient()
        await admin.from('trades')
          .update({
            result: (result.pl || 0) >= 0 ? 'WIN' : 'LOSS',
            pl_usd: result.pl,
            closed_at: new Date().toISOString(),
          })
          .eq('oanda_trade_id', tradeId)
      } catch { /* ignore db errors */ }
    }
    return NextResponse.json(result)
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}
