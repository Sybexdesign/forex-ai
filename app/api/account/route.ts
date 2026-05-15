// app/api/account/route.ts
import { NextRequest, NextResponse } from 'next/server'
import { getBroker } from '@/lib/brokers'
import { getAdminClient } from '@/lib/supabase'

export async function GET(req: NextRequest) {
  try {
    const token = req.headers.get('Authorization')?.replace('Bearer ', '') || undefined
    const broker = await getBroker(token)

    // Use allSettled so an open-trades failure doesn't block the whole response
    const [summaryResult, openTradesResult] = await Promise.allSettled([
      broker.getAccountSummary(),
      broker.getOpenTrades(),
    ])

    const summary = summaryResult.status === 'fulfilled' ? summaryResult.value : { balance: 0, unrealizedPL: 0, realizedPL: 0, openTradeCount: 0, currency: 'USD', nav: 0 }
    const openTrades = openTradesResult.status === 'fulfilled' ? openTradesResult.value : []
    const brokerReliable = openTradesResult.status === 'fulfilled'

    // Non-blocking: sync any TP/SL-closed trades back to our DB.
    // Only for brokers that actually return live position data — MT5Direct and
    // SimulationBroker always return [] from getOpenTrades(), so we must NOT
    // use that to mark trades as closed (it would incorrectly close everything).
    if (token && brokerReliable && broker.supportsLivePositions) {
      syncClosedTrades(token, openTrades).catch(() => {})
    }

    return NextResponse.json({ ...summary, broker: broker.name, openTrades })
  } catch (error: any) {
    console.error('[account]', error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}

// Compares DB-OPEN trades against broker positions and marks auto-closed ones (TP/SL) as CLOSED
async function syncClosedTrades(token: string, brokerPositions: any[]) {
  try {
    // Decode user ID from JWT (sub claim) — no library needed
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString())
    const userId = payload?.sub
    if (!userId) return

    const admin = getAdminClient()

    const { data: dbOpen } = await admin
      .from('trades')
      .select('id, oanda_trade_id')
      .eq('user_id', userId)
      .eq('result', 'OPEN')

    if (!dbOpen?.length) return

    // Build set of broker-side open position IDs
    const brokerIds = new Set(brokerPositions.map((p: any) => p.id))

    // Trades in DB as OPEN but absent from broker → auto-closed by TP/SL
    const toClose = dbOpen.filter(t => t.oanda_trade_id && !brokerIds.has(t.oanda_trade_id))
    if (!toClose.length) return

    const now = new Date().toISOString()
    await Promise.all(
      toClose.map(t =>
        admin.from('trades')
          .update({ result: 'CLOSED', closed_at: now })
          .eq('id', t.id)
      )
    )
  } catch { /* ignore — sync is best-effort */ }
}
