// lib/brokers/alpaca.adapter.ts
// Alpaca Markets — free paper trading, stocks + forex + crypto
// Docs: https://docs.alpaca.markets
// Paper account: https://app.alpaca.markets (free, no deposit needed)
//
// Env vars needed:
//   ALPACA_API_KEY=PKXXXXXXXXXXXXXXXX
//   ALPACA_SECRET_KEY=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
//   ALPACA_BASE_URL=https://paper-api.alpaca.markets   (paper)
//                  =https://api.alpaca.markets          (live)

import type { IBroker, Price, Candle, AccountSummary, OpenTrade, OrderRequest, OrderResult, CloseResult } from './interface'
import { calcStandardPositionSize, getPipValue } from './interface'

const BASE_URL   = process.env.ALPACA_BASE_URL   || 'https://paper-api.alpaca.markets'
const DATA_URL   = 'https://data.alpaca.markets'
const API_KEY    = process.env.ALPACA_API_KEY    || ''
const SECRET_KEY = process.env.ALPACA_SECRET_KEY || ''

const HEADERS = {
  'APCA-API-KEY-ID':     API_KEY,
  'APCA-API-SECRET-KEY': SECRET_KEY,
  'Content-Type':        'application/json',
}

// Alpaca uses different symbol format for forex (no slash, add USD)
const PAIR_TO_SYMBOL: Record<string, string> = {
  'EUR/USD': 'EUR/USD', 'GBP/USD': 'GBP/USD', 'USD/JPY': 'USD/JPY',
  'AUD/USD': 'AUD/USD', 'USD/CAD': 'USD/CAD', 'USD/CHF': 'USD/CHF',
  'NZD/USD': 'NZD/USD', 'GBP/JPY': 'GBP/JPY', 'EUR/JPY': 'EUR/JPY',
  'XAU/USD': 'XAUUSD',  // gold — crypto endpoint
  'BTC/USD': 'BTCUSD',  'ETH/USD': 'ETHUSD',
}

const TF_MAP: Record<string, string> = {
  '1m': '1Min', '3m': '5Min', '5m': '5Min', '15m': '15Min', '30m': '30Min',
  '1H': '1Hour', '4H': '4Hour', 'Daily': '1Day',
}

async function tradingFetch(path: string, opts?: RequestInit) {
  const res = await fetch(`${BASE_URL}${path}`, { ...opts, headers: { ...HEADERS, ...opts?.headers } })
  if (!res.ok) throw new Error(`Alpaca ${res.status}: ${await res.text()}`)
  return res.json()
}

async function dataFetch(path: string) {
  const res = await fetch(`${DATA_URL}${path}`, { headers: HEADERS })
  if (!res.ok) throw new Error(`Alpaca data ${res.status}: ${await res.text()}`)
  return res.json()
}

export class AlpacaBroker implements IBroker {
  name = 'Alpaca Markets'
  supportedPairs = Object.keys(PAIR_TO_SYMBOL)

  async getPrices(pairs: string[]): Promise<Price[]> {
    // Use latest quotes endpoint
    const symbols = pairs.map(p => PAIR_TO_SYMBOL[p] || p).join(',')
    try {
      const data = await dataFetch(`/v2/forex/latest/quotes?currency_pairs=${symbols}`)
      return Object.entries(data.quotes || {}).map(([sym, q]: [string, any]) => {
        const pair = Object.keys(PAIR_TO_SYMBOL).find(k => PAIR_TO_SYMBOL[k] === sym) || sym
        const bid = q.bp || 0
        const ask = q.ap || 0
        return { instrument: sym, pair, bid, ask, spread: +(ask - bid).toFixed(6), time: q.t }
      })
    } catch {
      // Fallback: latest trade prices
      const results: Price[] = []
      for (const pair of pairs) {
        try {
          const sym = PAIR_TO_SYMBOL[pair]
          const d = await dataFetch(`/v2/forex/latest/rates?currency_pairs=${sym}`)
          const rate = Object.values(d.rates || {})[0] as any
          if (rate) {
            results.push({
              instrument: sym, pair,
              bid: rate.mid * 0.9999, ask: rate.mid * 1.0001,
              spread: rate.mid * 0.0002, time: new Date().toISOString(),
            })
          }
        } catch { /* skip */ }
      }
      return results
    }
  }

  async getCandles(pair: string, timeframe: string, count = 200): Promise<Candle[]> {
    const symbol = PAIR_TO_SYMBOL[pair] || pair
    const tf = TF_MAP[timeframe] || '1Hour'
    const end = new Date().toISOString()
    const start = new Date(Date.now() - count * 3600000 * 4).toISOString()

    const data = await dataFetch(
      `/v2/forex/bars?currency_pairs=${symbol}&timeframe=${tf}&start=${start}&end=${end}&limit=${count}`
    )
    const bars = data.bars?.[symbol] || []
    return bars.map((b: any) => ({
      time: b.t, open: b.o, high: b.h, low: b.l, close: b.c, volume: b.v || 0,
    }))
  }

  async getAccountSummary(): Promise<AccountSummary> {
    const account = await tradingFetch('/v2/account')
    const positions = await tradingFetch('/v2/positions')
    const unrealizedPL = positions.reduce((s: number, p: any) => s + parseFloat(p.unrealized_pl || 0), 0)
    return {
      balance: parseFloat(account.cash),
      unrealizedPL,
      realizedPL: parseFloat(account.realized_pl || '0'),
      openTradeCount: positions.length,
      currency: 'USD',
      nav: parseFloat(account.portfolio_value),
    }
  }

  async getOpenTrades(): Promise<OpenTrade[]> {
    const positions = await tradingFetch('/v2/positions')
    return positions.map((p: any) => {
      const qty = parseFloat(p.qty)
      const pair = Object.keys(PAIR_TO_SYMBOL).find(k => PAIR_TO_SYMBOL[k] === p.symbol) || p.symbol
      return {
        id: p.asset_id,
        pair,
        direction: qty > 0 ? 'BUY' : 'SELL',
        units: Math.abs(qty * 100000),
        lots: +Math.abs(qty).toFixed(4),
        entryPrice: parseFloat(p.avg_entry_price),
        currentPrice: parseFloat(p.current_price),
        unrealizedPL: parseFloat(p.unrealized_pl),
        openTime: new Date().toISOString(),
      }
    })
  }

  async placeOrder(req: OrderRequest): Promise<OrderResult> {
    const symbol = PAIR_TO_SYMBOL[req.pair] || req.pair
    const pip = getPipValue(req.pair)
    const tp = req.direction === 'BUY'
      ? +(req.currentPrice + req.takeProfitPips * pip).toFixed(5)
      : +(req.currentPrice - req.takeProfitPips * pip).toFixed(5)
    const sl = req.direction === 'BUY'
      ? +(req.currentPrice - req.stopLossPips * pip).toFixed(5)
      : +(req.currentPrice + req.stopLossPips * pip).toFixed(5)

    try {
      const body: any = {
        symbol,
        qty: req.lots.toString(),
        side: req.direction.toLowerCase(),
        type: 'market',
        time_in_force: 'gtc',
        order_class: 'bracket',
        take_profit: { limit_price: tp.toFixed(5) },
        stop_loss: { stop_price: sl.toFixed(5) },
      }
      const data = await tradingFetch('/v2/orders', { method: 'POST', body: JSON.stringify(body) })
      return {
        success: true,
        orderId: data.id,
        tradeId: data.id,
        filledPrice: parseFloat(data.filled_avg_price || req.currentPrice),
        tpPrice: tp, slPrice: sl,
      }
    } catch (e: any) {
      return { success: false, error: e.message }
    }
  }

  async closeTrade(tradeId: string): Promise<CloseResult> {
    try {
      // Get position symbol first
      const positions = await tradingFetch('/v2/positions')
      const pos = positions.find((p: any) => p.asset_id === tradeId)
      if (!pos) return { success: false, error: 'Position not found' }

      await tradingFetch(`/v2/positions/${pos.symbol}`, { method: 'DELETE' })
      return { success: true, pl: parseFloat(pos.unrealized_pl || '0') }
    } catch (e: any) {
      return { success: false, error: e.message }
    }
  }

  calcPositionSize(balance: number, riskPct: number, slPips: number, pair: string): number {
    return calcStandardPositionSize(balance, riskPct, slPips, pair)
  }
}
