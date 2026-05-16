'use client'
// hooks/useScanner.ts
// Background scanner — polls /api/scan on an interval, maintains an approval queue.

import { useState, useEffect, useCallback, useRef } from 'react'
import type { ScanSignal } from '@/app/api/scan/route'
import type { StrategySettings } from '@/lib/supabase'
import { getSupabase } from '@/lib/supabase'

export type { ScanSignal }

export interface ScannerState {
  enabled: boolean
  scanning: boolean
  lastScan: Date | null
  nextScanIn: number
  pendingSignals: ScanSignal[]
  rejectedIds: Set<string>
  error: string | null
}

// Adaptive scan interval — matches the timeframe so signals stay fresh
function getScanInterval(tf: string): number {
  const MAP: Record<string, number> = {
    '1m':  60,   // scan every 60 s — 1m candles change every 60 s
    '3m':  90,   // scan every 90 s
    '5m':  120,  // scan every 2 min
    '15m': 300,  // scan every 5 min
    '30m': 300,
    '1H':  300,
    '4H':  600,
    'Daily': 1800,
  }
  return MAP[tf] ?? 300
}

export function useScanner(
  strategy: StrategySettings,
  context: { newsInWindow: boolean; openPositions: number; todayPL: number; accountBalance: number },
  pairs: string[],
  timeframe = '1H',
) {
  const [enabled, setEnabled] = useState(false)
  const [scanning, setScanning] = useState(false)
  const [lastScan, setLastScan] = useState<Date | null>(null)
  const [countdown, setCountdown] = useState(0)
  const [pendingSignals, setPendingSignals] = useState<ScanSignal[]>([])
  const [error, setError] = useState<string | null>(null)

  const nextScanRef  = useRef<number>(0)
  const intervalRef  = useRef<ReturnType<typeof setInterval> | null>(null)
  const scanInterval = getScanInterval(timeframe)

  // Time-limited rejection map: key → expiry timestamp
  // Rejections expire after 4× the scan interval so fresh signals can reappear
  const rejectedMap = useRef(new Map<string, number>())

  const isRejected = (pair: string, direction: string) => {
    const key    = `${pair}:${direction}`
    const expiry = rejectedMap.current.get(key)
    if (!expiry) return false
    if (Date.now() > expiry) { rejectedMap.current.delete(key); return false }
    return true
  }

  const runScan = useCallback(async () => {
    if (scanning || !pairs.length) return
    setScanning(true)
    setError(null)
    try {
      const { data: { session } } = await getSupabase().auth.getSession()
      const headers: Record<string, string> = { 'Content-Type': 'application/json' }
      if (session?.access_token) headers['Authorization'] = `Bearer ${session.access_token}`

      const res = await fetch('/api/scan', {
        method: 'POST',
        headers,
        body: JSON.stringify({ pairs, timeframe, strategy, ...context }),
      })
      const data = await res.json()
      if (data.error) throw new Error(data.error)

      const newSignals: ScanSignal[] = (data.signals || []).filter(
        (s: ScanSignal) => !isRejected(s.pair, s.direction)
      )

      setPendingSignals(prev => {
        const freshPairs = new Set(newSignals.map(s => s.pair))
        const kept = prev.filter(s =>
          !freshPairs.has(s.pair) &&
          new Date(s.expiresAt) > new Date() &&
          !isRejected(s.pair, s.direction)
        )
        return [...kept, ...newSignals]
      })

      setLastScan(new Date())
      nextScanRef.current = scanInterval
    } catch (e: any) {
      setError(e.message)
    } finally {
      setScanning(false)
    }
  }, [scanning, pairs, timeframe, strategy, context, scanInterval]) // eslint-disable-line react-hooks/exhaustive-deps

  // Restart the interval whenever enabled state or timeframe changes
  useEffect(() => {
    if (!enabled) {
      if (intervalRef.current) clearInterval(intervalRef.current)
      setCountdown(0)
      return
    }

    runScan()
    nextScanRef.current = scanInterval

    intervalRef.current = setInterval(() => {
      nextScanRef.current = Math.max(0, nextScanRef.current - 1)
      setCountdown(nextScanRef.current)
      if (nextScanRef.current === 0) {
        nextScanRef.current = scanInterval
        runScan()
      }
    }, 1000)

    return () => { if (intervalRef.current) clearInterval(intervalRef.current) }
  }, [enabled, timeframe]) // eslint-disable-line react-hooks/exhaustive-deps

  // Prune expired signals every 15 s (tighter for short TF)
  useEffect(() => {
    const id = setInterval(() => {
      setPendingSignals(prev => prev.filter(s => new Date(s.expiresAt) > new Date()))
    }, 15_000)
    return () => clearInterval(id)
  }, [])

  function rejectSignal(signal: ScanSignal) {
    // Block this pair+direction for 4 scan cycles, then allow fresh signals
    const ttl = getScanInterval(timeframe) * 4 * 1000
    rejectedMap.current.set(`${signal.pair}:${signal.direction}`, Date.now() + ttl)
    setPendingSignals(prev => prev.filter(s => s.id !== signal.id))
  }

  function clearAll() {
    rejectedMap.current.clear()
    setPendingSignals([])
  }

  // Expose a Set-compatible shim for any code that reads rejectedIds
  const rejectedIds = new Set(
    Array.from(rejectedMap.current.entries())
      .filter(([, exp]) => exp > Date.now())
      .map(([k]) => k)
  )

  return {
    enabled, setEnabled,
    scanning, lastScan, countdown,
    pendingSignals, error,
    runScan, rejectSignal, clearAll,
    rejectedIds,
  }
}
