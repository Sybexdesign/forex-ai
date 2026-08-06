// lib/brokers/mt5direct.adapter.ts
// Receives balance, prices and candles pushed by the MT5 Expert Advisor via webhook.
// Market data is served from the EA's live push — no OANDA/Capital dependency.
// OANDA → Capital → [] are used ONLY as fallbacks when the EA data is stale or absent.

import type { IBroker, Price, Candle, AccountSummary, OpenTrade, OrderRequest, OrderResult, CloseResult } from './interface'
import { calcStandardPositionSize, getPipValue } from './interface'
import { getAdminClient } from '@/lib/supabase'
import { MAX_LOTS } from '@/lib/trade-levels'


// EA pushes compact candle objects: { t, o, h, l, c, v }
interface EACandle { t: number; o: number; h: number; l: number; c: number; v: number }

interface CandleCacheEntry {
  candles:   EACandle[]
  updatedAt: string   // ISO timestamp of when the EA last pushed this set
}

interface Mt5DirectConfig {
  webhookToken?:  string
  balance?:       string
  equity?:        string
  currency?:      string
  login?:         string
  server?:        string
  updatedAt?:     string
  _configId?:     string
  // Live price data pushed by EA: { EURUSD: { bid, ask, updatedAt } }
  latestPrices?:  Record<string, { bid: number; ask: number; updatedAt: string }>
  // Candle cache pushed by EA: { "EURUSD_M5": { candles: [...], updatedAt } }
  candleCache?:   Record<string, CandleCacheEntry>
  // Open positions pushed by EA: [{ticket, symbol, type, lots, openPrice, sl, tp, profit}]
  openPositions?: any[]
}

// Map our timeframe strings to MT5 suffix used as cache keys
const TF_KEY: Record<string, string> = {
  '1m': 'M1', '3m': 'M3', '5m': 'M5', '15m': 'M15', '30m': 'M30',
  '1H': 'H1', '4H': 'H4', 'Daily': 'D1', 'Weekly': 'W1',
}

// How stale (ms) we allow EA price/candle data to be before falling through to OANDA/Capital
const PRICE_TTL   = 2 * 60_000   // 2 minutes — EA syncs every 30s; if 2 min stale, EA is likely down
const CANDLE_TTL  = 4 * 60_000   // 4 minutes — M5 bar is 5 min; reject data older than one bar
const BALANCE_TTL = 5 * 60_000   // 5 minutes — less critical for risk guards

export class Mt5DirectBroker implements IBroker {
  name = 'MT5 Direct'
  supportedPairs = ['EUR/USD', 'GBP/USD', 'USD/JPY', 'AUD/USD', 'XAU/USD', 'XAG/USD', 'USD/CAD', 'USD/CHF', 'NZD/USD', 'GBP/JPY', 'EUR/JPY']
  private config: Mt5DirectConfig

  constructor(config: Mt5DirectConfig) {
    this.config = config
  }

  async getAccountSummary(): Promise<AccountSummary> {
    const eaStale = !this.config.updatedAt ||
      (Date.now() - new Date(this.config.updatedAt).getTime()) > BALANCE_TTL

    const balance = eaStale ? 0 : parseFloat(this.config.balance || '0')
    const equity  = eaStale ? 0 : parseFloat(this.config.equity  || String(balance))
    return {
      balance,
      unrealizedPL:   equity - balance,
      realizedPL:     0,
      openTradeCount: 0,
      currency:       this.config.currency || 'USD',
      nav:            equity,
      // Surface the EA's last-push timestamp so callers can detect a disconnected EA.
      // EA pushes balance every ~30s; anything older than BALANCE_TTL (5 min) means
      // the EA is likely down or MT5 is closed and trades MUST NOT be placed.
      lastSyncAt:     this.config.updatedAt,
    }
  }

  async getPrices(pairs: string[]): Promise<Price[]> {
    const eaKeys = Object.keys(this.config.latestPrices || {})
    console.log(`[mt5direct] getPrices: latestPrices has ${eaKeys.length} symbols (${eaKeys.slice(0,4).join(',')})`)

    // 1. EA-pushed prices (stored in broker_configs.config.latestPrices)
    if (this.config.latestPrices && eaKeys.length > 0) {
      const now     = Date.now()
      const results: Price[] = []
      const missing: string[] = []

      for (const pair of pairs) {
        const sym    = pair.replace('/', '')
        const cached = this.config.latestPrices[sym]
        if (cached && (now - new Date(cached.updatedAt).getTime()) < PRICE_TTL) {
          results.push({
            instrument: sym, pair,
            bid:    cached.bid,
            ask:    cached.ask,
            spread: +(cached.ask - cached.bid).toFixed(6),
            time:   cached.updatedAt,
          })
        } else {
          missing.push(sym)
        }
      }

      if (results.length > 0) {
        if (missing.length > 0) {
          console.log(`[mt5direct] getPrices: EA has ${results.length}/${pairs.length} — missing: ${missing.join(',')}`)
        } else {
          console.log(`[mt5direct] getPrices: using EA live data (${results.length} pairs)`)
        }
        // Return EA prices for what we have — caller gets the best available data
        return results
      }
      console.warn('[mt5direct] getPrices: latestPrices exist but all stale or unmatched')
    }

    // 2. OANDA fallback
    try {
      const { OandaBroker } = await import('./oanda.adapter')
      const prices = await new OandaBroker().getPrices(pairs)
      if (prices.length > 0) {
        console.log('[mt5direct] getPrices: using OANDA fallback')
        return prices
      }
      console.warn('[mt5direct] getPrices: OANDA returned 0 prices')
    } catch (e: any) {
      console.warn('[mt5direct] getPrices: OANDA error —', e?.message)
    }

    // 3. Capital.com fallback
    try {
      const { CapitalBroker } = await import('./capital.adapter')
      const prices = await new CapitalBroker().getPrices(pairs)
      if (prices.length > 0) return prices
    } catch { /* already logged by Capital adapter */ }

    console.warn('[mt5direct] getPrices: all sources failed — returning []')
    return []
  }

  async getCandles(pair: string, timeframe: string, count = 200): Promise<Candle[]> {
    // 1. EA-pushed candles (stored in broker_configs.config.candleCache)
    const tfKey = TF_KEY[timeframe]
    if (tfKey && this.config.candleCache) {
      const sym    = pair.replace('/', '')
      const entry  = this.config.candleCache[`${sym}_${tfKey}`]
      if (entry && entry.candles && entry.candles.length >= 50) {
        const age = Date.now() - new Date(entry.updatedAt).getTime()
        if (age < CANDLE_TTL) {
          console.log(`[mt5direct] getCandles ${pair}/${timeframe}: using EA live data (${entry.candles.length} bars, age ${Math.round(age/1000)}s)`)
          return entry.candles.slice(-count).map(c => ({
            time:   new Date(c.t * 1000).toISOString(),
            open:   c.o, high: c.h, low: c.l, close: c.c,
            volume: c.v,
          }))
        }
      }
    }

    // 2. OANDA fallback
    try {
      const { OandaBroker } = await import('./oanda.adapter')
      const candles = await new OandaBroker().getCandles(pair, timeframe, count)
      if (candles.length >= 50) {
        console.log(`[mt5direct] getCandles ${pair}/${timeframe}: using OANDA fallback (${candles.length} bars)`)
        return candles
      }
      console.warn(`[mt5direct] getCandles ${pair}/${timeframe}: OANDA returned ${candles.length} bars`)
    } catch (e: any) {
      console.warn(`[mt5direct] getCandles ${pair}/${timeframe}: OANDA error — ${e?.message}`)
    }

    // 3. Capital.com fallback
    try {
      const { CapitalBroker } = await import('./capital.adapter')
      const candles = await new CapitalBroker().getCandles(pair, timeframe, count)
      if (candles.length >= 50) return candles
    } catch { /* already logged by Capital adapter */ }

    console.warn(`[mt5direct] getCandles ${pair}/${timeframe}: all sources failed — returning []`)
    return []
  }

  async getOpenTrades(): Promise<OpenTrade[]> {
    const positions: any[] = this.config.openPositions || []
    return positions.map(p => {
      const sym: string = p.symbol || ''
      const pair = sym.length === 6 ? `${sym.slice(0, 3)}/${sym.slice(3)}` : sym
      return {
        id:              String(p.ticket),
        pair,
        direction:       (p.type === 'BUY' ? 'BUY' : 'SELL') as 'BUY' | 'SELL',
        units:           Math.round((p.lots || 0) * 100000),
        lots:            p.lots || 0,
        entryPrice:      p.openPrice || 0,
        currentPrice:    p.openPrice || 0,
        unrealizedPL:    p.profit   || 0,
        takeProfitPrice: p.tp       || undefined,
        stopLossPrice:   p.sl       || undefined,
        openTime:        this.config.updatedAt || new Date().toISOString(),
      }
    })
  }

  async placeOrder(req: OrderRequest): Promise<OrderResult> {
    if (!this.config._configId) {
      return { success: false, error: 'MT5 Direct: missing _configId — cannot queue order' }
    }

    // Hard lot ceiling — execution-layer backstop. Even if the frontend or the
    // orders route somehow sends an oversized lot (bug, race, stale state), the
    // adapter refuses to queue it. MAX_LOTS is the same config-driven constant
    // the position-size calculator and the MT5 EA enforce, so all layers agree.
    if (req.lots > MAX_LOTS) {
      console.warn(`[mt5direct] BLOCKED ${req.pair} ${req.direction} — lots ${req.lots} exceeds ceiling ${MAX_LOTS}`)
      return {
        success: false,
        error: `MT5 Direct: order of ${req.lots} lots exceeds the ${MAX_LOTS}-lot ceiling — rejected at the execution layer.`,
      }
    }

    const orderId  = crypto.randomUUID()

    const pip      = getPipValue(req.pair)
    const sign     = req.direction === 'BUY' ? 1 : -1
    const dp       = req.pair.includes('JPY') ? 3 : req.pair.startsWith('XA') ? 2 : 5

    // Re-anchor SL/TP to the EA's live bid/ask when available and FRESH. The
    // signal-time `req.currentPrice` can drift while the order sits in the
    // pendingOrders queue (EA polls every 2s; data sync every 10s). On volatile
    // instruments (XAU) a 25-pip SL anchored to a stale signal price can land
    // on the wrong side of the broker's current quote → retcode 10013/10016.
    // Freshness gate: 15s (1.5× EA sync). Beyond that we trust the signal price
    // rather than risk a worse anchor. Symbol key in latestPrices has no slash.
    const sym      = req.pair.replace('/', '')
    const live     = this.config?.latestPrices?.[sym]
    const liveAgeMs = live?.updatedAt ? Date.now() - new Date(live.updatedAt).getTime() : Infinity

    // Hard block on a stale EA quote for this symbol. The EA anchors OrderSend
    // to SymbolInfoDouble, which returns 0 when the terminal can't price the
    // symbol (wrong name/suffix, not in Market Watch) → retcode 10013. A feed
    // that streams for other symbols but not this one means the order is
    // guaranteed to be rejected EA-side, so fail fast with a diagnosable error.
    const MAX_QUOTE_AGE_MS = 2 * 60_000
    if (liveAgeMs > MAX_QUOTE_AGE_MS) {
      const ageStr = liveAgeMs === Infinity
        ? 'never received'
        : `${Math.round(liveAgeMs / 60_000)} min old`
      console.warn(`[mt5direct] BLOCKED ${req.pair} ${req.direction} — EA quote for ${sym} is ${ageStr}`)
      return {
        success: false,
        error: `MT5 Direct: EA price feed for ${sym} is stale (${ageStr}) — the EA cannot price this symbol. Check MT5 is connected, ${sym} exists in Market Watch, and the EA SymbolSuffix input matches the broker's symbol naming.`,
      }
    }

    const useLive  = !!live && liveAgeMs < 15_000 && live.bid > 0 && live.ask > 0
    const anchor   = useLive
      ? (req.direction === 'BUY' ? live!.ask : live!.bid)
      : req.currentPrice
    if (useLive) {
      const drift = Math.abs(anchor - req.currentPrice).toFixed(dp)
      console.log(`[mt5direct] ${req.pair} ${req.direction} SL/TP anchored to live ${req.direction === 'BUY' ? 'ask' : 'bid'}=${anchor} (signal was ${req.currentPrice}, drift ${drift}, age ${liveAgeMs}ms)`)
    } else {
      console.warn(`[mt5direct] ${req.pair} ${req.direction} no fresh live price (age ${liveAgeMs === Infinity ? 'n/a' : liveAgeMs+'ms'}) — anchoring SL/TP to signal price ${req.currentPrice}`)
    }
    const slPrice  = +(anchor - req.stopLossPips * pip * sign).toFixed(dp)
    const tpPrice  = +(anchor + req.takeProfitPips * pip * sign).toFixed(dp)

    const newOrder = {
      id:        orderId,
      symbol:    req.pair.replace('/', ''),
      direction: req.direction,
      lots:      req.lots,
      slPrice,
      tpPrice,
      createdAt: new Date().toISOString(),
      expiresAt: Math.floor(Date.now() / 1000) + 600,  // 10-min window (EA polls every 2s)
    }

    try {
      const sb = getAdminClient()
      // Use atomic RPC to append order — prevents race condition where two simultaneous
      // requests read the same pendingOrders array and one overwrites the other's entry.
      const { error } = await sb.rpc('append_pending_order', {
        p_config_id: this.config._configId,
        p_order: newOrder,
      })
      if (error) throw new Error(error.message)

      return { success: true, orderId, tradeId: orderId, filledPrice: anchor, tpPrice, slPrice }
    } catch (e: any) {
      return { success: false, error: `Failed to queue order: ${e.message}` }
    }
  }

  async closeTrade(tradeId: string): Promise<CloseResult> {
    if (!this.config._configId) {
      return { success: false, error: 'MT5 Direct: missing _configId — cannot queue close command' }
    }

    try {
      const sb = getAdminClient()

      // Resolve the trade's pair → MT5 symbol (strip slash)
      let symbol = ''
      const { data: row } = await sb
        .from('broker_configs')
        .select('user_id')
        .eq('id', this.config._configId)
        .single()

      if (row?.user_id) {
        const { data: trade } = await sb
          .from('trades')
          .select('pair')
          .eq('user_id', row.user_id)
          .or(`oanda_trade_id.eq.${tradeId},id.eq.${tradeId}`)
          .maybeSingle()
        if (trade?.pair) symbol = trade.pair.replace('/', '')
      }

      const closeCommand = {
        id:        crypto.randomUUID(),
        type:      'close',
        symbol,
        createdAt: new Date().toISOString(),
        expiresAt: Math.floor(Date.now() / 1000) + 600,
      }

      // Use atomic RPC to append — avoids read-modify-write race with EA PUSH
      // which also updates broker_configs.config (including pendingOrders).
      const { error } = await sb.rpc('append_pending_order', {
        p_config_id: this.config._configId,
        p_order:     closeCommand,
      })
      if (error) throw new Error(error.message)

      return { success: true }
    } catch (e: any) {
      return { success: false, error: `Failed to queue close: ${e.message}` }
    }
  }

  calcPositionSize(balance: number, riskPct: number, slPips: number, pair: string): number {
    return calcStandardPositionSize(balance, riskPct, slPips, pair)
  }
}
