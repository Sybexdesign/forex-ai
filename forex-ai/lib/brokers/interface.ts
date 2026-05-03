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

export function getPipValue(pair: string): number {
  if (pair.includes('JPY')) return 0.01
  if (pair === 'XAU/USD') return 0.1
  if (pair.includes('XAG')) return 0.01
  return 0.0001
}

export function getPipValuePerLot(pair: string): number {
  if (pair.includes('JPY')) return 6.8
  if (pair === 'XAU/USD') return 10
  return 10
}

export function calcStandardPositionSize(
  balance: number,
  riskPct: number,
  slPips: number,
  pair: string
): number {
  const riskAmount = balance * (riskPct / 100)
  const pipValPerLot = getPipValuePerLot(pair)
  const lots = riskAmount / (slPips * pipValPerLot)
  return +Math.max(0.01, Math.min(lots, 100)).toFixed(2)
}

// ─── Timeframe map (display → broker-specific handled per adapter) ────────────

export const DISPLAY_PAIRS = [
  'EUR/USD', 'GBP/USD', 'USD/JPY', 'AUD/USD', 'XAU/USD',
  'USD/CAD', 'USD/CHF', 'NZD/USD', 'GBP/JPY', 'EUR/JPY',
  'XAG/USD', 'BTC/USD', 'ETH/USD',
]
