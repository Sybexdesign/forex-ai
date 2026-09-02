// lib/cache.ts — Central cache management for the forex-ai trading terminal.
// Provides functions to clear every layer of in-memory/server-side caching that
// could cause stale data, stalled signals, or incorrect trading decisions.
//
// Caching layers covered:
//   1. Capital.com session token + CST + epic cache (capital.adapter.ts)
//   2. Capital.com circuit breaker (marketdata.ts)
//   3. Default broker singleton (brokers/index.ts)
//   4. Worker in-memory caches (scalper.mjs) — via a special endpoint
//   5. Next.js route cache (revalidatePath / revalidateTag)
//   6. Client-side localStorage (strategy, account size)

// ─── Capital.com adapter caches ───────────────────────────────────────────────
// These are module-level singletons in capital.adapter.ts. We expose clear
// functions from that module so the admin cache-clear can reset them.

// ─── Market data circuit breaker ──────────────────────────────────────────────
// The Capital.com circuit breaker in marketdata.ts is a module-level flag.
// We expose a reset function so the admin can force it closed.

// ─── Broker singleton ─────────────────────────────────────────────────────────
// The default broker in brokers/index.ts is cached as _defaultBroker.
// resetBroker() already exists — we re-export it here for convenience.

import { resetBroker } from './brokers'

// ─── Capital.com session/epic cache reset ─────────────────────────────────────
// capital.adapter.ts uses module-level _sessionToken, _cst, and _epicCache.
// We can't import private variables, so we expose a reset function from the
// adapter module itself. This is a dynamic import to avoid circular deps.

export async function clearCapitalCache(): Promise<{ cleared: string[] }> {
  const cleared: string[] = []

  try {
    const { resetCapitalCache } = await import('./brokers/capital.adapter')
    if (typeof resetCapitalCache === 'function') {
      resetCapitalCache()
      cleared.push('capital-session')
      cleared.push('capital-epic-cache')
    }
  } catch (e: any) {
    console.warn('[cache] capital reset failed:', e?.message)
  }

  return { cleared }
}

// ─── Market data circuit breaker reset ────────────────────────────────────────
export async function clearMarketDataCircuit(): Promise<{ cleared: string[] }> {
  const cleared: string[] = []

  try {
    const { resetCapitalCircuit } = await import('./marketdata')
    if (typeof resetCapitalCircuit === 'function') {
      resetCapitalCircuit()
      cleared.push('capital-circuit-breaker')
    }
  } catch (e: any) {
    console.warn('[cache] circuit reset failed:', e?.message)
  }

  return { cleared }
}

// ─── Full server-side cache clear ─────────────────────────────────────────────
export async function clearAllServerCaches(): Promise<{
  cleared: string[]
  errors: string[]
}> {
  const cleared: string[] = []
  const errors: string[] = []

  // 1. Reset broker singleton
  try {
    resetBroker()
    cleared.push('broker-singleton')
  } catch (e: any) {
    errors.push(`broker-singleton: ${e?.message}`)
  }

  // 2. Clear Capital.com session + epic cache
  try {
    const { resetCapitalCache } = await import('./brokers/capital.adapter')
    if (typeof resetCapitalCache === 'function') {
      resetCapitalCache()
      cleared.push('capital-session')
      cleared.push('capital-epic-cache')
    }
  } catch (e: any) {
    errors.push(`capital-cache: ${e?.message}`)
  }

  // 3. Reset Capital.com circuit breaker
  try {
    const { resetCapitalCircuit } = await import('./marketdata')
    if (typeof resetCapitalCircuit === 'function') {
      resetCapitalCircuit()
      cleared.push('capital-circuit-breaker')
    }
  } catch (e: any) {
    errors.push(`capital-circuit: ${e?.message}`)
  }

  // 4. Reset Phase 2 threshold calibration (lib/threshold-calibration.ts) so the
  //    next signal recomputes NO-TRADE thresholds from fresh historical evidence.
  try {
    const { clearCalibrationCache } = await import('./threshold-calibration')
    if (typeof clearCalibrationCache === 'function') {
      clearCalibrationCache()
      cleared.push('threshold-calibration')
    }
  } catch (e: any) {
    errors.push(`threshold-calibration: ${e?.message}`)
  }

  // 5. Reset the signal route's multi-timeframe HTF bias cache so a cache-clear
  //    forces fresh 15m/1H trend reads (Phase 2 item 6).
  try {
    const { clearHtfBiasCache } = await import('@/app/api/scalper/signal/route')
    if (typeof clearHtfBiasCache === 'function') {
      clearHtfBiasCache()
      cleared.push('signal-htf-bias')
    }
  } catch (e: any) {
    errors.push(`signal-htf-bias: ${e?.message}`)
  }

  // 6. Reset the Expectancy Engine's segmented-statistics + strategy-health
  //    caches (2026-09-02) so the next evaluation recomputes from fresh rows.
  try {
    const { clearExpectancyCache } = await import('./expectancy-engine')
    if (typeof clearExpectancyCache === 'function') {
      clearExpectancyCache()
      cleared.push('expectancy-engine')
    }
  } catch (e: any) {
    errors.push(`expectancy-engine: ${e?.message}`)
  }
  try {
    const { clearStrategyHealthCache } = await import('./strategy-health')
    if (typeof clearStrategyHealthCache === 'function') {
      clearStrategyHealthCache()
      cleared.push('strategy-health')
    }
  } catch (e: any) {
    errors.push(`strategy-health: ${e?.message}`)
  }

  return { cleared, errors }
}

// ─── Client-side cache clear (localStorage) ───────────────────────────────────
// Called from the browser. Clears all forex-ai related localStorage keys.
export function clearClientCaches(): string[] {
  const cleared: string[] = []
  const keys = [
    'forexai_strategy_v2',
    'forexai_account_size',
    'forexai_theme',
  ]
  for (const key of keys) {
    try {
      localStorage.removeItem(key)
      cleared.push(key)
    } catch { /* ignore */ }
  }
  return cleared
}
