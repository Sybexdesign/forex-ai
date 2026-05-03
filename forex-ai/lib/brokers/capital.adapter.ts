// lib/brokers/capital.adapter.ts
// Capital.com — commission-free, forex + stocks + crypto + indices
// Docs: https://open-api.capital.com
// Demo account: https://capital.com (free, no deposit)
//
// Env vars needed:
//   CAPITAL_API_KEY=your_api_key
//   CAPITAL_IDENTIFIER=your_account_email
//   CAPITAL_PASSWORD=your_account_password
//   CAPITAL_BASE_URL=https://demo-api-capital.backend.currency.com/api  (demo)
//                  =https://api-capital.backend.currency.com/api         (live)

import type { IBroker, Price, Candle, AccountSummary, OpenTrade, OrderRequest, OrderResult, CloseResult } from './interface'
import { calcStandardPositionSize, getPipValue } from './interface'

const BASE_URL    = process.env.CAPITAL_BASE_URL    || 'https://demo-api-capital.backend.currency.com/api'
const API_KEY     = process.env.CAPITAL_API_KEY     || ''
const IDENTIFIER  = process.env.CAPITAL_IDENTIFIER  || ''
const PASSWORD    = process.env.CAPITAL_PASSWORD    || ''

// Capital.com uses epic codes for instruments
const PAIR_TO_EPIC: Record<string, string> = {
  'EUR/USD': 'CS.D.EURUSD.MINI.IP',
  'GBP/USD': 'CS.D.GBPUSD.MINI.IP',
  'USD/JPY': 'CS.D.USDJPY.MINI.IP',
  'AUD/USD': 'CS.D.AUDUSD.MINI.IP',
  'USD/CAD': 'CS.D.USDCAD.MINI.IP',
  'USD/CHF': 'CS.D.USDCHF.MINI.IP',
  'NZD/USD': 'CS.D.NZDUSD.MINI.IP',
  'GBP/JPY': 'CS.D.GBPJPY.MINI.IP',
  'EUR/JPY': 'CS.D.EURJPY.MINI.IP',
  'XAU/USD': 'CS.D.XAUUSD.MINI.IP',
  'XAG/USD': 'CS.D.XAGUSD.MINI.IP',
  'BTC/USD': 'CS.D.BITCOIN.TODAY.IP',
  'ETH/USD': 'CS.D.ETHUSD.TODAY.IP',
}

const TF_MAP: Record<string, string> = {
  '1m': 'MINUTE', '5m': 'MINUTE_5', '15m': 'MINUTE_15', '30m': 'MINUTE_30',
  '1H': 'HOUR', '4H': 'HOUR_4', 'Daily': 'DAY', 'Weekly': 'WEEK',
}

let _sessionToken: string | null = null
let _cst: string | null = null

async function getSession() {
  if (_sessionToken && _cst) return { token: _sessionToken, cst: _cst }

  const res = await fetch(`${BASE_URL}/v1/session`, {
    method: 'POST',
    headers: { 'X-CAP-API-KEY': API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ identifier: IDENTIFIER, password: PASSWORD, encryptedPassword: false }),
  })
  if (!res.ok) throw new Error(`Capital.com auth failed: ${await res.text()}`)
  _sessionToken = res.headers.get('X-SECURITY-TOKEN') || ''
  _cst = res.headers.get('CST') || ''
  return { token: _sessionToken, cst: _cst }
}

async function capitalFetch(path: string, opts?: RequestInit) {
  const { token, cst } = await getSession()
  const res = await fetch(`${BASE_URL}${path}`, {
    ...opts,
    headers: {
      'X-SECURITY-TOKEN': token,
      'CST': cst,
      'Content-Type': 'application/json',
      ...opts?.headers,
    },
  })
  if (!res.ok) {
    _sessionToken = null; _cst = null // reset session on error
    throw new Error(`Capital.com ${res.status}: ${await res.text()}`)
  }
  return res.json()
}

export class CapitalBroker implements IBroker {
  name = 'Capital.com'
  supportedPairs = Object.keys(PAIR_TO_EPIC)

  async getPrices(pairs: string[]): Promise<Price[]> {
    const results: Price[] = []
    // Capital.com prices one instrument at a time
    for (const pair of pairs) {
      try {
        const epic = PAIR_TO_EPIC[pair]
        if (!epic) continue
        const data = await capitalFetch(`/v1/markets/${epic}`)
        const snap = data.snapshot
        if (snap) {
          results.push({
            instrument: epic, pair,
            bid: snap.bid, ask: snap.offer,
            spread: +(snap.offer - snap.bid).toFixed(6),
            time: new Date().toISOString(),
          })
        }
      } catch { /* skip failed pair */ }
    }
    return results
  }

  async getCandles(pair: string, timeframe: string, count = 200): Promise<Candle[]> {
    const epic = PAIR_TO_EPIC[pair]
    if (!epic) return []
    const resolution = TF_MAP[timeframe] || 'HOUR'
    const data = await capitalFetch(`/v1/prices/${epic}?resolution=${resolution}&max=${count}`)
    return (data.prices || []).map((p: any) => ({
      time: p.snapshotTimeUTC,
      open: p.openPrice.mid,
      high: p.highPrice.mid,
      low: p.lowPrice.mid,
      close: p.closePrice.mid,
      volume: p.lastTradedVolume || 0,
    }))
  }

  async getAccountSummary(): Promise<AccountSummary> {
    const data = await capitalFetch('/v1/accounts')
    const account = data.accounts?.[0]
    return {
      balance: account?.balance?.balance || 0,
      unrealizedPL: account?.balance?.profitLoss || 0,
      realizedPL: 0,
      openTradeCount: 0,
      currency: account?.currency || 'USD',
      nav: account?.balance?.value || 0,
    }
  }

  async getOpenTrades(): Promise<OpenTrade[]> {
    const data = await capitalFetch('/v1/positions')
    return (data.positions || []).map((p: any) => {
      const pos = p.position
      const market = p.market
      const pair = Object.keys(PAIR_TO_EPIC).find(k => PAIR_TO_EPIC[k] === market.epic) || market.epic
      return {
        id: pos.dealId,
        pair,
        direction: pos.direction === 'BUY' ? 'BUY' : 'SELL',
        units: pos.size * 100000,
        lots: pos.size,
        entryPrice: pos.openLevel,
        currentPrice: market.bid,
        unrealizedPL: pos.upl || 0,
        stopLossPrice: pos.stopLevel,
        openTime: pos.createdDateUTC,
      }
    })
  }

  async placeOrder(req: OrderRequest): Promise<OrderResult> {
    const epic = PAIR_TO_EPIC[req.pair]
    if (!epic) return { success: false, error: `Pair ${req.pair} not supported` }

    const pip = getPipValue(req.pair)
    const tp = req.direction === 'BUY'
      ? +(req.currentPrice + req.takeProfitPips * pip).toFixed(5)
      : +(req.currentPrice - req.takeProfitPips * pip).toFixed(5)
    const sl = req.direction === 'BUY'
      ? +(req.currentPrice - req.stopLossPips * pip).toFixed(5)
      : +(req.currentPrice + req.stopLossPips * pip).toFixed(5)

    try {
      const data = await capitalFetch('/v1/positions', {
        method: 'POST',
        body: JSON.stringify({
          epic, direction: req.direction,
          size: req.lots, guaranteedStop: false,
          profitLevel: tp, stopLevel: sl,
        }),
      })
      return {
        success: true,
        tradeId: data.dealReference,
        orderId: data.dealReference,
        filledPrice: req.currentPrice,
        tpPrice: tp, slPrice: sl,
      }
    } catch (e: any) {
      return { success: false, error: e.message }
    }
  }

  async closeTrade(tradeId: string): Promise<CloseResult> {
    try {
      const positions = await this.getOpenTrades()
      const pos = positions.find(p => p.id === tradeId)
      if (!pos) return { success: false, error: 'Position not found' }

      await capitalFetch(`/v1/positions/${tradeId}`, {
        method: 'DELETE',
        body: JSON.stringify({ direction: pos.direction === 'BUY' ? 'SELL' : 'BUY', size: pos.lots }),
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
