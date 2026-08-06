// lib/brokers/interface.ts
// Universal broker interface — every adapter implements this contract.
// Adding a new broker = create a new file that satisfies IBroker.

export interface Price {
  pair: string
  instrument: string
  bid: number
  ask: number
  spread: number
  time: string
}

export interface Candle {
  time: string
  open: number
  high: number
  low: number
  close: number
  volume: number
}

export interface AccountSummary {
  balance: number
  unrealizedPL: number
  realizedPL: number
  openTradeCount: number
  currency: string
  nav: number
  /**
   * ISO timestamp of the most recent broker-side data push that produced this balance.
   * Set by adapters whose balance is pushed asynchronously (e.g. MT5 Direct EA webhook).
   * Live-API adapters (OANDA, Capital) may omit this — the balance is always fresh.
   * Callers can use it to detect a disconnected source and block trading on stale data.
   */
  lastSyncAt?: string
}

export interface OpenTrade {
  id: string
  pair: string
  direction: 'BUY' | 'SELL'
  units: number
  lots: number
  entryPrice: number
  currentPrice: number
  unrealizedPL: number
  takeProfitPrice?: number
  stopLossPrice?: number
  openTime: string
}

export interface OrderRequest {
  pair: string
  direction: 'BUY' | 'SELL'
  lots: number
  takeProfitPips: number
  stopLossPips: number
  currentPrice: number
}

export interface OrderResult {
  success: boolean
  orderId?: string
  tradeId?: string
  filledPrice?: number
  tpPrice?: number
  slPrice?: number
  error?: string
}

export interface CloseResult {
  success: boolean
  pl?: number
  error?: string
}

// ─── The contract every broker adapter must implement ─────────────────────────

export interface IBroker {
  /** Human-readable broker name */
  name: string

  /** Supported currency pairs in display format (e.g. "EUR/USD") */
  supportedPairs: string[]

  /**
   * True only for brokers whose getOpenTrades() returns real live positions
   * from the server. False for webhook-based brokers (MT5Direct) and
   * simulation — their getOpenTrades() always returns [] so we must NOT use
   * the result to auto-close DB trades.
   */
  supportsLivePositions?: boolean

  /** Get live bid/ask prices for requested pairs */
  getPrices(pairs: string[]): Promise<Price[]>

  /** Get OHLC candle data for a pair and timeframe */
  getCandles(pair: string, timeframe: string, count: number): Promise<Candle[]>

  /** Get account balance, NAV, P/L summary */
  getAccountSummary(): Promise<AccountSummary>

  /** Get all currently open trades/positions */
  getOpenTrades(): Promise<OpenTrade[]>

  /** Place a market order with TP and SL */
  placeOrder(req: OrderRequest): Promise<OrderResult>

  /** Close an open trade by its broker-specific ID */
  closeTrade(tradeId: string): Promise<CloseResult>

  /** Calculate position size from account balance and risk settings */
  calcPositionSize(balance: number, riskPct: number, slPips: number, pair: string): number
}

// ─── Pip value helper (shared across brokers) ─────────────────────────────────

import { isIndex } from '@/lib/instruments'
import { MAX_LOTS } from '@/lib/trade-levels'


export function getPipValue(pair: string): number {
  if (isIndex(pair))          return 1.0   // 1 point per index
  if (pair.startsWith('BCO')) return 0.01  // oil: 1 cent
  if (pair.includes('JPY'))   return 0.01
  if (pair === 'XAU/USD')     return 0.1
  if (pair.includes('XAG'))   return 0.01
  return 0.0001
}

export function getPipValuePerLot(pair: string): number {
  if (isIndex(pair))          return 1.0
  if (pair.startsWith('BCO')) return 10
  if (pair.includes('JPY'))   return 6.8
  if (pair === 'XAU/USD')     return 10
  if (pair === 'XAG/USD')     return 50
  if (pair === 'BTC/USD')     return 1
  if (pair === 'ETH/USD')     return 1
  return 10
}

export function calcStandardPositionSize(
  balance: number,
  riskPct: number,
  slPips: number,
  pair: string
): number {
  // Guard: slPips=0 causes division-by-zero → NaN → order with no stop loss
  if (!slPips || slPips <= 0) return 0
  const riskAmount = balance * (riskPct / 100)
  const pipValPerLot = getPipValuePerLot(pair)
  if (!pipValPerLot || pipValPerLot <= 0) return 0
  const lots = riskAmount / (slPips * pipValPerLot)
  if (!isFinite(lots) || isNaN(lots)) return 0
  // Hard lot ceiling — MAX_LOTS (10) is the config-driven backstop shared with
  // the orders route, the MT5 Direct adapter, and the MT5 EA. Previously a
  // hardcoded 100 here could drift from the UI/EA bounds; now all layers read
  // the same constant so they can't disagree.
  return +Math.max(0.01, Math.min(lots, MAX_LOTS)).toFixed(2)
}


// ─── Timeframe map (display → broker-specific handled per adapter) ────────────

export const DISPLAY_PAIRS = [
  // Majors
  'EUR/USD', 'GBP/USD', 'USD/JPY', 'AUD/USD', 'NZD/USD',
  'USD/CAD', 'USD/CHF', 'XAU/USD',
  // Crosses
  'EUR/JPY', 'GBP/JPY', 'EUR/AUD', 'EUR/CAD', 'EUR/NZD', 'EUR/GBP',
  'GBP/AUD', 'GBP/CAD', 'GBP/NZD',
  'AUD/JPY', 'AUD/NZD', 'CAD/JPY', 'NZD/JPY', 'CHF/JPY',
  // Commodities
  'XAG/USD', 'BCO/USD',
  // Indices
  'SPX500', 'NAS100', 'UK100', 'GER40', 'JP225',
  // Crypto (simulation only)
  'BTC/USD', 'ETH/USD',
]
