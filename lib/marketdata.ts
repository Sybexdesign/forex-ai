// lib/marketdata.ts
// Smart market-data layer with a broker-aware priority chain.
//
// Priority order:
//   1. User's connected broker (native API or EA-pushed data)
//   1b. Server-level MT5 Direct cache (for unauthenticated callers like the scalper worker)
//   2. OANDA  (server-level env-var credentials — real 24/5 price feed)
//   3. Capital.com (server-level env-var credentials, circuit-broken on network failure)
//   4. Simulation (absolute last resort)

import type { Price, Candle } from './brokers/interface'

const WEBHOOK_ONLY = new Set(['Simulation'])

// Circuit breaker for Capital.com — if it's unreachable, skip for 5 min to avoid log spam
let _capitalCircuitOpen = false
let _capitalCircuitOpenAt = 0
const CAPITAL_CIRCUIT_MS = 5 * 60_000

async function tryMt5ServerCandles(pair: string, timeframe: string, count: number): Promise<Candle[] | null> {
  try {
    const { getAdminClient } = await import('./supabase')
    const sb = getAdminClient()
    const { data: rows } = await sb
      .from('broker_configs')
      .select('config')
      .in('broker_type', ['mt5direct', 'exness'])
      .order('updated_at', { ascending: false })
      .limit(1)
    if (!rows?.[0]?.config) return null
    const { Mt5DirectBroker } = await import('./brokers/mt5direct.adapter')
    const candles = await new Mt5DirectBroker(rows[0].config).getCandles(pair, timeframe, count)
    if (candles && candles.length >= 50) return candles
  } catch { /* fall through */ }
  return null
}

async function tryMt5ServerPrices(pairs: string[]): Promise<Price[] | null> {
  try {
    const { getAdminClient } = await import('./supabase')
    const sb = getAdminClient()
    const { data: rows } = await sb
      .from('broker_configs')
      .select('config')
      .in('broker_type', ['mt5direct', 'exness'])
      .order('updated_at', { ascending: false })
      .limit(1)
    if (!rows?.[0]?.config) return null
    const { Mt5DirectBroker } = await import('./brokers/mt5direct.adapter')
    const prices = await new Mt5DirectBroker(rows[0].config).getPrices(pairs)
    if (prices && prices.length > 0) return prices
  } catch { /* fall through */ }
  return null
}

async function tryOandaCandles(pair: string, timeframe: string, count: number): Promise<Candle[] | null> {
  try {
    const { OandaBroker } = await import('./brokers/oanda.adapter')
    const candles = await new OandaBroker().getCandles(pair, timeframe, count)
    if (candles && candles.length >= 50) return candles
  } catch (e: any) {
    console.warn(`[marketdata] OANDA candles unavailable for ${pair}/${timeframe}: ${e?.message}`)
  }
  return null
}

async function tryCapitalCandles(pair: string, timeframe: string, count: number): Promise<Candle[] | null> {
  if (_capitalCircuitOpen && Date.now() - _capitalCircuitOpenAt < CAPITAL_CIRCUIT_MS) return null
  try {
    const { CapitalBroker } = await import('./brokers/capital.adapter')
    const candles = await new CapitalBroker().getCandles(pair, timeframe, count)
    if (candles && candles.length >= 50) {
      _capitalCircuitOpen = false
      return candles
    }
  } catch (e: any) {
    if (!_capitalCircuitOpen) {
      console.warn(`[marketdata] Capital.com unreachable — circuit open for 5min: ${e?.message}`)
      _capitalCircuitOpen = true
      _capitalCircuitOpenAt = Date.now()
    }
  }
  return null
}

export async function getMarketCandles(
  authToken: string | undefined,
  pair: string,
  timeframe: string,
  count = 200,
): Promise<{ candles: Candle[]; source: string; simulated: boolean }> {
  // 1. User's native broker (skip webhook-only — they have no pull price API)
  if (authToken) {
    try {
      const { getBroker } = await import('./brokers')
      const broker = await getBroker(authToken)
      if (!WEBHOOK_ONLY.has(broker.name)) {
        const candles = await broker.getCandles(pair, timeframe, count)
        if (candles && candles.length >= 50) {
          return { candles, source: broker.name, simulated: false }
        }
      }
    } catch { /* fall through */ }
  }

  // 1b. Server-level MT5 Direct cache (for unauthenticated callers like the scalper worker)
  if (!authToken) {
    const mt5Candles = await tryMt5ServerCandles(pair, timeframe, count)
    if (mt5Candles) return { candles: mt5Candles, source: 'MT5 Direct', simulated: false }
  }

  // 2. OANDA — server-level credentials, real market data 24/5
  const oandaCandles = await tryOandaCandles(pair, timeframe, count)
  if (oandaCandles) return { candles: oandaCandles, source: 'OANDA', simulated: false }

  // 3. Capital.com — server-level credentials
  const capitalCandles = await tryCapitalCandles(pair, timeframe, count)
  if (capitalCandles) return { candles: capitalCandles, source: 'Capital.com', simulated: false }

  // 4. Simulation — only when no real data source is reachable
  const { SimulationBroker } = await import('./brokers/simulation.adapter')
  const simCandles = await new SimulationBroker().getCandles(pair, timeframe, count)
  return { candles: simCandles, source: 'Simulation', simulated: true }
}

export async function getMarketPrices(
  authToken: string | undefined,
  pairs: string[],
): Promise<{ prices: Price[]; source: string; simulated: boolean }> {
  // 1. User's native broker
  if (authToken) {
    try {
      const { getBroker } = await import('./brokers')
      const broker = await getBroker(authToken)
      if (!WEBHOOK_ONLY.has(broker.name)) {
        const prices = await broker.getPrices(pairs)
        if (prices && prices.length > 0) {
          return { prices, source: broker.name, simulated: false }
        }
      }
    } catch { /* fall through */ }
  }

  // 1b. Server-level MT5 Direct cache
  if (!authToken) {
    const mt5Prices = await tryMt5ServerPrices(pairs)
    if (mt5Prices) return { prices: mt5Prices, source: 'MT5 Direct', simulated: false }
  }

  // 2. OANDA
  try {
    const { OandaBroker } = await import('./brokers/oanda.adapter')
    const prices = await new OandaBroker().getPrices(pairs)
    if (prices && prices.length > 0) {
      return { prices, source: 'OANDA', simulated: false }
    }
  } catch (e: any) {
    console.warn(`[marketdata] OANDA prices unavailable: ${e?.message}`)
  }

  // 3. Capital.com (circuit breaker applies)
  if (!(_capitalCircuitOpen && Date.now() - _capitalCircuitOpenAt < CAPITAL_CIRCUIT_MS)) {
    try {
      const { CapitalBroker } = await import('./brokers/capital.adapter')
      const prices = await new CapitalBroker().getPrices(pairs)
      if (prices && prices.length > 0) {
        _capitalCircuitOpen = false
        return { prices, source: 'Capital.com', simulated: false }
      }
    } catch (e: any) {
      if (!_capitalCircuitOpen) {
        console.warn(`[marketdata] Capital.com prices unreachable — circuit open for 5min: ${e?.message}`)
        _capitalCircuitOpen = true
        _capitalCircuitOpenAt = Date.now()
      }
    }
  }

  // 4. Simulation
  const { SimulationBroker } = await import('./brokers/simulation.adapter')
  const prices = await new SimulationBroker().getPrices(pairs)
  return { prices, source: 'Simulation', simulated: true }
}
