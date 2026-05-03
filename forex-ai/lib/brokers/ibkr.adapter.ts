// lib/brokers/ibkr.adapter.ts
// Interactive Brokers — IBKR Client Portal Web API
// Docs: https://interactivebrokers.github.io/cpwebapi/
// Requires: IBKR Client Portal Gateway running locally or on server
//
// Setup: Download gateway from IBKR, run it, log in via browser
// Env vars needed:
//   IBKR_GATEWAY_URL=https://localhost:5000  (local gateway)
//   IBKR_ACCOUNT_ID=Uxxxxxxxx

import type { IBroker, Price, Candle, AccountSummary, OpenTrade, OrderRequest, OrderResult, CloseResult } from './interface'
import { calcStandardPositionSize, getPipValue } from './interface'

const GATEWAY = process.env.IBKR_GATEWAY_URL || 'https://localhost:5000'
const ACCOUNT = process.env.IBKR_ACCOUNT_ID  || ''

// IBKR uses conids (contract IDs) for instruments
const PAIR_CONIDS: Record<string, number> = {
  'EUR/USD': 12087792, 'GBP/USD': 12087797, 'USD/JPY': 15016062,
  'AUD/USD': 14433401, 'USD/CAD': 15016141, 'USD/CHF': 15016144,
  'NZD/USD': 14433560, 'GBP/JPY': 12087809, 'EUR/JPY': 12087795,
  'XAU/USD': 69067924,
}

const TF_MAP: Record<string, { bar: string; period: string }> = {
  '1m':    { bar: '1 min',   period: '1 D' },
  '5m':    { bar: '5 mins',  period: '3 D' },
  '15m':   { bar: '15 mins', period: '5 D' },
  '30m':   { bar: '30 mins', period: '1 W' },
  '1H':    { bar: '1 hour',  period: '1 W' },
  '4H':    { bar: '4 hours', period: '1 M' },
  'Daily': { bar: '1 day',   period: '3 M' },
}

async function ibkrFetch(path: string, opts?: RequestInit) {
  // IBKR gateway uses self-signed cert — in production set NODE_TLS_REJECT_UNAUTHORIZED=0
  const res = await fetch(`${GATEWAY}/v1/api${path}`, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...opts?.headers },
  })
  if (!res.ok) throw new Error(`IBKR ${res.status}: ${await res.text()}`)
  return res.json()
}

export class IBKRBroker implements IBroker {
  name = 'Interactive Brokers'
  supportedPairs = Object.keys(PAIR_CONIDS)

  async getPrices(pairs: string[]): Promise<Price[]> {
    const conids = pairs.map(p => PAIR_CONIDS[p]).filter(Boolean).join(',')
    const data = await ibkrFetch(`/iserver/marketdata/snapshot?conids=${conids}&fields=31,84,86`)
    return (data || []).map((item: any) => {
      const pair = Object.keys(PAIR_CONIDS).find(k => PAIR_CONIDS[k] === item.conid) || ''
      const last = parseFloat(item['31'] || 0)
      const bid  = parseFloat(item['84'] || last)
      const ask  = parseFloat(item['86'] || last)
      return { instrument: String(item.conid), pair, bid, ask, spread: +(ask - bid).toFixed(6), time: new Date().toISOString() }
    })
  }

  async getCandles(pair: string, timeframe: string, count = 200): Promise<Candle[]> {
    const conid = PAIR_CONIDS[pair]
    if (!conid) return []
    const tf = TF_MAP[timeframe] || TF_MAP['1H']

    const data = await ibkrFetch(
      `/iserver/marketdata/history?conid=${conid}&period=${tf.period}&bar=${tf.bar}&outsideRth=false`
    )
    return (data.data || []).slice(-count).map((b: any) => ({
      time: new Date(b.t).toISOString(),
      open: b.o, high: b.h, low: b.l, close: b.c, volume: b.v || 0,
    }))
  }

  async getAccountSummary(): Promise<AccountSummary> {
    const [summary, portfolio] = await Promise.all([
      ibkrFetch(`/portfolio/${ACCOUNT}/summary`),
      ibkrFetch(`/portfolio/${ACCOUNT}/positions/0`),
    ])
    return {
      balance: summary.cashbalance?.amount || 0,
      unrealizedPL: summary.unrealizedpnl?.amount || 0,
      realizedPL: summary.realizedpnl?.amount || 0,
      openTradeCount: (portfolio || []).length,
      currency: summary.cashbalance?.currency || 'USD',
      nav: summary.netliquidation?.amount || 0,
    }
  }

  async getOpenTrades(): Promise<OpenTrade[]> {
    const positions = await ibkrFetch(`/portfolio/${ACCOUNT}/positions/0`)
    return (positions || []).filter((p: any) => p.position !== 0).map((p: any) => {
      const pair = Object.keys(PAIR_CONIDS).find(k => PAIR_CONIDS[k] === p.conid) || p.contractDesc
      return {
        id: String(p.conid),
        pair,
        direction: p.position > 0 ? 'BUY' : 'SELL',
        units: Math.abs(p.position),
        lots: +Math.abs(p.position / 100000).toFixed(4),
        entryPrice: p.avgPrice,
        currentPrice: p.mktPrice,
        unrealizedPL: p.unrealizedPnl,
        openTime: new Date().toISOString(),
      }
    })
  }

  async placeOrder(req: OrderRequest): Promise<OrderResult> {
    const conid = PAIR_CONIDS[req.pair]
    if (!conid) return { success: false, error: `Pair ${req.pair} not supported by IBKR adapter` }

    const pip = getPipValue(req.pair)
    const qty = req.lots * 100000 * (req.direction === 'BUY' ? 1 : -1)
    const tp  = req.direction === 'BUY'
      ? +(req.currentPrice + req.takeProfitPips * pip).toFixed(5)
      : +(req.currentPrice - req.takeProfitPips * pip).toFixed(5)
    const sl  = req.direction === 'BUY'
      ? +(req.currentPrice - req.stopLossPips * pip).toFixed(5)
      : +(req.currentPrice + req.stopLossPips * pip).toFixed(5)

    try {
      const data = await ibkrFetch(`/iserver/account/${ACCOUNT}/orders`, {
        method: 'POST',
        body: JSON.stringify({
          orders: [{
            conid, orderType: 'MKT', side: req.direction, quantity: Math.abs(qty),
            tif: 'GTC', outsideRth: false,
          }]
        }),
      })
      const orderId = data[0]?.order_id || data[0]?.id
      return { success: true, orderId, tradeId: orderId, filledPrice: req.currentPrice, tpPrice: tp, slPrice: sl }
    } catch (e: any) {
      return { success: false, error: e.message }
    }
  }

  async closeTrade(tradeId: string): Promise<CloseResult> {
    try {
      const positions = await this.getOpenTrades()
      const pos = positions.find(p => p.id === tradeId)
      if (!pos) return { success: false, error: 'Position not found' }

      await ibkrFetch(`/iserver/account/${ACCOUNT}/orders`, {
        method: 'POST',
        body: JSON.stringify({
          orders: [{
            conid: parseInt(tradeId), orderType: 'MKT',
            side: pos.direction === 'BUY' ? 'SELL' : 'BUY',
            quantity: pos.units, tif: 'GTC',
          }]
        }),
      })
      return { success: true, pl: pos.unrealizedPL }
    } catch (e: any) {
      return { success: false, error: e.message }
    }
  }

  calcPositionSize(balance: number, riskPct: number, slPips: number, pair: string): number {
    return calcStandardPositionSize(balance, riskPct, slPips, pair)
  }
}
