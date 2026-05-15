// lib/brokers/metaapi.adapter.ts
// MetaApi REST wrapper for MT4/MT5 accounts (FTMO, funded accounts, etc.)
// Docs: https://metaapi.cloud/docs/client/restApi/

import type { IBroker, Price, Candle, AccountSummary, OpenTrade, OrderRequest, OrderResult, CloseResult } from './interface'
import { calcStandardPositionSize, getPipValue } from './interface'

const BASE = 'https://mt-client-api-v1.agiliumtrade.agiliumtrade.ai'

interface MetaApiConfig {
  token: string       // MetaApi auth token
  accountId: string   // MT4/MT5 account ID in MetaApi
}

const TF_MAP: Record<string, string> = {
  '1m': '1m', '3m': '3m', '5m': '5m', '15m': '15m', '30m': '30m',
  '1H': '1h', '4H': '4h', '1D': '1d', 'Daily': '1d',
}

function toSymbol(pair: string) { return pair.replace('/', '') }
function fromSymbol(sym: string): string {
  // Insert / at correct position: EURUSD → EUR/USD, XAUUSD → XAU/USD
  if (sym.startsWith('XAU') || sym.startsWith('XAG') || sym.startsWith('BTC') || sym.startsWith('ETH')) {
    return sym.slice(0, 3) + '/' + sym.slice(3)
  }
  return sym.slice(0, 3) + '/' + sym.slice(3)
}

export class MetaApiBroker implements IBroker {
  name = 'MetaApi (MT4/MT5)'
  supportedPairs = ['EUR/USD', 'GBP/USD', 'USD/JPY', 'AUD/USD', 'XAU/USD', 'XAG/USD', 'USD/CAD', 'USD/CHF', 'NZD/USD', 'GBP/JPY', 'EUR/JPY']
  supportsLivePositions = true
  private token: string
  private accountId: string

  constructor(config: MetaApiConfig) {
    this.token = config.token
    this.accountId = config.accountId
  }

  private headers() {
    return { 'auth-token': this.token, 'Content-Type': 'application/json' }
  }

  private url(path: string) {
    return `${BASE}/users/current/accounts/${this.accountId}${path}`
  }

  async getPrices(pairs: string[]): Promise<Price[]> {
    const symbols = pairs.map(toSymbol).join(',')
    const res = await fetch(this.url(`/symbols/prices?symbols=${symbols}&keepSubscriptions=false`), {
      headers: this.headers()
    })
    if (!res.ok) throw new Error(`MetaApi prices: ${res.status}`)
    const data = await res.json()
    return (Array.isArray(data) ? data : []).map((d: any) => ({
      pair: fromSymbol(d.symbol),
      instrument: d.symbol,
      bid: d.bid,
      ask: d.ask,
      spread: +(d.ask - d.bid).toFixed(5),
      time: new Date().toISOString(),
    }))
  }

  async getCandles(pair: string, timeframe: string, count: number): Promise<Candle[]> {
    const sym = toSymbol(pair)
    const tf = TF_MAP[timeframe] || '1h'
    const res = await fetch(this.url(`/candles/${sym}/${tf}?limit=${count}&keepDownloadingHistory=false`), {
      headers: this.headers()
    })
    if (!res.ok) throw new Error(`MetaApi candles ${pair}: ${res.status}`)
    const data = await res.json()
    return (Array.isArray(data) ? data : []).map((c: any) => ({
      time: c.time,
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
      volume: c.tickVolume ?? 0,
    }))
  }

  async getAccountSummary(): Promise<AccountSummary> {
    const res = await fetch(this.url('/account-information'), { headers: this.headers() })
    if (!res.ok) throw new Error(`MetaApi account: ${res.status}`)
    const d = await res.json()
    return {
      balance: d.balance ?? 0,
      unrealizedPL: (d.equity ?? d.balance ?? 0) - (d.balance ?? 0),
      realizedPL: 0,
      openTradeCount: 0,
      currency: d.currency ?? 'USD',
      nav: d.equity ?? d.balance ?? 0,
    }
  }

  async getOpenTrades(): Promise<OpenTrade[]> {
    const res = await fetch(this.url('/positions'), { headers: this.headers() })
    if (!res.ok) throw new Error(`MetaApi positions: ${res.status}`)
    const data = await res.json()
    return (Array.isArray(data) ? data : []).map((p: any) => ({
      id: p.id,
      pair: fromSymbol(p.symbol),
      direction: p.type === 'POSITION_TYPE_BUY' ? 'BUY' : 'SELL',
      units: p.volume,
      lots: p.volume,
      entryPrice: p.openPrice,
      currentPrice: p.currentPrice ?? p.openPrice,
      unrealizedPL: p.unrealizedProfit ?? 0,
      takeProfitPrice: p.takeProfit,
      stopLossPrice: p.stopLoss,
      openTime: p.time,
    }))
  }

  async placeOrder(req: OrderRequest): Promise<OrderResult> {
    const sym = toSymbol(req.pair)
    const pip = getPipValue(req.pair)
    const sign = req.direction === 'BUY' ? 1 : -1
    const dp = req.pair.includes('JPY') ? 3 : req.pair.startsWith('XAU') ? 2 : 5
    const sl = +(req.currentPrice - req.stopLossPips * pip * sign).toFixed(dp)
    const tp = +(req.currentPrice + req.takeProfitPips * pip * sign).toFixed(dp)

    const body = {
      actionType: req.direction === 'BUY' ? 'ORDER_TYPE_BUY' : 'ORDER_TYPE_SELL',
      symbol: sym,
      volume: req.lots,
      stopLoss: sl,
      takeProfit: tp,
    }

    const res = await fetch(this.url('/trade'), {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(body),
    })
    const data = await res.json()
    if (!res.ok || data.error) {
      return { success: false, error: data.message || data.error || `MetaApi trade error ${res.status}` }
    }
    return {
      success: true,
      orderId: data.orderId,
      tradeId: data.positionId || data.orderId,
      filledPrice: req.currentPrice,
      tpPrice: tp,
      slPrice: sl,
    }
  }

  async closeTrade(tradeId: string): Promise<CloseResult> {
    const res = await fetch(this.url('/trade'), {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ actionType: 'POSITION_CLOSE_ID', positionId: tradeId }),
    })
    const data = await res.json()
    if (!res.ok) return { success: false, error: data.message || 'Close failed' }
    return { success: true, pl: data.profit }
  }

  calcPositionSize(balance: number, riskPct: number, slPips: number, pair: string): number {
    return calcStandardPositionSize(balance, riskPct, slPips, pair)
  }
}
