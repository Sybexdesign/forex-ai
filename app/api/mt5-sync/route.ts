// app/api/mt5-sync/route.ts
// Called by the MT5 Expert Advisor to push account data and receive pending orders.
// Secured by per-user webhook token — no user auth required.

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

// Convert MT5 symbol (EURUSD, EURUSDm, XAUUSD) to app pair (EUR/USD, XAU/USD)
function mt5SymbolToPair(sym: string): string {
  const clean = sym.replace(/[^A-Z]/gi, '').toUpperCase().slice(0, 6)
  return clean.slice(0, 3) + '/' + clean.slice(3)
}

function serviceClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } }
  )
}

export async function GET(req: NextRequest) {
  try {
    const token = req.nextUrl.searchParams.get('token')
    if (!token) return NextResponse.json({ error: 'Missing token' }, { status: 400 })

    const sb = serviceClient()
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
    return NextResponse.json({ error: e.message }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  try {
    const token = req.nextUrl.searchParams.get('token')
    if (!token) return NextResponse.json({ error: 'Missing token' }, { status: 400 })

    const body = await req.json()
    const { balance, equity, currency, login, server, completedOrders, openPositions, prices, candles } = body

    if (typeof balance !== 'number') {
      return NextResponse.json({ error: 'balance must be a number' }, { status: 400 })
    }

    const sb = serviceClient()

    // Find broker_config row with this webhook token
    const { data: rows, error } = await sb
      .from('broker_configs')
      .select('id, user_id, config')
      .in('broker_type', ['mt5direct', 'exness'])

    if (error) return NextResponse.json({ error: error.message }, { status: 500 })

    const row = (rows || []).find((r: any) => r.config?.webhookToken === token)
    if (!row) return NextResponse.json({ error: 'Invalid token' }, { status: 401 })

    const userId = row.user_id

    // ── Process completed orders ──────────────────────────────────────────
    let pendingOrders: any[] = row.config?.pendingOrders || []
    if (Array.isArray(completedOrders) && completedOrders.length > 0) {
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

    // ── Process EA-reported open positions (if EA sends them) ─────────────
    // EA can optionally send openPositions: [{ticket, symbol, type, lots, openPrice, sl, tp, profit}]
    // We sync these back to our trades table so P/L is live
    if (Array.isArray(openPositions) && openPositions.length > 0 && userId) {
      for (const pos of openPositions) {
        // Only update unrealized P/L — don't change result or prices
        try {
          await sb.from('trades')
            .update({ unrealized_pl: pos.profit ?? 0 })
            .eq('user_id', userId)
            .eq('result', 'OPEN')
            .eq('pair', mt5SymbolToPair(pos.symbol || ''))
        } catch { /* ignore */ }
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
    // candles: { timeframe: "M5", data: { EURUSD: [{t,o,h,l,c,v},...], GBPUSD: [...] } }
    let candleCache: Record<string, any> = row.config?.candleCache || {}
    if (candles?.timeframe && candles?.data && typeof candles.data === 'object') {
      const tf = String(candles.timeframe)
      for (const [sym, bars] of Object.entries(candles.data as Record<string, any>)) {
        if (Array.isArray(bars) && bars.length >= 10) {
          candleCache[`${sym}_${tf}`] = { candles: bars, updatedAt: now }
        }
      }
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
    }

    await sb.from('broker_configs')
      .update({ config: updatedConfig, updated_at: new Date().toISOString() })
      .eq('id', row.id)

    return NextResponse.json({ ok: true })
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 })
  }
}
