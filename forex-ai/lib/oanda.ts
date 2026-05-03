// lib/oanda.ts
// All OANDA API calls — server-side only, never expose keys to frontend

const BASE_URL = process.env.OANDA_BASE_URL || 'https://api-fxpractice.oanda.com'
const API_KEY = process.env.OANDA_API_KEY || ''
const ACCOUNT_ID = process.env.OANDA_ACCOUNT_ID || ''

const HEADERS = {
  'Authorization': `Bearer ${API_KEY}`,
  'Content-Type': 'application/json',
  'Accept-Datetime-Format': 'UNIX',
}

async function oandaFetch(path: string, options?: RequestInit) {
  const url = `${BASE_URL}${path}`
  const res = await fetch(url, { ...options, headers: { ...HEADERS, ...options?.headers } })
  if (!res.ok) {
    const err = await res.text()
    throw new Error(`OANDA ${res.status}: ${err}`)
  }
  return res.json()
}

// ─── PRICE FEED ───────────────────────────────────────────────────────────────

export const OANDA_INSTRUMENTS: Record<string, string> = {
  'EUR/USD': 'EUR_USD',
  'GBP/USD': 'GBP_USD',
  'USD/JPY': 'USD_JPY',
  'AUD/USD': 'AUD_USD',
  'XAU/USD': 'XAU_USD',
}

export interface OandaPrice {
  instrument: string
  pair: string
  bid: number
  ask: number
  spread: number
  time: string
}

export async function getLivePrices(pairs: string[]): Promise<OandaPrice[]> {
  const instruments = pairs.map(p => OANDA_INSTRUMENTS[p] || p).join(',')
  const data = await oandaFetch(
    `/v3/accounts/${ACCOUNT_ID}/pricing?instruments=${instruments}`
  )
  return (data.prices || []).map((p: any) => {
    const bid = parseFloat(p.bids[0]?.price || 0)
    const ask = parseFloat(p.asks[0]?.price || 0)
    const pairKey = Object.keys(OANDA_INSTRUMENTS).find(k => OANDA_INSTRUMENTS[k] === p.instrument) || p.instrument
    return {
      instrument: p.instrument,
      pair: pairKey,
      bid,
      ask,
      spread: +(ask - bid).toFixed(6),
      time: p.time,
    }
  })
}

// ─── CANDLE DATA ──────────────────────────────────────────────────────────────

export type Granularity = 'S5'|'S10'|'S15'|'S30'|'M1'|'M2'|'M4'|'M5'|'M10'|'M15'|'M30'|'H1'|'H2'|'H3'|'H4'|'H6'|'H8'|'H12'|'D'|'W'|'M'

const TF_MAP: Record<string, Granularity> = {
  '5m': 'M5', '15m': 'M15', '1H': 'H1', '4H': 'H4', 'Daily': 'D'
}

export interface Candle {
  time: string
  open: number
  high: number
  low: number
  close: number
  volume: number
}

export async function getCandles(
  pair: string,
  timeframe: string,
  count = 200
): Promise<Candle[]> {
  const instrument = OANDA_INSTRUMENTS[pair] || pair.replace('/', '_')
  const granularity = TF_MAP[timeframe] || 'H1'
  const data = await oandaFetch(
    `/v3/instruments/${instrument}/candles?count=${count}&granularity=${granularity}&price=M`
  )
  return (data.candles || [])
    .filter((c: any) => c.complete)
    .map((c: any) => ({
      time: c.time,
      open: parseFloat(c.mid.o),
      high: parseFloat(c.mid.h),
      low: parseFloat(c.mid.l),
      close: parseFloat(c.mid.c),
      volume: c.volume,
    }))
}

// ─── ACCOUNT SUMMARY ─────────────────────────────────────────────────────────

export interface AccountSummary {
  balance: number
  unrealizedPL: number
  realizedPL: number
  openTradeCount: number
  currency: string
  nav: number
}

export async function getAccountSummary(): Promise<AccountSummary> {
  const data = await oandaFetch(`/v3/accounts/${ACCOUNT_ID}/summary`)
  const a = data.account
  return {
    balance: parseFloat(a.balance),
    unrealizedPL: parseFloat(a.unrealizedPL),
    realizedPL: parseFloat(a.pl),
    openTradeCount: parseInt(a.openTradeCount),
    currency: a.currency,
    nav: parseFloat(a.NAV),
  }
}

// ─── OPEN TRADES ─────────────────────────────────────────────────────────────

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

export async function getOpenTrades(): Promise<OpenTrade[]> {
  const data = await oandaFetch(`/v3/accounts/${ACCOUNT_ID}/openTrades`)
  return (data.trades || []).map((t: any) => {
    const units = parseInt(t.currentUnits)
    const pairKey = Object.keys(OANDA_INSTRUMENTS).find(k => OANDA_INSTRUMENTS[k] === t.instrument) || t.instrument
    return {
      id: t.id,
      pair: pairKey,
      direction: units > 0 ? 'BUY' : 'SELL',
      units: Math.abs(units),
      lots: +(Math.abs(units) / 100000).toFixed(4),
      entryPrice: parseFloat(t.price),
      currentPrice: parseFloat(t.price), // updated by price feed
      unrealizedPL: parseFloat(t.unrealizedPL),
      takeProfitPrice: t.takeProfitOrder ? parseFloat(t.takeProfitOrder.price) : undefined,
      stopLossPrice: t.stopLossOrder ? parseFloat(t.stopLossOrder.price) : undefined,
      openTime: t.openTime,
    }
  })
}

// ─── PLACE ORDER ─────────────────────────────────────────────────────────────

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

function calcPipValue(pair: string): number {
  if (pair.includes('JPY')) return 0.01
  if (pair === 'XAU/USD') return 0.1
  return 0.0001
}

export async function placeMarketOrder(req: OrderRequest): Promise<OrderResult> {
  const instrument = OANDA_INSTRUMENTS[req.pair]
  const pipValue = calcPipValue(req.pair)
  const units = Math.round(req.lots * 100000) * (req.direction === 'BUY' ? 1 : -1)

  const tp = req.direction === 'BUY'
    ? +(req.currentPrice + req.takeProfitPips * pipValue).toFixed(5)
    : +(req.currentPrice - req.takeProfitPips * pipValue).toFixed(5)

  const sl = req.direction === 'BUY'
    ? +(req.currentPrice - req.stopLossPips * pipValue).toFixed(5)
    : +(req.currentPrice + req.stopLossPips * pipValue).toFixed(5)

  const body = {
    order: {
      type: 'MARKET',
      instrument,
      units: units.toString(),
      takeProfitOnFill: { price: tp.toFixed(5) },
      stopLossOnFill: { price: sl.toFixed(5), timeInForce: 'GTC' },
      timeInForce: 'FOK',
      positionFill: 'DEFAULT',
    }
  }

  try {
    const data = await oandaFetch(`/v3/accounts/${ACCOUNT_ID}/orders`, {
      method: 'POST',
      body: JSON.stringify(body),
    })
    const fill = data.orderFillTransaction
    return {
      success: true,
      orderId: data.relatedTransactionIDs?.[0],
      tradeId: fill?.tradeOpened?.tradeID,
      filledPrice: fill ? parseFloat(fill.price) : undefined,
      tpPrice: tp,
      slPrice: sl,
    }
  } catch (e: any) {
    return { success: false, error: e.message }
  }
}

// ─── CLOSE TRADE ─────────────────────────────────────────────────────────────

export async function closeTrade(tradeId: string): Promise<{ success: boolean; pl?: number; error?: string }> {
  try {
    const data = await oandaFetch(`/v3/accounts/${ACCOUNT_ID}/trades/${tradeId}/close`, {
      method: 'PUT',
      body: JSON.stringify({}),
    })
    const pl = parseFloat(data.orderFillTransaction?.pl || '0')
    return { success: true, pl }
  } catch (e: any) {
    return { success: false, error: e.message }
  }
}

// ─── POSITION SIZE CALCULATOR ─────────────────────────────────────────────────

export function calcPositionSize(
  balance: number,
  riskPct: number,
  stopLossPips: number,
  pair: string
): number {
  // (Balance × Risk%) / (SL pips × pip value per lot)
  const pipValuePerLot = pair.includes('JPY') ? 6.8 : pair === 'XAU/USD' ? 10 : 10
  const riskAmount = balance * (riskPct / 100)
  const lots = riskAmount / (stopLossPips * pipValuePerLot)
  return +Math.max(0.01, Math.min(lots, 10)).toFixed(2)
}
