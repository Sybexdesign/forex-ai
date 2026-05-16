// lib/marketdata.ts
// Smart market-data layer with a broker-aware priority chain.
//
// Priority order:
//   1. User's connected broker (native API or EA-pushed data)
//   2. OANDA  (server-level env-var credentials — real 24/5 price feed)
//   3. Capital.com (server-level env-var credentials)
//   4. Simulation (absolute last resort)
//
// MT5 Direct and Exness store EA-pushed prices/candles in their adapter;
// OANDA/Capital fallbacks are built into those adapters themselves.
// Only Simulation is skipped at this layer.

import type { Price, Candle } from './brokers/interface'

const WEBHOOK_ONLY = new Set(['Simulation'])

async function tryOandaCandles(pair: string, timeframe: string, count: number): Promise<Candle[] | null> {
  try {
    const { OandaBroker } = await import('./brokers/oanda.adapter')
    const candles = await new OandaBroker().getCandles(pair, timeframe, count)
    if (candles && candles.length >= 50) return candles
  } catch { /* fall through */ }
  return null
}

async function tryCapitalCandles(pair: string, timeframe: string, count: number): Promise<Candle[] | null> {
  try {
    const { CapitalBroker } = await import('./brokers/capital.adapter')
    const candles = await new CapitalBroker().getCandles(pair, timeframe, count)
    if (candles && candles.length >= 50) return candles
  } catch { /* fall through */ }
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

  // 2. OANDA
  try {
    const { OandaBroker } = await import('./brokers/oanda.adapter')
    const prices = await new OandaBroker().getPrices(pairs)
    if (prices && prices.length > 0) {
      return { prices, source: 'OANDA', simulated: false }
    }
  } catch { /* fall through */ }

  // 3. Capital.com
  try {
    const { CapitalBroker } = await import('./brokers/capital.adapter')
    const prices = await new CapitalBroker().getPrices(pairs)
    if (prices && prices.length > 0) {
      return { prices, source: 'Capital.com', simulated: false }
    }
  } catch { /* fall through */ }

  // 4. Simulation
  const { SimulationBroker } = await import('./brokers/simulation.adapter')
  const prices = await new SimulationBroker().getPrices(pairs)
  return { prices, source: 'Simulation', simulated: true }
}
