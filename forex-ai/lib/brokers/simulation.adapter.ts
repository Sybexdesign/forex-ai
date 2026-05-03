// lib/brokers/simulation.adapter.ts
// Built-in simulation broker — works with zero API keys.
// Used as fallback when no broker is configured, or for safe testing.

import type { IBroker, Price, Candle, AccountSummary, OpenTrade, OrderRequest, OrderResult, CloseResult } from './interface'
import { calcStandardPositionSize, DISPLAY_PAIRS } from './interface'

const BASE_PRICES: Record<string, number> = {
  'EUR/USD': 1.0842, 'GBP/USD': 1.2714, 'USD/JPY': 149.82,
  'AUD/USD': 0.6523, 'XAU/USD': 2318.40, 'USD/CAD': 1.3641,
  'USD/CHF': 0.9012, 'NZD/USD': 0.5981, 'GBP/JPY': 190.14,
  'EUR/JPY': 162.39, 'XAG/USD': 27.42, 'XAG_USD': 27.42,
  'BTC/USD': 62450.00, 'ETH/USD': 3218.50,
}

const _prices = { ...BASE_PRICES }
const _trades: OpenTrade[] = []
let   _balance = 10000.00
let   _tradeCounter = 1

function tickPrice(pair: string): number {
  const base = BASE_PRICES[pair] || 1.0
  const volatility = pair === 'XAU/USD' ? 0.5 : pair === 'BTC/USD' ? 150 : pair.includes('JPY') ? 0.015 : 0.0006
  _prices[pair] = +(_prices[pair] + (Math.random() - 0.499) * volatility).toFixed(
    pair.includes('JPY') ? 3 : pair === 'XAU/USD' || pair === 'XAG/USD' ? 2 : pair === 'BTC/USD' || pair === 'ETH/USD' ? 2 : 5
  )
  return _prices[pair]
}

function getSpread(pair: string): number {
  if (pair === 'XAU/USD') return 0.40
  if (pair === 'XAG/USD') return 0.03
  if (pair === 'BTC/USD') return 5.00
  if (pair === 'ETH/USD') return 1.50
  if (pair.includes('JPY')) return 0.012
  return 0.00012
}

function genHistoricalCandles(pair: string, count: number): Candle[] {
  const base = BASE_PRICES[pair] || 1.0
  let price = base
  const candles: Candle[] = []
  for (let i = 0; i < count; i++) {
    const vol = pair === 'XAU/USD' ? 2.0 : pair.includes('JPY') ? 0.08 : 0.0015
    const move = (Math.random() - 0.49) * vol
    const open = price
    price = +(price + move).toFixed(pair.includes('JPY') ? 3 : 5)
    const high = +(Math.max(open, price) + Math.random() * vol * 0.5).toFixed(5)
    const low  = +(Math.min(open, price) - Math.random() * vol * 0.5).toFixed(5)
    candles.push({
      time: new Date(Date.now() - (count - i) * 3600000).toISOString(),
      open, high, low, close: price, volume: Math.floor(Math.random() * 800) + 200,
    })
  }
  return candles
}

export class SimulationBroker implements IBroker {
  name = 'Simulation (Demo)'
  supportedPairs = DISPLAY_PAIRS

  async getPrices(pairs: string[]): Promise<Price[]> {
    return pairs.map(pair => {
      const bid = tickPrice(pair)
      const spread = getSpread(pair)
      return {
        instrument: pair.replace('/', '_'),
        pair, bid,
        ask: +(bid + spread).toFixed(pair.includes('JPY') ? 3 : 5),
        spread, time: new Date().toISOString(),
      }
    })
  }

  async getCandles(pair: string, timeframe: string, count = 200): Promise<Candle[]> {
    return genHistoricalCandles(pair, count)
  }

  async getAccountSummary(): Promise<AccountSummary> {
    const unrealizedPL = _trades.reduce((s, t) => {
      const cur = _prices[t.pair] || t.entryPrice
      const diff = t.direction === 'BUY' ? cur - t.entryPrice : t.entryPrice - cur
      return s + diff * t.lots * 100000 * 0.0001
    }, 0)
    return {
      balance: _balance,
      unrealizedPL: +unrealizedPL.toFixed(2),
      realizedPL: 0,
      openTradeCount: _trades.length,
      currency: 'USD',
      nav: +(_balance + unrealizedPL).toFixed(2),
    }
  }

  async getOpenTrades(): Promise<OpenTrade[]> {
    return _trades.map(t => ({
      ...t,
      currentPrice: _prices[t.pair] || t.entryPrice,
      unrealizedPL: (() => {
        const cur = _prices[t.pair] || t.entryPrice
        const diff = t.direction === 'BUY' ? cur - t.entryPrice : t.entryPrice - cur
        return +(diff * t.lots * 100000 * 0.0001 * 10).toFixed(2)
      })(),
    }))
  }

  async placeOrder(req: OrderRequest): Promise<OrderResult> {
    const pip = req.pair.includes('JPY') ? 0.01 : req.pair === 'XAU/USD' ? 0.1 : 0.0001
    const tp = req.direction === 'BUY'
      ? +(req.currentPrice + req.takeProfitPips * pip).toFixed(5)
      : +(req.currentPrice - req.takeProfitPips * pip).toFixed(5)
    const sl = req.direction === 'BUY'
      ? +(req.currentPrice - req.stopLossPips * pip).toFixed(5)
      : +(req.currentPrice + req.stopLossPips * pip).toFixed(5)

    const tradeId = `SIM_${Date.now()}_${_tradeCounter++}`
    _trades.push({
      id: tradeId, pair: req.pair, direction: req.direction,
      units: req.lots * 100000, lots: req.lots,
      entryPrice: req.currentPrice, currentPrice: req.currentPrice,
      unrealizedPL: 0,
      takeProfitPrice: tp, stopLossPrice: sl,
      openTime: new Date().toISOString(),
    })

    return { success: true, orderId: tradeId, tradeId, filledPrice: req.currentPrice, tpPrice: tp, slPrice: sl }
  }

  async closeTrade(tradeId: string): Promise<CloseResult> {
    const idx = _trades.findIndex(t => t.id === tradeId)
    if (idx === -1) return { success: false, error: 'Trade not found' }

    const trade = _trades[idx]
    const cur = _prices[trade.pair] || trade.entryPrice
    const pip = trade.pair.includes('JPY') ? 0.01 : 0.0001
    const diff = trade.direction === 'BUY' ? cur - trade.entryPrice : trade.entryPrice - cur
    const pl = +(diff / pip * trade.lots * 10).toFixed(2)

    _trades.splice(idx, 1)
    _balance = +(_balance + pl).toFixed(2)

    return { success: true, pl }
  }

  calcPositionSize(balance: number, riskPct: number, slPips: number, pair: string): number {
    return calcStandardPositionSize(balance, riskPct, slPips, pair)
  }
}
