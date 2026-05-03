// app/api/orders/route.ts
import { NextRequest, NextResponse } from 'next/server'
import { getBroker } from '@/lib/brokers'
import { runRiskGuards, isTradeAllowed, getBlockReasons } from '@/lib/risk'
import { getAdminClient } from '@/lib/supabase'

export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const { pair, direction, strategy, userId, signalId, newsInWindow, newsEvent, aiConfidence, checklistScore, currentPrice } = body

    const broker = await getBroker()

    // Fetch real-time account data for risk checks
    let openTrades: any[] = []
    let balance = 10000
    let todayPL = 0

    try {
      const [trades, account] = await Promise.all([broker.getOpenTrades(), broker.getAccountSummary()])
      openTrades = trades
      balance = account.balance
    } catch { /* use defaults if broker fails */ }

    if (userId) {
      try {
        const admin = getAdminClient()
        const today = new Date().toISOString().split('T')[0]
        const { data } = await admin
          .from('trades')
          .select('pl_usd')
          .eq('user_id', userId)
          .gte('closed_at', today + 'T00:00:00')
          .not('pl_usd', 'is', null)
        todayPL = (data || []).reduce((s: number, t: any) => s + (t.pl_usd || 0), 0)
      } catch { /* ignore */ }
    }

    // ─── Hard risk guards ─────────────────────────────────────────────────
    const riskChecks = runRiskGuards({
      strategy, openTrades, accountBalance: balance,
      todayRealizedPL: todayPL,
      newsInWindow: newsInWindow || false, newsEvent,
    })
    if (!isTradeAllowed(riskChecks)) {
      return NextResponse.json({
        success: false, blocked: true,
        reasons: getBlockReasons(riskChecks),
      }, { status: 422 })
    }

    // ─── Calculate position size and place order ──────────────────────────
    const lots = broker.calcPositionSize(balance, strategy.riskPct, strategy.slPips, pair)
    const orderResult = await broker.placeOrder({
      pair, direction, lots,
      takeProfitPips: strategy.tpPips,
      stopLossPips: strategy.slPips,
      currentPrice: currentPrice || 1.0,
    })

    if (!orderResult.success) {
      return NextResponse.json({ success: false, error: orderResult.error }, { status: 500 })
    }

    // ─── Log to Supabase ─────────────────────────────────────────────────
    if (userId) {
      try {
        const admin = getAdminClient()
        const { data: trade } = await admin.from('trades').insert({
          user_id: userId,
          oanda_trade_id: orderResult.tradeId,
          pair, direction,
          entry_price: orderResult.filledPrice,
          tp_price: orderResult.tpPrice,
          sl_price: orderResult.slPrice,
          lots, result: 'OPEN', rules_followed: true,
          checklist_score: checklistScore,
          ai_confidence: aiConfidence,
        }).select().single()

        if (signalId && trade) {
          await admin.from('signals').update({ acted_on: true, trade_id: trade.id }).eq('id', signalId)
        }
      } catch { /* ignore db errors */ }
    }

    return NextResponse.json({
      ...orderResult, success: true, lots, broker: broker.name,
      riskWarnings: riskChecks.filter(c => c.severity === 'WARN').map(c => c.reason),
    })
  } catch (error: any) {
    console.error('[orders]', error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}
