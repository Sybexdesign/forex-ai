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
import type { Mt5DirectConfig } from './brokers/mt5direct.adapter'

const WEBHOOK_ONLY = new Set(['Simulation'])

// Circuit breaker for Capital.com — if it's unreachable, skip for 5 min to avoid log spam
let _capitalCircuitOpen = false
let _capitalCircuitOpenAt = 0
const CAPITAL_CIRCUIT_MS = 5 * 60_000

// ─── Circuit breaker reset (admin cache-clear) ────────────────────────────────
// Forces the Capital.com circuit breaker closed so the next request retries
// immediately instead of waiting out the 5-minute cooldown. Called by
// /api/admin/cache.
export function resetCapitalCircuit() {
  _capitalCircuitOpen = false
  _capitalCircuitOpenAt = 0
  console.log('[marketdata] Capital.com circuit breaker reset')
}

// ─── Server-level MT5 fallback: DETERMINISTIC ACCOUNT IDENTITY ───────────────
//
// These two helpers serve callers that present NO user token. They used to pick
// the broker_configs row with the most recent `updated_at`:
//
//     .in('broker_type', ['mt5direct','exness']).order('updated_at', {ascending:false}).limit(1)
//
// That is ownership by timestamp: with more than one EA pushing, the account
// that happened to sync last supplied ANOTHER user's prices and candles. It was
// demonstrated live — an unauthenticated /api/scalper/tick call returned the
// FusionMarkets account's bar close while the funded Exness account was the one
// under test. "Most recently updated" is not an identity, so it is gone.
//
// The fallback now requires an EXPLICIT, configured account identity and fails
// CLOSED when none is configured or when the identity is ambiguous:
//
//   * MT5_SERVER_USER_ID — purpose-built for this path (preferred)
//   * WORKER_USER_ID     — honoured as the existing deployment convention
//   * neither set        → null, so the caller falls through to OANDA →
//                          Capital.com → simulation (account-neutral sources)
//   * two active rows    → null (ambiguous, never guessed)
//
// Authenticated callers never reach this code: getMarketCandles/getMarketPrices
// resolve the caller's own broker_config via getBroker(authToken) first. This is
// the ladder of last resort, and it must not be able to pick the wrong account.

/** The explicit account this server-level fallback is allowed to read, if any. */
export function resolveServerMt5UserId(env: Record<string, string | undefined> = process.env): string | null {
  const id = (env.MT5_SERVER_USER_ID || env.WORKER_USER_ID || '').trim()
  return id || null
}

/**
 * Choose the single active config owned by `userId`.
 * Returns null when there is no explicit owner or when ownership is ambiguous —
 * never falls back to another row.
 */
export function pickServerConfig(
  rows: Array<{ user_id?: string | null; config?: Mt5DirectConfig | null }> | null | undefined,
  userId: string | null,
): Mt5DirectConfig | null {
  if (!userId) return null
  const owned = (rows || []).filter((r) => r?.user_id === userId && r?.config)
  // Exactly one active row per user is guaranteed by
  // broker_configs_one_active_per_user (migration 20260606); anything else is an
  // unexpected state and must not be resolved by guessing.
  if (owned.length !== 1) return null
  return owned[0].config ?? null
}

/** Load the explicitly-owned active config, or null. Fail closed, never timestamp-ordered. */
async function loadServerMt5Config(): Promise<Mt5DirectConfig | null> {
  const userId = resolveServerMt5UserId()
  if (!userId) {
    console.warn('[marketdata] server MT5 fallback disabled — MT5_SERVER_USER_ID/WORKER_USER_ID not set (failing closed to account-neutral feeds)')
    return null
  }
  try {
    const { getAdminClient } = await import('./supabase')
    const sb = getAdminClient()
    const { data: rows } = await sb
      .from('broker_configs')
      .select('user_id, config')
      .eq('user_id', userId)
      .eq('is_active', true)
      .in('broker_type', ['mt5direct', 'exness'])
      .limit(2)          // 2 so an ambiguity is DETECTABLE rather than silently truncated
    return pickServerConfig(rows, userId)
  } catch { /* fall through */ }
  return null
}

async function tryMt5ServerCandles(pair: string, timeframe: string, count: number): Promise<Candle[] | null> {
  const config = await loadServerMt5Config()
  if (!config) return null
  try {
    const { Mt5DirectBroker } = await import('./brokers/mt5direct.adapter')
    const candles = await new Mt5DirectBroker(config).getCandles(pair, timeframe, count)
    if (candles && candles.length >= 50) return candles
  } catch { /* fall through */ }
  return null
}

async function tryMt5ServerPrices(pairs: string[]): Promise<Price[] | null> {
  const config = await loadServerMt5Config()
  if (!config) return null
  try {
    const { Mt5DirectBroker } = await import('./brokers/mt5direct.adapter')
    const prices = await new Mt5DirectBroker(config).getPrices(pairs)
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
