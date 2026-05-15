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
  nextScanIn: number        // seconds until next scan
  pendingSignals: ScanSignal[]
  rejectedIds: Set<string>
  error: string | null
}

const SCAN_INTERVAL = 5 * 60  // 5 minutes in seconds

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
  const [rejectedIds] = useState(() => new Set<string>())
  const [error, setError] = useState<string | null>(null)
  const nextScanRef = useRef<number>(0)
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null)

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
        (s: ScanSignal) => !rejectedIds.has(s.pair + s.direction)
      )

      setPendingSignals(prev => {
        // Merge: replace existing signal for same pair, add new ones
        const existingPairs = new Set(newSignals.map(s => s.pair))
        const kept = prev.filter(s =>
          !existingPairs.has(s.pair) &&               // not superseded
          new Date(s.expiresAt) > new Date() &&        // not expired
          !rejectedIds.has(s.pair + s.direction)       // not rejected
        )
        return [...kept, ...newSignals]
      })

      setLastScan(new Date())
      nextScanRef.current = SCAN_INTERVAL
    } catch (e: any) {
      setError(e.message)
    } finally {
      setScanning(false)
    }
  }, [scanning, pairs, timeframe, strategy, context, rejectedIds])

  // Start/stop scanner
  useEffect(() => {
    if (!enabled) {
      if (intervalRef.current) clearInterval(intervalRef.current)
      setCountdown(0)
      return
    }

    runScan()
    nextScanRef.current = SCAN_INTERVAL

    // Countdown ticker every second
    intervalRef.current = setInterval(() => {
      nextScanRef.current = Math.max(0, nextScanRef.current - 1)
      setCountdown(nextScanRef.current)
      if (nextScanRef.current === 0) {
        nextScanRef.current = SCAN_INTERVAL
        runScan()
      }
    }, 1000)

    return () => { if (intervalRef.current) clearInterval(intervalRef.current) }
  }, [enabled]) // eslint-disable-line react-hooks/exhaustive-deps

  // Prune expired signals every 30s
  useEffect(() => {
    const id = setInterval(() => {
      setPendingSignals(prev => prev.filter(s => new Date(s.expiresAt) > new Date()))
    }, 30_000)
    return () => clearInterval(id)
  }, [])

  function rejectSignal(signal: ScanSignal) {
    rejectedIds.add(signal.pair + signal.direction)
    setPendingSignals(prev => prev.filter(s => s.id !== signal.id))
  }

  function clearAll() {
    setPendingSignals([])
  }

  return {
    enabled, setEnabled,
    scanning, lastScan, countdown,
    pendingSignals, error,
    runScan, rejectSignal, clearAll,
  }
}
