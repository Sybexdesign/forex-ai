// lib/brokers/capital.adapter.ts
// Capital.com (Currency.com futures platform)
// Docs: https://open-api.capital.com
//
// Env vars needed:
//   CAPITAL_API_KEY=your_api_key
//   CAPITAL_IDENTIFIER=your_account_email
//   CAPITAL_PASSWORD=your_account_password
//   CAPITAL_BASE_URL=https://api-capital.backend-capital.com/api  (live)
//                  =https://demo-api-capital.backend.currency.com/api  (demo)
//
// Note: This platform uses futures contracts. FX prices are scaled ×10000
// (e.g. EUR/USD ~1.1753 is quoted as ~11753). Scaling is normalised internally
// so all prices returned by this adapter are in standard forex units.

import type { IBroker, Price, Candle, AccountSummary, OpenTrade, OrderRequest, OrderResult, CloseResult } from './interface'
import { calcStandardPositionSize, getPipValue } from './interface'

const BASE_URL   = process.env.CAPITAL_BASE_URL   || 'https://demo-api-capital.backend.currency.com/api'
const API_KEY    = process.env.CAPITAL_API_KEY    || ''
const IDENTIFIER = process.env.CAPITAL_IDENTIFIER || ''
const PASSWORD   = process.env.CAPITAL_PASSWORD   || ''

// Search terms used to discover front-month futures epics for each pair
const PAIR_SEARCH: Record<string, string> = {
  // Majors
  'EUR/USD': 'EURUSD', 'GBP/USD': 'GBPUSD', 'USD/JPY': 'USDJPY',
  'AUD/USD': 'AUDUSD', 'USD/CAD': 'USDCAD', 'USD/CHF': 'USDCHF',
  'NZD/USD': 'NZDUSD', 'GBP/JPY': 'GBPJPY', 'EUR/JPY': 'EURJPY',
  'XAU/USD': 'GOLD',   'XAG/USD': 'SILVER',
  // Crosses
  'EUR/GBP': 'EURGBP', 'EUR/AUD': 'EURAUD', 'EUR/CAD': 'EURCAD',
  'EUR/NZD': 'EURNZD', 'GBP/AUD': 'GBPAUD', 'GBP/CAD': 'GBPCAD',
  'GBP/NZD': 'GBPNZD', 'AUD/JPY': 'AUDJPY', 'AUD/NZD': 'AUDNZD',
  'CAD/JPY': 'CADJPY', 'NZD/JPY': 'NZDJPY', 'CHF/JPY': 'CHFJPY',
  // Commodities
  'BCO/USD': 'BRENT',
  // Indices
  'SPX500': 'US500', 'NAS100': 'US100', 'UK100': 'UK100',
  'GER40': 'GERMANY40', 'JP225': 'JAPAN225',
}

// Expected real-world price ranges used to infer scale factors
const EXPECTED_RANGE: Record<string, [number, number]> = {
  // Majors
  'EUR/USD': [0.8, 1.6],   'GBP/USD': [1.0, 1.8],   'USD/JPY': [80, 200],
  'AUD/USD': [0.4, 1.1],   'USD/CAD': [1.0, 1.6],   'USD/CHF': [0.6, 1.4],
  'NZD/USD': [0.3, 0.9],   'GBP/JPY': [120, 260],   'EUR/JPY': [100, 220],
  'XAU/USD': [1000, 8000], 'XAG/USD': [10, 150],
  // Crosses
  'EUR/GBP': [0.6, 1.0],   'EUR/AUD': [1.2, 2.0],   'EUR/CAD': [1.2, 1.8],
  'EUR/NZD': [1.4, 2.2],   'GBP/AUD': [1.4, 2.4],   'GBP/CAD': [1.4, 2.2],
  'GBP/NZD': [1.6, 2.5],   'AUD/JPY': [60, 120],    'AUD/NZD': [0.9, 1.4],
  'CAD/JPY': [70, 130],    'NZD/JPY': [50, 110],    'CHF/JPY': [100, 180],
  // Commodities
  'BCO/USD': [30, 200],
  // Indices — Capital.com quotes in native points (scale=1)
  'SPX500': [2000, 8000],  'NAS100': [8000, 30000], 'UK100': [5000, 12000],
  'GER40': [8000, 25000],  'JP225': [20000, 55000],
}

const TF_MAP: Record<string, string> = {
  '1m': 'MINUTE', '3m': 'MINUTE_5', '5m': 'MINUTE_5', '15m': 'MINUTE_15', '30m': 'MINUTE_30',
  '1H': 'HOUR', '4H': 'HOUR_4', 'Daily': 'DAY', 'Weekly': 'WEEK',
}

let _sessionToken: string | null = null
let _cst: string | null = null

// Epic cache: { epic, scaleFactor } keyed by pair, expires after 1 hour
const _epicCache: Record<string, { epic: string; scale: number; expiresAt: number }> = {}

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
    const body = await res.text()
    if (res.status === 401 || res.status === 403) {
      _sessionToken = null; _cst = null
    }
    console.error(`[capital] ${res.status} ${path}:`, body)
    throw new Error(`Capital.com ${res.status}: ${body}`)
  }
  return res.json()
}

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)) }

// Discover the front-month futures epic for a pair and infer its price scale factor
async function getEpicInfo(pair: string): Promise<{ epic: string; scale: number }> {
  const cached = _epicCache[pair]
  if (cached && cached.expiresAt > Date.now()) return cached

  const search = PAIR_SEARCH[pair]
  if (!search) throw new Error(`No search term for pair ${pair}`)

  const data = await capitalFetch(`/v1/markets?searchTerm=${encodeURIComponent(search)}&limit=1`)
  const market = data.markets?.[0]
  if (!market) throw new Error(`No market found for ${pair}`)

  const rawBid: number = market.bid || market.offer || 0
  const [minExpected, maxExpected] = EXPECTED_RANGE[pair] || [0, Infinity]

  // Infer scale: find the power-of-10 divisor that brings rawBid into the expected range
  let scale = 1
  if (rawBid > 0) {
    for (const factor of [1, 10, 100, 1000, 10000, 100000]) {
      const normalised = rawBid / factor
      if (normalised >= minExpected && normalised <= maxExpected) {
        scale = factor
        break
      }
    }
  }

  const result = { epic: market.epic, scale, expiresAt: Date.now() + 3600_000 }
  _epicCache[pair] = result
  return result
}

export class CapitalBroker implements IBroker {
  name = 'Capital.com'
  supportedPairs = Object.keys(PAIR_SEARCH)
  supportsLivePositions = true

  async getPrices(pairs: string[]): Promise<Price[]> {
    const results: Price[] = []
    for (const pair of pairs) {
      try {
        const { epic, scale } = await getEpicInfo(pair)
        const data = await capitalFetch(`/v1/markets/${epic}`)
        const snap = data.snapshot || data
        const bid = (snap.bid ?? data.bid) / scale
        const ask = (snap.offer ?? snap.ask ?? data.offer) / scale
        if (bid > 0) {
          results.push({
            instrument: epic, pair,
            bid, ask,
            spread: +(ask - bid).toFixed(6),
            time: new Date().toISOString(),
          })
        }
      } catch (e: any) { console.error(`[capital] getPrices ${pair}:`, e?.message) }
    }
    return results
  }

  async getCandles(pair: string, timeframe: string, count = 200): Promise<Candle[]> {
    const resolution = TF_MAP[timeframe] || 'HOUR'
    // Single attempt — caller (marketdata.ts) handles circuit-breaking and retry spacing
    const { epic, scale } = await getEpicInfo(pair)
    const data = await capitalFetch(`/v1/prices/${epic}?resolution=${resolution}&max=${count}`)
    const candles = (data.prices || []).map((p: any) => ({
      time: p.snapshotTimeUTC,
      open:   (p.openPrice?.mid  ?? p.openPrice?.bid)  / scale,
      high:   (p.highPrice?.mid  ?? p.highPrice?.bid)  / scale,
      low:    (p.lowPrice?.mid   ?? p.lowPrice?.bid)   / scale,
      close:  (p.closePrice?.mid ?? p.closePrice?.bid) / scale,
      volume: p.lastTradedVolume || 0,
    }))
    if (candles.length === 0) throw new Error('empty candle response')
    return candles
  }

  async getAccountSummary(): Promise<AccountSummary> {
    const [data, posData] = await Promise.all([
      capitalFetch('/v1/accounts'),
      capitalFetch('/v1/positions').catch(() => ({ positions: [] })),
    ])
    const accounts: any[] = data.accounts || []
    // Prefer the account with the highest balance; fall back to the preferred/first account
    const preferred = accounts.find(a => a.preferred) || accounts[0]
    const best = accounts.reduce((top, a) => {
      const topBal = top?.balance?.balance ?? top?.balance?.available ?? 0
      const aBal   = a?.balance?.balance   ?? a?.balance?.available   ?? 0
      return aBal > topBal ? a : top
    }, preferred)
    const account = best || preferred
    const bal = account?.balance
    return {
      balance:        bal?.balance    ?? bal?.available ?? 0,
      unrealizedPL:   bal?.profitLoss ?? 0,
      realizedPL:     0,
      openTradeCount: (posData.positions || []).length,
      currency:       account?.currency || 'GBP',
      nav:            bal?.balance     ?? bal?.available ?? 0,
    }
  }

  async getOpenTrades(): Promise<OpenTrade[]> {
    const data = await capitalFetch('/v1/positions')
    return (data.positions || []).map((p: any) => {
      const pos = p.position
      const market = p.market
      const pair = Object.keys(PAIR_SEARCH).find(k => _epicCache[k]?.epic === market.epic) || market.epic
      const scale = _epicCache[pair]?.scale || 1
      return {
        id: pos.dealId,
        pair,
        direction: pos.direction === 'BUY' ? 'BUY' : 'SELL',
        units: pos.size * 100000,
        lots: pos.size,
        entryPrice: pos.openLevel / scale,
        currentPrice: market.bid / scale,
        unrealizedPL: pos.upl || 0,
        stopLossPrice: pos.stopLevel ? pos.stopLevel / scale : undefined,
        openTime: pos.createdDateUTC,
      }
    })
  }

  async placeOrder(req: OrderRequest): Promise<OrderResult> {
    try {
      const { epic, scale } = await getEpicInfo(req.pair)
      const pip = getPipValue(req.pair)
      // TP/SL submitted in the platform's native scaled units
      const tp = req.direction === 'BUY'
        ? +((req.currentPrice + req.takeProfitPips * pip) * scale).toFixed(1)
        : +((req.currentPrice - req.takeProfitPips * pip) * scale).toFixed(1)
      const sl = req.direction === 'BUY'
        ? +((req.currentPrice - req.stopLossPips * pip) * scale).toFixed(1)
        : +((req.currentPrice + req.stopLossPips * pip) * scale).toFixed(1)

      const data = await capitalFetch('/v1/positions', {
        method: 'POST',
        body: JSON.stringify({
          epic, direction: req.direction,
          size: req.lots, guaranteedStop: false,
          profitLevel: tp, stopLevel: sl,
        }),
      })
      const dealReference = data.dealReference

      // Confirm the deal to get the actual dealId (needed for closing positions)
      // dealReference is temporary; dealId is the persistent position identifier
      let dealId = dealReference
      try {
        const confirm = await capitalFetch(`/v1/confirms/${dealReference}`)
        if (confirm.dealId) dealId = confirm.dealId
      } catch { /* fall back to dealReference if confirms endpoint fails */ }

      return {
        success: true,
        tradeId: dealId,
        orderId: dealReference,
        filledPrice: req.currentPrice,
        tpPrice: req.currentPrice + req.takeProfitPips * pip * (req.direction === 'BUY' ? 1 : -1),
        slPrice: req.currentPrice - req.stopLossPips * pip * (req.direction === 'BUY' ? 1 : -1),
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
