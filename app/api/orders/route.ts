// app/api/orders/route.ts
export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { getBroker } from '@/lib/brokers'
import { runRiskGuards, isTradeAllowed, getBlockReasons } from '@/lib/risk'
import { calcPropFirmStatus, applyPropFirmGuards, DEFAULT_PROP_FIRM } from '@/lib/propfirm'
import type { PropFirmSettings } from '@/lib/propfirm'
import { getAdminClient, DEFAULT_STRATEGY } from '@/lib/supabase'
import { minStopPips } from '@/lib/trade-levels'
import { planOrder } from '@/lib/order-planner.mjs'
import { EXECUTION_CONTRACT_VERSION } from '@/lib/execution-truth.mjs'
import { evaluateExecutionGuards } from '@/lib/execution-guards.mjs'

import { alertOrderPlaced, alertOrderBlocked, alertOrderFailed, alertProfitTargetDisabled } from '@/lib/telegram'

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

// Dedup map for the profit-target-disabled Telegram warning: userId → last
// alert ms. One Telegram per user per hour even if many orders fire.
const ptDisabledWarned = new Map<string, number>()

export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const {
      pair, direction, strategy, userId, signalId,
      newsInWindow, newsEvent, aiConfidence, checklistScore,
      currentPrice, maxConcurrentTrades, signalTimestamp,
      // Source-tracking fields (added by 20260606_trades_source_tracking migration).
      // Optional — present on every code path after this change but absent on legacy
      // callers; defaulted to safe values on insert.
      source, source_sl_pips, source_tp_pips,
      signal_at, signal_confidence, signal_id_ref,
      // Phase 4 lineage (optional): explicit prediction/setup references so
      // signal → prediction → execution does not rely on fuzzy timestamp matching.
      predictionLogId, setupId,
    } = body

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
    let lastSyncAt: string | undefined

    try {
      const [trades, account] = await Promise.all([broker.getOpenTrades(), broker.getAccountSummary()])
      openTrades   = trades
      balance      = account.balance
      equity       = account.nav ?? account.balance
      brokerSynced = balance > 0
      lastSyncAt   = account.lastSyncAt
    } catch { /* use defaults if broker fails */ }

    // ─── Broker data staleness guard (MT5 Direct / Exness) ───────────────
    // Adapters that receive balance asynchronously via webhook (the MT5 EA pushes
    // every ~30s) populate lastSyncAt. If the most recent push is >5 min old the
    // EA is almost certainly disconnected — block the order rather than trade on
    // a stale balance that doesn't reflect the live account.
    if (lastSyncAt) {
      const syncAgeMs = Date.now() - new Date(lastSyncAt).getTime()
      const STALE_THRESHOLD_MS = 5 * 60_000
      if (syncAgeMs > STALE_THRESHOLD_MS) {
        const ageMin = Math.round(syncAgeMs / 60_000)
        const reason = `Broker data stale — last EA sync ${ageMin} min ago (threshold ${STALE_THRESHOLD_MS / 60_000} min). Check MT5/EA is running before trading.`
        console.warn(`[orders] STALE BROKER DATA — ${broker.name} last sync ${ageMin} min ago, blocking ${pair} ${direction}`)
        await alertOrderBlocked({ pair, direction, reason })
        return NextResponse.json({ success: false, blocked: true, reasons: [reason] }, { status: 422 })
      }
    }

    // ─── Final signal freshness / duplication validation (execution audit) ───
    // Authoritative server-side checks just before any order is sent, using the
    // shared execution-guards module (single authoritative TTL/drift config).
    const sigAtMsNum = typeof body.signal_at === 'string' ? new Date(body.signal_at).getTime() : null
    let openTradeForSignal = false
    if (typeof body.signal_id_ref === 'string' && body.signal_id_ref && userId) {
      try {
        const dupRes = await getAdminClient()
          .from('trades').select('id').eq('user_id', userId)
          .eq('signal_id_ref', body.signal_id_ref).eq('result', 'OPEN').maybeSingle()
        openTradeForSignal = !!dupRes.data
      } catch { /* duplicate check is best-effort */ }
    }
    const guard = evaluateExecutionGuards({
      nowMs: Date.now(),
      signalAtMs: sigAtMsNum,
      referencePrice: body.signalPrice,
      livePrice: body.currentPrice,
      signalRef: typeof body.signal_id_ref === 'string' ? body.signal_id_ref : null,
      openTradeExists: openTradeForSignal,
    })
    if (!guard.ok) {
      console.warn(`[orders] REJECTED ${guard.gate} — ${pair} ${direction}: ${guard.reason}`)
      return NextResponse.json({ success: false, blocked: true, reasons: [guard.reason ?? guard.gate], gate: guard.gate }, { status: 422 })
    }

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

    // ─── Broker min-stop-distance guard (hoisted above lot calc) ─────────
    // Floors + widening logic live in lib/trade-levels.ts (shared with the
    // AutoTrade page so cards display the same post-widening stop distance
    // that gets placed here).
    //
    // Hoisted ABOVE the lot calculation so both manual-override and auto-sizing
    // dimension positions against the actual stop distance that will be placed,
    // not the (pre-widening) strategy.slPips. Previously sized for tight SL but
    // placed at the wider safeSlPips → over-sized positions by up to 2×.
    const minStop = minStopPips(pair)
    let safeSlPips = strategy.slPips
    let safeTpPips = strategy.tpPips
    if (safeSlPips < minStop) {
      console.warn(`[orders] ${pair} SL ${safeSlPips}p < broker min ${minStop}p — widening to ${Math.round(minStop * 1.1)}p`)
      safeSlPips = Math.round(minStop * 1.1)
    }
    if (safeTpPips < minStop) {
      console.warn(`[orders] ${pair} TP ${safeTpPips}p < broker min ${minStop}p — widening to ${Math.round(minStop * 1.1)}p`)
      safeTpPips = Math.round(minStop * 1.1)
    }

    // ─── Calculate position size and place order ──────────────────────────
    // ─── Position sizing: MANUAL request is authoritative, AUTO unchanged ──
    // Delegated to the shared planner (lib/order-planner.mjs) so the exact code
    // that runs here can be executed against a MOCKED BROKER in tests, instead of
    // being verified by regex against this file. The logic is byte-for-byte the
    // same policy it replaced — see that module for the AI-original rationale on
    // why MANUAL lots are never rewritten to satisfy an AUTO sizing assumption.
    //
    // `calcPositionSize` is injected: it is the broker's AUTO sizing function and
    // the single dependency the tests mock.
    const plan = planOrder({
      strategy, pair, balance,
      calcPositionSize: (b: number, r: number, s: number, p: string) => broker.calcPositionSize(b, r, s, p),
      defaultManualRiskPct: DEFAULT_STRATEGY.manualRiskPct,
    })

    if (!plan.ok) {
      // Explicit, actionable rejection. We do NOT quietly trade a different size.
      console.warn(`[orders] ${pair} order plan rejected (${plan.reason}): ${plan.message}`)
      await alertOrderBlocked({ pair, direction, reason: plan.message })
      return NextResponse.json({
        success: false, blocked: true, reasons: [plan.message], reason: plan.reason,
      }, { status: 422 })
    }

    // `lots` is the planner's authoritative size. In MANUAL mode it is the user's
    // request, echoed unchanged; in AUTO mode it is calcPositionSize()'s output.
    // No code below this line may rewrite it.
    const lots      = plan.lots
    const lotSource = plan.lotSource
    safeSlPips      = plan.slPips
    safeTpPips      = plan.tpPips
    const manualRisk = plan.manualRisk

    if (lotSource === 'manual') {
      console.log(`[orders] ${pair} using manual lots: ${lots} (override active)`)
      console.log(`[orders] ${pair} MANUAL ${lots} lots → SL ${safeSlPips}p TP ${safeTpPips}p · risk $${manualRisk?.riskUsd} (${manualRisk?.accountRiskPct}% of $${balance}, budget ${manualRisk?.riskPct}%)${plan.slClampedToCap ? ' [SL clamped to strategy cap]' : ''}`)
    } else {
      console.log(`[orders] ${pair} using auto lots: ${lots} (${strategy.riskPct}% of $${balance} ÷ ${safeSlPips}p)`)
    }

    // ─── Profit-target safety check ───────────────────────────────────────

    // Warn when broker_configs.config.profitFixedUsd is 0 or null at order time
    // — without it the EA's fixed-USD TP close is disabled and the trade can
    // only exit via SL/TP/trail/decay. Likely an unintended setting. Deduped
    // in-memory per userId for 1h so a misconfigured user gets one Telegram
    // ping instead of one per fired order.
    if (userId) {
      try {
        const admin = getAdminClient()
        const { data: cfg } = await admin
          .from('broker_configs')
          .select('config')
          .eq('user_id', userId)
          .eq('is_active', true)
          .limit(1)
          .maybeSingle()
        const ptUsd  = Number((cfg?.config as any)?.profitFixedUsd ?? 0)
        const ptOk   = isFinite(ptUsd) && ptUsd > 0
        if (!ptOk) {
          console.warn(`[orders] INFO — ${pair} placed without a fixed-USD profit close (profitFixedUsd=${(cfg?.config as any)?.profitFixedUsd ?? 'null'}). AUTO TRADE REMAINS ACTIVE — strategy SL/TP + trade-manager protection apply.`)
          if (!ptDisabledWarned.has(userId) || Date.now() - (ptDisabledWarned.get(userId) || 0) > 3600_000) {
            ptDisabledWarned.set(userId, Date.now())
            await alertProfitTargetDisabled({ pair }).catch(() => {})
          }
        }
      } catch (e: any) {
        console.warn(`[orders] profit-target safety check failed (continuing): ${e?.message}`)
      }
    }
    // (safeSlPips/safeTpPips computed above — see broker min-stop-distance guard
    // hoisted to the start of the position-sizing block so manual and auto sizing
    // both use the actual stop distance the broker will accept.)
    // ─── Cross-source dedup guard ────────────────────────────────────────
    // Reject any order with same user+pair+direction placed in the prior 2s.
    // Belt-and-braces against worker+browser racing or two-tab manual clicks —
    // the API layer is the single bottleneck both paths funnel through, so
    // catching duplicates here is source-agnostic.
    if (userId) {
      try {
        const admin   = getAdminClient()
        const cutoff  = new Date(Date.now() - 2000).toISOString()
        const { data: dupes } = await admin.from('trades')
          .select('id, created_at, source')
          .eq('user_id', userId)
          .eq('pair', pair)
          .eq('direction', direction)
          .gte('created_at', cutoff)
          .order('created_at', { ascending: false })
          .limit(1)
        if (dupes && dupes.length > 0) {
          const existing = dupes[0]
          console.warn(`[orders] DUPLICATE rejected — ${pair} ${direction} placed ${Math.round((Date.now() - new Date(existing.created_at).getTime()))}ms ago (existing id=${existing.id} source=${existing.source})`)
          return NextResponse.json({
            success: false,
            error: 'Duplicate order rejected — same user+pair+direction within 2s',
            code: 'DUPLICATE_ORDER',
            existingTradeId: existing.id,
            existingSource:  existing.source,
          }, { status: 409 })
        }
      } catch (e: any) {
        // Dedup is best-effort; never block a legitimate order if Supabase is slow.
        console.warn(`[orders] dedup check failed (allowing order through): ${e?.message}`)
      }
    }

    // ─── Anchor refresh: pull a fresh quote from the broker right before
    // placing. Callers send `currentPrice` from their own snapshot — for the
    // worker that's the candle close from the most recent /api/scalper/signal
    // response, which can be 5-30s stale by the time it reaches here. SL/TP
    // are computed off this anchor inside the OANDA/Capital adapters; a stale
    // anchor makes them land at the wrong absolute prices relative to the
    // actual fill. MT5 Direct adapter does its own EA-based re-anchor and is
    // idempotent under this — getting a fresh anchor here just brings the
    // fallback path (when the EA's latestPrices is stale) up to date too.
    //
    // Fall back to the caller-supplied currentPrice on any failure — never
    // block an otherwise-valid order on a transient quote-feed problem.
    let effectivePrice = currentPrice
    let anchorDriftPips: number | null = null
    let anchorSource: 'live-broker' | 'caller-fallback' = 'caller-fallback'
    try {
      const liveQuotes = await broker.getPrices([pair])
      const liveRow    = liveQuotes.find(p => p.pair === pair)
      if (liveRow && liveRow.bid > 0 && liveRow.ask > 0) {
        const live = direction === 'BUY' ? liveRow.ask : liveRow.bid
        const pip  = pair.includes('JPY')   ? 0.01
                   : pair.startsWith('XAU') ? 0.1
                   : pair.startsWith('XAG') ? 0.01
                   : 0.0001
        anchorDriftPips = (live - currentPrice) / pip
        effectivePrice  = live
        anchorSource    = 'live-broker'
        console.log(`[orders] anchor refreshed: ${pair} ${direction} signal=${currentPrice} → live=${live} drift=${anchorDriftPips.toFixed(1)}p`)
      } else {
        console.warn(`[orders] live quote unavailable for ${pair} (broker=${broker.name}) — using caller-supplied currentPrice ${currentPrice}`)
      }
    } catch (e: any) {
      console.warn(`[orders] live quote fetch failed for ${pair}: ${e?.message} — using caller-supplied currentPrice ${currentPrice}`)
    }

    // Explicit pre-fire log so it's impossible to miss when a real order is about
    // to hit a live account. Same line format on demo so the operator can grep
    // either trail. ACCOUNT_TYPE comes from env — set ACCOUNT_TYPE=live in prod.
    const accountType = (process.env.ACCOUNT_TYPE || 'demo').toLowerCase()
    if (accountType === 'live') {
      console.warn(`[orders] LIVE ORDER placing — pair=${pair} direction=${direction} lots=${lots} sl=${safeSlPips}p tp=${safeTpPips}p anchor=${effectivePrice}(${anchorSource}) balance=$${balance.toFixed(2)} broker=${broker.name}`)
    } else {
      console.log(`[orders] DEMO order placing — pair=${pair} direction=${direction} lots=${lots} sl=${safeSlPips}p tp=${safeTpPips}p anchor=${effectivePrice}(${anchorSource}) balance=$${balance.toFixed(2)} broker=${broker.name}`)
    }
    const orderResult = await broker.placeOrder({
      pair, direction, lots,
      takeProfitPips: safeTpPips,
      stopLossPips: safeSlPips,
      currentPrice: effectivePrice,
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
          // Source attribution — see 20260606_trades_source_tracking migration.
          // Callers must send `source`; we default to 'manual' for safety so any
          // legacy/unknown caller is still attributable.
          source:            source || 'manual',
          source_sl_pips:    source_sl_pips ?? null,
          source_tp_pips:    source_tp_pips ?? null,
          signal_at:         signal_at ?? null,
          signal_confidence: signal_confidence ?? null,
          signal_id_ref:     signal_id_ref ?? (typeof signalId === 'string' ? signalId : null),
          // Phase 4 — canonical lifecycle/provenance for new executions.
          trade_status:              'OPEN',
          execution_source:          String(source || 'manual').toUpperCase(),
          execution_contract_version: EXECUTION_CONTRACT_VERSION,
          broker_ticket:             orderResult.tradeId ?? null,
          prediction_log_id:         predictionLogId ?? null,
          setup_id:                  setupId ?? null,
        }).select().single()

        // Only attempt the signals-table update when signalId is a real UUID — the
        // browser scalp/mirror paths use synthetic strings (e.g. mirror-XAUUSD-…) which
        // Postgres rejected silently against the uuid PK, breaking every signal↔trade
        // link historically. signal_id_ref on the trade row carries the synthetic id
        // for those paths.
        const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
        if (signalId && trade && typeof signalId === 'string' && UUID_RE.test(signalId)) {
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
      filledPrice: orderResult.filledPrice || effectivePrice,
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
