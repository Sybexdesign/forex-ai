// lib/brokers/simulation.adapter.ts
// Built-in simulation broker — works with zero API keys.
// Used as fallback when no broker is configured, or for safe testing.

import type { IBroker, Price, Candle, AccountSummary, OpenTrade, OrderRequest, OrderResult, CloseResult } from './interface'
import { calcStandardPositionSize, DISPLAY_PAIRS } from './interface'
import { isIndex, getPairDecimalPlaces } from '@/lib/instruments'

const BASE_PRICES: Record<string, number> = {
  // Majors
  'EUR/USD': 1.1350,  'GBP/USD': 1.3450,  'USD/JPY': 145.50,
  'AUD/USD': 0.6450,  'NZD/USD': 0.5950,  'USD/CAD': 1.3750,
  'USD/CHF': 0.8900,  'XAU/USD': 4568.00,
  // Crosses
  'EUR/JPY': 165.20,  'GBP/JPY': 196.10,  'EUR/AUD': 1.7600,
  'EUR/CAD': 1.5600,  'EUR/NZD': 1.9050,  'EUR/GBP': 0.8430,
  'GBP/AUD': 2.0860,  'GBP/CAD': 1.8500,  'GBP/NZD': 2.2610,
  'AUD/JPY': 93.90,   'AUD/NZD': 1.0840,  'CAD/JPY': 105.80,
  'NZD/JPY': 86.60,   'CHF/JPY': 163.50,
  // Commodities
  'XAG/USD': 78.25,   'XAG_USD': 78.25,   'BCO/USD': 65.40,
  // Indices
  'SPX500': 5900.0,   'NAS100': 21500.0,
  'UK100': 8650.0,    'GER40': 23200.0,    'JP225': 37500.0,
  // Crypto
  'BTC/USD': 108000.00, 'ETH/USD': 2500.00,
}

const _prices = { ...BASE_PRICES }
const _trades: OpenTrade[] = []
let   _balance = 10000.00
let   _tradeCounter = 1

function getVolatility(pair: string): number {
  if (isIndex(pair))            return BASE_PRICES[pair] * 0.003  // ~0.3% per candle
  if (pair === 'BCO/USD')       return 0.30
  if (pair === 'BTC/USD')       return 150
  if (pair === 'ETH/USD')       return 8
  if (pair === 'XAU/USD')       return 0.50
  if (pair === 'XAG/USD')       return 0.06
  if (pair.includes('JPY'))     return 0.015
  return 0.0006
}

function tickPrice(pair: string): number {
  const dp = getPairDecimalPlaces(pair)
  _prices[pair] = +(_prices[pair] + (Math.random() - 0.499) * getVolatility(pair)).toFixed(dp)
  return _prices[pair]
}

function getSpread(pair: string): number {
  if (isIndex(pair))            return BASE_PRICES[pair] * 0.0001  // ~0.01% spread
  if (pair === 'BCO/USD')       return 0.04
  if (pair === 'XAU/USD')       return 0.40
  if (pair === 'XAG/USD')       return 0.03
  if (pair === 'BTC/USD')       return 5.00
  if (pair === 'ETH/USD')       return 1.50
  if (pair.includes('JPY'))     return 0.012
  return 0.00012
}

const TF_INTERVAL_MS: Record<string, number> = {
  '1m': 60_000, '3m': 3 * 60_000, '5m': 5 * 60_000, '15m': 15 * 60_000,
  '30m': 30 * 60_000, '1H': 3_600_000, '4H': 4 * 3_600_000, 'Daily': 86_400_000,
}

function genHistoricalCandles(pair: string, timeframe: string, count: number): Candle[] {
  const base = BASE_PRICES[pair] || 1.0
  const intervalMs = TF_INTERVAL_MS[timeframe] ?? 3_600_000
  const dp = getPairDecimalPlaces(pair)
  let price = base
  const candles: Candle[] = []
  for (let i = 0; i < count; i++) {
    const vol = getVolatility(pair)
    const move = (Math.random() - 0.49) * vol
    const open = price
    price = +(price + move).toFixed(dp)
    const high = +(Math.max(open, price) + Math.random() * vol * 0.5).toFixed(dp)
    const low  = +(Math.min(open, price) - Math.random() * vol * 0.5).toFixed(dp)
    candles.push({
      time: new Date(Date.now() - (count - i) * intervalMs).toISOString(),
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
      const dp = getPairDecimalPlaces(pair)
      return {
        instrument: pair.replace('/', '_'),
        pair, bid,
        ask: +(bid + spread).toFixed(dp),
        spread, time: new Date().toISOString(),
      }
    })
  }

  async getCandles(pair: string, timeframe: string, count = 200): Promise<Candle[]> {
    return genHistoricalCandles(pair, timeframe, count)
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
