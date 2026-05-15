// app/api/close-trade/route.ts
import { NextRequest, NextResponse } from 'next/server'
import { getBroker } from '@/lib/brokers'
import { getAdminClient } from '@/lib/supabase'
import { alertTradeClosed } from '@/lib/telegram'

export async function POST(req: NextRequest) {
  try {
    const { tradeId, userId, pair, direction } = await req.json()
    if (!tradeId) return NextResponse.json({ error: 'tradeId required' }, { status: 400 })

    const authToken = req.headers.get('Authorization')?.replace('Bearer ', '') || undefined
    const broker = await getBroker(authToken)

    const result = await broker.closeTrade(tradeId)

    // "Position not found" means Capital.com already closed it (TP/SL hit) — treat as success
    const alreadyClosed = !result.success && result.error === 'Position not found'

    if (!result.success && !alreadyClosed) {
      return NextResponse.json({ success: false, error: result.error }, { status: 500 })
    }

    // Update trade record in Supabase
    // Match by oanda_trade_id OR by Supabase row id (fallback for trades without a broker id)
    if (userId && tradeId) {
      try {
        const admin = getAdminClient()
        await admin.from('trades')
          .update({ result: 'CLOSED', closed_at: new Date().toISOString(), pl_usd: result.pl ?? null })
          .eq('user_id', userId)
          .or(`oanda_trade_id.eq.${tradeId},id.eq.${tradeId}`)
      } catch { /* ignore */ }
    }

    // Fire Telegram alert (non-blocking)
    if (pair && direction) {
      alertTradeClosed({ pair, direction, pl: result.pl, broker: broker.name }).catch(() => {})
    }

    return NextResponse.json({ success: true, pl: result.pl })
  } catch (error: any) {
    console.error('[close-trade]', error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}
