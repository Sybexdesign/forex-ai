// app/api/orders/route.ts
export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { getBroker } from '@/lib/brokers'
import { runRiskGuards, isTradeAllowed, getBlockReasons } from '@/lib/risk'
import { calcPropFirmStatus, applyPropFirmGuards, DEFAULT_PROP_FIRM } from '@/lib/propfirm'
import type { PropFirmSettings } from '@/lib/propfirm'
import { getAdminClient } from '@/lib/supabase'
import { alertOrderPlaced, alertOrderBlocked, alertOrderFailed } from '@/lib/telegram'

function dbToSettings(d: any): PropFirmSettings {
  return {
    enabled: d.enabled,
    firmType: d.firm_type,
    phase: d.phase,
    accountSize: +d.account_size,
    initialBalance: +d.initial_balance,
    maxDailyLossPct: +d.max_daily_loss_pct,
    maxTotalDrawdownPct: +d.max_total_drawdown_pct,
    profitTargetPct: +d.profit_target_pct,
    minTradingDays: +d.min_trading_days,
    noOvernight: d.no_overnight,
    noWeekend: d.no_weekend,
    newsRestriction: d.news_restriction,
    consistencyRulePct: +d.consistency_rule_pct,
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const { pair, direction, strategy, userId, signalId, newsInWindow, newsEvent, aiConfidence, checklistScore, currentPrice, maxConcurrentTrades, signalTimestamp } = body

    const authToken = req.headers.get('Authorization')?.replace('Bearer ', '') || undefined
    const broker = await getBroker(authToken)

    // Hard block: never place real orders through the simulation broker
    if (broker.name === 'Simulation (Demo)') {
      return NextResponse.json(
        { success: false, blocked: true, reasons: ['No live broker connected — configure MT5 Direct or another broker before trading live'] },
        { status: 422 }
      )
    }

    // Fetch real-time account data for risk checks
    let openTrades: any[] = []
    let balance = 0          // 0 = not yet synced; guards skip on 0 to avoid false blocks
    let equity  = 0
    let todayPL = 0
    let allTimePL = 0
    let tradingDays = 0
    let maxDailyPLEver = 0
    let brokerSynced = false

    try {
      const [trades, account] = await Promise.all([broker.getOpenTrades(), broker.getAccountSummary()])
      openTrades   = trades
      balance      = account.balance
      equity       = account.nav ?? account.balance
      brokerSynced = balance > 0
    } catch { /* use defaults if broker fails */ }

    // ─── Account protection: equity ratio guard ───────────────────────────
    // Block new trades if floating losses have consumed more than 25% of balance.
    // Only runs when broker data is confirmed live (brokerSynced) — skipped if
    // EA hasn't pushed data yet to avoid false-blocking on first connection.
    if (brokerSynced && equity < balance * 0.75) {
      const reason = `Account equity ($${equity.toFixed(2)}) has fallen below 75% of balance ($${balance.toFixed(2)}) — auto-trading paused to protect the account`
      await alertOrderBlocked({ pair, direction, reason })
      return NextResponse.json({ success: false, blocked: true, reasons: [reason] }, { status: 422 })
    }

    // ─── Server-side max concurrent trades guard ─────────────────────────
    // Authoritative check against the DB rather than trusting client state.
    // Uses the maxConcurrentTrades value the UI sends (defaults to strategy.maxPositions).
    const maxTrades = (typeof maxConcurrentTrades === 'number' && maxConcurrentTrades > 0)
      ? maxConcurrentTrades
      : (strategy?.maxPositions ?? 2)
    if (userId) {
      try {
        const admin = getAdminClient()
        const { count } = await admin
          .from('trades')
          .select('id', { count: 'exact', head: true })
          .eq('user_id', userId)
          .eq('result', 'OPEN')
        if (typeof count === 'number' && count >= maxTrades) {
          const reason = `Maximum ${maxTrades} concurrent trade(s) already open (${count} in DB) — wait for a position to close before placing more`
          await alertOrderBlocked({ pair, direction, reason })
          return NextResponse.json({ success: false, blocked: true, reasons: [reason] }, { status: 422 })
        }
      } catch { /* non-fatal — fall through to risk guards */ }
    }

    if (userId) {
      try {
        const admin = getAdminClient()
        const today = new Date().toISOString().split('T')[0]

        const [todayRes, allTimeRes, daysRes] = await Promise.all([
          // Today's P&L
          admin.from('trades').select('pl_usd').eq('user_id', userId)
            .gte('closed_at', today + 'T00:00:00').not('pl_usd', 'is', null),
          // All-time P&L (also need closed_at for consistency rule)
          admin.from('trades').select('pl_usd, closed_at').eq('user_id', userId).not('pl_usd', 'is', null),
          // Distinct trading days
          admin.from('trades').select('closed_at').eq('user_id', userId).not('closed_at', 'is', null),
        ])

        todayPL = (todayRes.data || []).reduce((s: number, t: any) => s + (t.pl_usd || 0), 0)
        allTimePL = (allTimeRes.data || []).reduce((s: number, t: any) => s + (t.pl_usd || 0), 0)

        const days = new Set((daysRes.data || []).map((t: any) => t.closed_at?.split('T')[0]))
        tradingDays = days.size

        // Max single-day profit for consistency rule
        const dayTotals: Record<string, number> = {}
        for (const t of allTimeRes.data || []) {
          if (t.pl_usd > 0 && t.closed_at) {
            const d = t.closed_at.split('T')[0]
            dayTotals[d] = (dayTotals[d] || 0) + t.pl_usd
          }
        }
        maxDailyPLEver = Math.max(0, ...Object.values(dayTotals))
      } catch { /* ignore */ }
    }

    // ─── Prop firm guards (if enabled) ────────────────────────────────────
    let propFirmSettings = DEFAULT_PROP_FIRM
    if (authToken) {
      try {
        const sb = createClient(
          process.env.NEXT_PUBLIC_SUPABASE_URL!,
          process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
          { global: { headers: { Authorization: `Bearer ${authToken}` } }, auth: { autoRefreshToken: false, persistSession: false } }
        )
        const { data } = await sb.from('prop_firm_settings').select('*').single()
        if (data) propFirmSettings = dbToSettings(data)
      } catch { /* use default if no prop firm row */ }
    }

    if (propFirmSettings.enabled) {
      const pfStatus = calcPropFirmStatus(propFirmSettings, todayPL, allTimePL, tradingDays, maxDailyPLEver)
      const pfGuard = applyPropFirmGuards(propFirmSettings, pfStatus)
      if (!pfGuard.allowed) {
        await alertOrderBlocked({ pair, direction, reason: pfGuard.reasons[0] })
        return NextResponse.json({ success: false, blocked: true, reasons: pfGuard.reasons, propFirmBlock: true }, { status: 422 })
      }
      // Enforce prop firm risk per trade:
      // Base cap = half the daily loss limit; stricter firms with a consistency rule
      // get a tighter cap of 1% to protect payout eligibility
      const baseCap = propFirmSettings.maxDailyLossPct / 2
      const maxRiskPct = propFirmSettings.consistencyRulePct > 0
        ? Math.min(baseCap, 1)
        : baseCap
      if (strategy.riskPct > maxRiskPct) {
        strategy.riskPct = maxRiskPct
      }
      // Block news trading if firm requires it
      if (propFirmSettings.newsRestriction && newsInWindow) {
        await alertOrderBlocked({ pair, direction, reason: 'Prop firm: news trading not allowed' })
        return NextResponse.json({ success: false, blocked: true, reasons: ['Prop firm rules: no trading during high-impact news'], propFirmBlock: true }, { status: 422 })
      }
    }

    // ─── Server-side news guard (unconditional) ───────────────────────────
    // Always block during high-impact news regardless of strategy.hardNews setting.
    // Client-side news flag is trusted but also verified: if newsInWindow is false
    // but we can cross-check via the strategy.hardNews flag.
    if (newsInWindow) {
      console.warn(`[orders] HIGH-IMPACT NEWS in window — ${pair} ${direction} by ${userId}`)
      if (strategy.hardNews !== false) {
        // hardNews unset or true → treat as enabled (safe default)
        const reason = `High-impact news event in progress — order blocked to protect capital`
        await alertOrderBlocked({ pair, direction, reason })
        return NextResponse.json({ success: false, blocked: true, reasons: [reason] }, { status: 422 })
      }
      // hardNews explicitly disabled — allow but stamp a warning in logs
    }

    // ─── Hard risk guards ─────────────────────────────────────────────────
    const riskChecks = runRiskGuards({
      strategy, openTrades, accountBalance: balance,
      todayRealizedPL: todayPL,
      newsInWindow: newsInWindow || false, newsEvent,
    })
    if (!isTradeAllowed(riskChecks)) {
      const reasons = getBlockReasons(riskChecks)
      await alertOrderBlocked({ pair, direction, reason: reasons[0] })
      return NextResponse.json({ success: false, blocked: true, reasons }, { status: 422 })
    }

    // ─── Pre-order safety validation ─────────────────────────────────────
    // These checks run after risk guards so we have a clean fail path.
    if (!currentPrice || currentPrice <= 0) {
      return NextResponse.json({ success: false, blocked: true, reasons: ['Invalid price: no live price available — signal may be stale'] }, { status: 422 })
    }
    // Reject if the signal price is more than 2 minutes old (market may have moved)
    if (signalTimestamp) {
      const signalAgeMs = Date.now() - new Date(signalTimestamp).getTime()
      if (signalAgeMs > 2 * 60 * 1000) {
        return NextResponse.json({ success: false, blocked: true, reasons: [`Signal expired: price is ${Math.round(signalAgeMs / 1000)}s old — refresh the signal before trading`] }, { status: 422 })
      }
    }
    if (!strategy.slPips || strategy.slPips <= 0) {
      return NextResponse.json({ success: false, blocked: true, reasons: ['Stop loss pips must be > 0 — configure slPips in Strategy settings'] }, { status: 422 })
    }
    if (!strategy.tpPips || strategy.tpPips <= 0) {
      return NextResponse.json({ success: false, blocked: true, reasons: ['Take profit pips must be > 0 — configure tpPips in Strategy settings'] }, { status: 422 })
    }

    // ─── Calculate position size and place order ──────────────────────────
    const lots = broker.calcPositionSize(balance, strategy.riskPct, strategy.slPips, pair)
    if (!lots || lots <= 0) {
      return NextResponse.json({ success: false, blocked: true, reasons: ['Position size calculated as 0 — check balance, risk % and SL pips in Strategy settings'] }, { status: 422 })
    }
    const orderResult = await broker.placeOrder({
      pair, direction, lots,
      takeProfitPips: strategy.tpPips,
      stopLossPips: strategy.slPips,
      currentPrice,
    })

    if (!orderResult.success) {
      await alertOrderFailed({ pair, direction, error: orderResult.error || 'Unknown error' })
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
      } catch (dbErr: any) {
        // Order is LIVE on broker but DB write failed — log so it can be manually reconciled.
        console.error('[orders] CRITICAL: order placed but DB write failed — zombie trade risk', { pair, direction, lots, orderId: orderResult.tradeId, error: dbErr?.message })
      }
    }

    // Fire Telegram alert (non-blocking)
    alertOrderPlaced({
      pair, direction, lots,
      filledPrice: orderResult.filledPrice || currentPrice,
      tpPrice: orderResult.tpPrice || 0,
      slPrice: orderResult.slPrice || 0,
      confidence: aiConfidence || 0,
      broker: broker.name,
    })

    return NextResponse.json({
      ...orderResult, success: true, lots, broker: broker.name,
      riskWarnings: riskChecks.filter(c => c.severity === 'WARN').map(c => c.reason),
    })
  } catch (error: any) {
    console.error('[orders]', error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}
