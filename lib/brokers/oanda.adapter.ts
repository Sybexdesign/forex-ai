// lib/brokers/oanda.adapter.ts
import type { IBroker, Price, Candle, AccountSummary, OpenTrade, OrderRequest, OrderResult, CloseResult } from './interface'
import { calcStandardPositionSize, getPipValue } from './interface'

const BASE_URL = process.env.OANDA_BASE_URL || 'https://api-fxpractice.oanda.com'
const API_KEY  = process.env.OANDA_API_KEY  || ''
const ACCOUNT  = process.env.OANDA_ACCOUNT_ID || ''

const INSTRUMENT_MAP: Record<string, string> = {
  'EUR/USD': 'EUR_USD', 'GBP/USD': 'GBP_USD', 'USD/JPY': 'USD_JPY',
  'AUD/USD': 'AUD_USD', 'XAU/USD': 'XAU_USD', 'USD/CAD': 'USD_CAD',
  'USD/CHF': 'USD_CHF', 'NZD/USD': 'NZD_USD', 'GBP/JPY': 'GBP_JPY',
  'EUR/JPY': 'EUR_JPY', 'XAG/USD': 'XAG_USD',
}

const TF_MAP: Record<string, string> = {
  '1m': 'M1', '3m': 'M4', '5m': 'M5', '15m': 'M15', '30m': 'M30',
  '1H': 'H1', '4H': 'H4', 'Daily': 'D', 'Weekly': 'W',
}

async function fetch_(path: string, opts?: RequestInit) {
  const res = await fetch(`${BASE_URL}${path}`, {
    ...opts,
    headers: {
      'Authorization': `Bearer ${API_KEY}`,
      'Content-Type': 'application/json',
      'Accept-Datetime-Format': 'UNIX',
      ...opts?.headers,
    },
  })
  if (!res.ok) throw new Error(`OANDA ${res.status}: ${await res.text()}`)
  return res.json()
}

export class OandaBroker implements IBroker {
  name = 'OANDA'
  supportedPairs = Object.keys(INSTRUMENT_MAP)
  supportsLivePositions = true

  async getPrices(pairs: string[]): Promise<Price[]> {
    const instruments = pairs.map(p => INSTRUMENT_MAP[p] || p.replace('/', '_')).join(',')
    const data = await fetch_(`/v3/accounts/${ACCOUNT}/pricing?instruments=${instruments}`)
    return (data.prices || []).map((p: any) => {
      const bid = parseFloat(p.bids[0]?.price || 0)
      const ask = parseFloat(p.asks[0]?.price || 0)
      const pair = Object.keys(INSTRUMENT_MAP).find(k => INSTRUMENT_MAP[k] === p.instrument) || p.instrument
      return { instrument: p.instrument, pair, bid, ask, spread: +(ask - bid).toFixed(6), time: p.time }
    })
  }

  async getCandles(pair: string, timeframe: string, count = 200): Promise<Candle[]> {
    const instrument = INSTRUMENT_MAP[pair] || pair.replace('/', '_')
    const granularity = TF_MAP[timeframe] || 'H1'
    const data = await fetch_(`/v3/instruments/${instrument}/candles?count=${count}&granularity=${granularity}&price=M`)
    return (data.candles || []).filter((c: any) => c.complete).map((c: any) => ({
      time: c.time,
      open: parseFloat(c.mid.o), high: parseFloat(c.mid.h),
      low: parseFloat(c.mid.l),  close: parseFloat(c.mid.c),
      volume: c.volume,
    }))
  }

  async getAccountSummary(): Promise<AccountSummary> {
    const data = await fetch_(`/v3/accounts/${ACCOUNT}/summary`)
    const a = data.account
    return {
      balance: parseFloat(a.balance), unrealizedPL: parseFloat(a.unrealizedPL),
      realizedPL: parseFloat(a.pl), openTradeCount: parseInt(a.openTradeCount),
      currency: a.currency, nav: parseFloat(a.NAV),
    }
  }

  async getOpenTrades(): Promise<OpenTrade[]> {
    const data = await fetch_(`/v3/accounts/${ACCOUNT}/openTrades`)
    return (data.trades || []).map((t: any) => {
      const units = parseInt(t.currentUnits)
      const pair = Object.keys(INSTRUMENT_MAP).find(k => INSTRUMENT_MAP[k] === t.instrument) || t.instrument
      return {
        id: t.id, pair,
        direction: units > 0 ? 'BUY' : 'SELL',
        units: Math.abs(units), lots: +(Math.abs(units) / 100000).toFixed(4),
        entryPrice: parseFloat(t.price), currentPrice: parseFloat(t.price),
        unrealizedPL: parseFloat(t.unrealizedPL),
        takeProfitPrice: t.takeProfitOrder ? parseFloat(t.takeProfitOrder.price) : undefined,
        stopLossPrice: t.stopLossOrder ? parseFloat(t.stopLossOrder.price) : undefined,
        openTime: t.openTime,
      }
    })
  }

  async placeOrder(req: OrderRequest): Promise<OrderResult> {
    const instrument = INSTRUMENT_MAP[req.pair] || req.pair.replace('/', '_')
    const pip = getPipValue(req.pair)
    const units = Math.round(req.lots * 100000) * (req.direction === 'BUY' ? 1 : -1)
    const tp = req.direction === 'BUY'
      ? +(req.currentPrice + req.takeProfitPips * pip).toFixed(5)
      : +(req.currentPrice - req.takeProfitPips * pip).toFixed(5)
    const sl = req.direction === 'BUY'
      ? +(req.currentPrice - req.stopLossPips * pip).toFixed(5)
      : +(req.currentPrice + req.stopLossPips * pip).toFixed(5)

    try {
      const data = await fetch_(`/v3/accounts/${ACCOUNT}/orders`, {
        method: 'POST',
        body: JSON.stringify({
          order: {
            type: 'MARKET', instrument, units: units.toString(),
            takeProfitOnFill: { price: tp.toFixed(5) },
            stopLossOnFill: { price: sl.toFixed(5), timeInForce: 'GTC' },
            timeInForce: 'FOK', positionFill: 'DEFAULT',
          }
        }),
      })
      const fill = data.orderFillTransaction
      return {
        success: true, orderId: data.relatedTransactionIDs?.[0],
        tradeId: fill?.tradeOpened?.tradeID,
        filledPrice: fill ? parseFloat(fill.price) : undefined,
        tpPrice: tp, slPrice: sl,
      }
    } catch (e: any) {
      return { success: false, error: e.message }
    }
  }

  async closeTrade(tradeId: string): Promise<CloseResult> {
    try {
      const data = await fetch_(`/v3/accounts/${ACCOUNT}/trades/${tradeId}/close`, {
        method: 'PUT', body: JSON.stringify({}),
      })
      return { success: true, pl: parseFloat(data.orderFillTransaction?.pl || '0') }
    } catch (e: any) {
      return { success: false, error: e.message }
    }
  }

  calcPositionSize(balance: number, riskPct: number, slPips: number, pair: string): number {
    return calcStandardPositionSize(balance, riskPct, slPips, pair)
  }
}
