// app/api/mt5-sync/route.ts
// Called by the MT5 Expert Advisor to push account data and receive pending orders.
// Secured by per-user webhook token — no user auth required.

import { NextRequest, NextResponse } from 'next/server'
import { getAdminClient } from '@/lib/supabase'
import { manageTrades } from '@/lib/trade-manager'
import { alertRiskBreach, alertProfitReversal, alertCircuitBreaker } from '@/lib/telegram'

export const dynamic = 'force-dynamic'

// Convert MT5 symbol (EURUSD, EURUSDm, XAUUSD) to app pair (EUR/USD, XAU/USD)
function mt5SymbolToPair(sym: string): string {
  const clean = sym.replace(/[^A-Z]/gi, '').toUpperCase().slice(0, 6)
  return clean.slice(0, 3) + '/' + clean.slice(3)
}

export async function GET(req: NextRequest) {
  try {
    const token = req.nextUrl.searchParams.get('token')
    if (!token) return NextResponse.json({ error: 'Missing token' }, { status: 400 })

    const sb = getAdminClient()
    const { data: rows, error } = await sb
      .from('broker_configs')
      .select('id, config')
      .in('broker_type', ['mt5direct', 'exness'])

    if (error) return NextResponse.json({ error: error.message }, { status: 500 })

    const row = (rows || []).find((r: any) => r.config?.webhookToken === token)
    if (!row) return NextResponse.json({ error: 'Invalid token' }, { status: 401 })

    const now = Math.floor(Date.now() / 1000)
    const all: any[] = row.config?.pendingOrders || []
    const active = all.filter((o: any) => !o.expiresAt || o.expiresAt > now)

    // Remove stale orders from DB if any expired
    if (active.length < all.length) {
      await sb.from('broker_configs')
        .update({ config: { ...row.config, pendingOrders: active } })
        .eq('id', row.id)
    }

    return NextResponse.json({ ok: true, pendingOrders: active })
  } catch (e: any) {
    console.error('[mt5-sync] UNCAUGHT ERROR in GET:', e?.message)
    return NextResponse.json({ error: e.message }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  try {
    const token = req.nextUrl.searchParams.get('token')
    if (!token) return NextResponse.json({ error: 'Missing token' }, { status: 400 })

    console.log('[mt5-sync] POST received — token prefix:', token.slice(0, 8))

    const body = await req.json()
    const { balance, equity, currency, login, server, completedOrders, openPositions, prices, candles } = body

    if (typeof balance !== 'number') {
      return NextResponse.json({ error: 'balance must be a number' }, { status: 400 })
    }

    const hasPrices  = prices  && typeof prices  === 'object' && Object.keys(prices).length  > 0
    const hasCandles = candles && typeof candles  === 'object' && !!candles.data
    console.log(`[mt5-sync] balance=${balance} prices=${hasPrices} candles=${hasCandles} login=${login || '?'}`)

    const sb = getAdminClient()

    // Find broker_config row with this webhook token
    const { data: rows, error } = await sb
      .from('broker_configs')
      .select('id, user_id, config')
      .in('broker_type', ['mt5direct', 'exness'])

    if (error) return NextResponse.json({ error: error.message }, { status: 500 })

    const row = (rows || []).find((r: any) => r.config?.webhookToken === token)
    if (!row) {
      console.warn('[mt5-sync] Invalid token — no matching broker_config found')
      return NextResponse.json({ error: 'Invalid token' }, { status: 401 })
    }

    const userId = row.user_id

    // ── Process completed orders ──────────────────────────────────────────
    let pendingOrders: any[] = row.config?.pendingOrders || []
    if (Array.isArray(completedOrders) && completedOrders.length > 0) {
      for (const c of completedOrders) {
        console.log(`[mt5-sync] completedOrder id=${c.id?.slice(0,8)} success=${c.success} filledPrice=${c.filledPrice ?? 'n/a'} error=${c.error ?? 'none'}`)
      }
      const completedIds = new Set(completedOrders.map((o: any) => o.id))

      // Update Supabase trades for each successfully filled order
      for (const completed of completedOrders) {
        if (!completed.success) continue
        try {
          await sb.from('trades')
            .update({
              entry_price: completed.filledPrice ?? null,
              result: 'OPEN',
              opened_at: new Date().toISOString(),
            })
            .eq('user_id', userId)
            .eq('oanda_trade_id', completed.id)
            .eq('result', 'OPEN') // don't overwrite if already closed
        } catch { /* ignore individual update errors */ }
      }

      // Remove completed orders from the pending queue
      pendingOrders = pendingOrders.filter((o: any) => !completedIds.has(o.id))
    }

    // ── Load user strategy for risk context (Fix 8) ──────────────────────
    // Needed for the hard-USD-cap inside manageTrades AND for the post-close
    // >1R Telegram alert below. Fetched once per sync; tolerates missing row.
    const { data: stratRow } = await sb.from('strategies').select('settings').eq('user_id', userId).single()
    const riskPct = +(stratRow?.settings?.riskPct ?? 0.5)
    const oneRusd = balance > 0 && riskPct > 0 ? balance * (riskPct / 100) : 0
    // Snapshot of last-tick positions BEFORE we overwrite row.config — needed to
    // recover the EA's last-known unrealised P/L for trades that disappeared this tick.
    const prevPositionsByTicket: Record<string, any> = {}
    for (const p of (row.config?.openPositions || [])) {
      if (p?.ticket !== undefined) prevPositionsByTicket[String(p.ticket)] = p
    }

    // ── Reconcile DB open trades against EA's actual open positions ──────────
    // EA sends openPositions on every sync (empty array = no positions open).
    // Compare against DB trades marked OPEN: any DB trade that no longer has
    // a matching EA position was closed by MT5 (SL/TP hit or profit-protection)
    // and must be marked CLOSED so the max-trade guard stays accurate.
    if (Array.isArray(openPositions) && userId) {
      const cutoff = new Date(Date.now() - 2 * 60_000).toISOString()
      const { data: dbOpenTrades } = await sb
        .from('trades')
        .select('id, pair, direction, opened_at, oanda_trade_id')
        .eq('user_id', userId)
        .eq('result', 'OPEN')
        .lt('opened_at', cutoff)   // only touch trades > 2 min old (protect fresh fills)
        .order('opened_at', { ascending: false })

      if (dbOpenTrades && dbOpenTrades.length > 0) {
        // Count live EA positions per pair+direction
        const eaCount: Record<string, number> = {}
        for (const pos of openPositions) {
          const pair = mt5SymbolToPair(pos.symbol || '')
          const isLong = pos.type === 0 || String(pos.type).toLowerCase().includes('buy')
          const dir  = isLong ? 'BUY' : 'SELL'
          const key  = `${pair}|${dir}`
          eaCount[key] = (eaCount[key] || 0) + 1
        }

        // Group DB trades by pair+direction (newest first — slice from tail to keep newest)
        const dbByKey: Record<string, { id: string; oanda_trade_id?: string; pair: string }[]> = {}
        for (const t of dbOpenTrades) {
          const key = `${t.pair}|${t.direction}`
          if (!dbByKey[key]) dbByKey[key] = []
          dbByKey[key].push({ id: t.id, oanda_trade_id: (t as any).oanda_trade_id, pair: t.pair })
        }

        // Close any DB trade beyond the count the EA actually holds
        const toClose: { id: string; oanda_trade_id?: string; pair: string }[] = []
        for (const [key, rows] of Object.entries(dbByKey)) {
          const keep = eaCount[key] || 0
          toClose.push(...rows.slice(keep))
        }

        if (toClose.length > 0) {
          const nowStr = new Date().toISOString()
          const ids = toClose.map(t => t.id)
          for (let i = 0; i < ids.length; i += 100) {
            await sb.from('trades')
              .update({ result: 'CLOSED', closed_at: nowStr })
              .in('id', ids.slice(i, i + 100))
          }
          console.log(`[mt5-sync] Reconciled ${toClose.length} stale OPEN trade(s) → CLOSED`)

          // Fix 8 — post-close >1R Telegram alert. Use EA's last-known unrealised P/L
          // from the previous-tick snapshot. If the trade vanished with a loss exceeding
          // 1R of the user's risk, surface it so operator sees broker-side SL hits.
          // Also arm the circuit-breaker (Fix 3 of this batch): pause auto-trade
          // execution for 15 min so a gap-through doesn't immediately compound.
          let circuitBreakerArmedAt: string | null = null
          if (oneRusd > 0) {
            for (const t of toClose) {
              const lastPos = t.oanda_trade_id ? prevPositionsByTicket[String(t.oanda_trade_id)] : null
              const lastPl  = lastPos && typeof lastPos.profit === 'number' ? lastPos.profit : null
              if (lastPl !== null && lastPl < -oneRusd) {
                alertRiskBreach({
                  pair: t.pair, ticket: t.oanda_trade_id, pl: lastPl, cap: oneRusd, reason: 'post-close-1R',
                }).catch(() => {})
                // Arm the circuit breaker for 15 min from this close. We write the
                // earliest-armed timestamp so multiple losses don't shorten the pause.
                if (!circuitBreakerArmedAt) {
                  const until = new Date(Date.now() + 15 * 60_000).toISOString()
                  circuitBreakerArmedAt = until
                  console.warn(`[mt5-sync] CIRCUIT BREAKER ARMED — ${t.pair} lost $${Math.abs(lastPl).toFixed(2)} (1R=$${oneRusd.toFixed(2)}); pausing auto-trade until ${until}`)
                  alertCircuitBreaker({
                    pair: t.pair, loss: lastPl, oneR: oneRusd,
                    pauseUntil: new Date(until).toUTCString().slice(17, 25) + ' UTC',
                    pauseMin: 15,
                  }).catch(() => {})
                }
              }
            }
          }
          // If circuit breaker fired, stash it in broker_configs.config so the
          // worker (separate process) can read it via /api/account on its next
          // fetchRiskState cycle. Worker will skip auto-trade execution until the
          // timestamp passes.
          if (circuitBreakerArmedAt) {
            try {
              // Merge into existing config — read latest first to avoid clobbering
              // anything mt5-sync writes below in the same request.
              const { data: cur } = await sb.from('broker_configs').select('config').eq('id', row.id).single()
              const merged = { ...(cur?.config || {}), circuitBreakerUntil: circuitBreakerArmedAt }
              await sb.from('broker_configs').update({ config: merged }).eq('id', row.id)
            } catch (e: any) {
              console.error('[mt5-sync] failed to persist circuitBreakerUntil:', e?.message)
            }
          }
        }
      }
    }

    // ── Merge EA-pushed price data ────────────────────────────────────────
    // prices: { EURUSD: { bid, ask }, GBPUSD: { bid, ask }, ... }
    const now = new Date().toISOString()
    let latestPrices: Record<string, any> = row.config?.latestPrices || {}
    if (prices && typeof prices === 'object') {
      for (const [sym, p] of Object.entries(prices as Record<string, any>)) {
        if (typeof p?.bid === 'number' && typeof p?.ask === 'number') {
          latestPrices[sym] = { bid: p.bid, ask: p.ask, updatedAt: now }
        }
      }
    }

    // ── Merge EA-pushed candle data ───────────────────────────────────────
    // EA sends: { M5: { EURUSD: [...], XAGUSD: [...] }, M15: { ... }, H1: { ... }, H4: { ... } }
    // Legacy format (never used by this EA): { timeframe: "M5", data: { EURUSD: [...] } }
    let candleCache: Record<string, any> = row.config?.candleCache || {}
    if (candles && typeof candles === 'object') {
      const KNOWN_TFS = new Set(['M1','M3','M5','M15','M30','H1','H4','D1','W1'])
      if (candles.timeframe && candles.data && typeof candles.data === 'object') {
        // Legacy single-TF format
        const tf = String(candles.timeframe)
        for (const [sym, bars] of Object.entries(candles.data as Record<string, any>)) {
          if (Array.isArray(bars) && bars.length >= 10) {
            candleCache[`${sym}_${tf}`] = { candles: bars, updatedAt: now }
          }
        }
      } else {
        // EA multi-TF format: top-level keys are timeframe names
        for (const [tf, tfData] of Object.entries(candles as Record<string, any>)) {
          if (!KNOWN_TFS.has(tf) || typeof tfData !== 'object') continue
          for (const [sym, bars] of Object.entries(tfData as Record<string, any>)) {
            if (Array.isArray(bars) && bars.length >= 10) {
              candleCache[`${sym}_${tf}`] = { candles: bars, updatedAt: now }
            }
          }
        }
      }
    }

    // ── Post-entry trade management ───────────────────────────────────────
    // Runs on every EA sync — applies break-even, trailing stop, time exit,
    // and profit-decay exit rules to all open positions.
    const activePositions = Array.isArray(openPositions)
      ? openPositions
      : (row.config?.openPositions || [])
    let tradeState: Record<string, any> = row.config?.tradeState || {}

    if (activePositions.length > 0) {
      const { tradeState: nextState, commands, log, riskEvents } = manageTrades(
        activePositions,
        latestPrices,
        candleCache,
        tradeState,
        // Fix 8 — pass live balance + user's riskPct so trade-manager can enforce
        // the absolute USD cap (= balance × riskPct/100 × 2).
        { accountBalance: balance, riskPct },
      )
      tradeState = nextState
      for (const line of log) console.log(line)

      // Fix 8 — fire Telegram alerts for any hard-cap or emergency-1.5R breach.
      // Non-blocking; failures are logged inside lib/telegram.
      // Profit-reversal events route to alertProfitReversal (different message).
      for (const evt of riskEvents) {
        if (evt.reason === 'profit-reversal') {
          alertProfitReversal({
            pair: evt.pair, ticket: evt.ticket, pl: evt.pl, peak: evt.peak ?? evt.pl,
          }).catch(() => {})
        } else {
          alertRiskBreach({
            pair: evt.pair, ticket: evt.ticket, pl: evt.pl, cap: evt.cap, reason: evt.reason,
          }).catch(() => {})
        }
      }

      for (const cmd of commands) {
        // Dedup: don't queue the same action for the same ticket twice
        const duplicate = pendingOrders.some(
          (o: any) => o.type === cmd.type && o.symbol === cmd.symbol &&
                      (!cmd.ticket || o.ticket === cmd.ticket)
        )
        if (!duplicate) pendingOrders.push(cmd)
      }

      if (commands.length > 0) {
        console.log(`[mt5-sync] trade-manager issued ${commands.length} command(s): ${commands.map(c => `${c.type}:${c.symbol}`).join(' ')}`)
      }
    }

    // ── Rate-limited signal labelling (every 5 min while EA is active) ───
    const lastLabelAt = row.config?.lastLabelAt
      ? new Date(row.config.lastLabelAt).getTime() : 0
    const labelDue = Date.now() - lastLabelAt > 5 * 60_000
    if (labelDue) {
      const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://forex.sybexdesigns.co.uk'
      fetch(`${appUrl}/api/scalper/label`, {
        headers: { 'x-vercel-cron': '1' },
      }).catch(() => {})
    }

    // ── Update broker config with latest balance ──────────────────────────
    const updatedConfig = {
      ...row.config,
      balance: String(balance),
      equity: String(equity ?? balance),
      currency: currency || row.config.currency || 'USD',
      login: login || row.config.login || '',
      server: server || row.config.server || '',
      updatedAt: now,
      pendingOrders,
      latestPrices,
      candleCache,
      tradeState,
      openPositions: activePositions,
      lastLabelAt: labelDue ? now : (row.config?.lastLabelAt ?? now),
    }

    const priceSymbols  = Object.keys(latestPrices)
    const candleSymbols = Object.keys(candleCache)
    const xagKeys = candleSymbols.filter(k => k.startsWith('XAGUSD'))
    console.log(`[mt5-sync] storing — prices:${priceSymbols.length} (${priceSymbols.slice(0,4).join(',')}) candleKeys:${candleSymbols.length} xag:${xagKeys.join(',') || 'NONE'}`)

    const { error: updateErr } = await sb.from('broker_configs')
      .update({ config: updatedConfig, updated_at: new Date().toISOString() })
      .eq('id', row.id)

    if (updateErr) {
      console.error('[mt5-sync] DB write failed:', updateErr.message)
      return NextResponse.json({ error: updateErr.message }, { status: 500 })
    }

    console.log('[mt5-sync] DB write OK')
    return NextResponse.json({ ok: true, prices: priceSymbols.length, candles: candleSymbols.length })
  } catch (e: any) {
    console.error('[mt5-sync] UNCAUGHT ERROR in POST:', e?.message, e?.stack?.split('\n').slice(0,3).join(' | '))
    return NextResponse.json({ error: e.message }, { status: 500 })
  }
}
