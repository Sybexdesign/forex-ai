// hooks/useForex.ts
'use client'
import { useState, useEffect, useCallback, useRef } from 'react'
import type { StrategySettings } from '@/lib/supabase'
import { authFetch } from '@/lib/api'

// ─── PRICE FEED ───────────────────────────────────────────────────────────────

export interface PriceData {
  pair: string
  bid: number
  ask: number
  spread: number
  time: string
  change?: number
  trend?: 'up' | 'down' | 'flat'
}

export function usePriceFeed(pairs: string[], interval = 5000) {
  const [prices, setPrices] = useState<Record<string, PriceData>>({})
  const [loading, setLoading] = useState(true)
  const prevRef = useRef<Record<string, number>>({})

  const fetchPrices = useCallback(async () => {
    try {
      const res = await authFetch(`/api/oanda/prices?pairs=${pairs.join(',')}`)
      const data = await res.json()
      const map: Record<string, PriceData> = {}
      for (const p of data.prices || []) {
        const prev = prevRef.current[p.pair]
        const change = prev ? p.bid - prev : 0
        map[p.pair] = { ...p, change, trend: change > 0 ? 'up' : change < 0 ? 'down' : 'flat' }
        prevRef.current[p.pair] = p.bid
      }
      setPrices(map)
    } catch (e) {
      console.error('[usePriceFeed]', e)
    } finally {
      setLoading(false)
    }
  }, [pairs.join(',')])

  useEffect(() => {
    fetchPrices()
    const id = setInterval(fetchPrices, interval)
    return () => clearInterval(id)
  }, [fetchPrices, interval])

  return { prices, loading }
}

// ─── ACCOUNT ──────────────────────────────────────────────────────────────────

export interface AccountData {
  balance: number
  unrealizedPL: number
  realizedPL: number
  openTradeCount: number
  currency: string
  nav: number
  broker?: string
  brokerError?: string
  simulated?: boolean
}

export function useAccount() {
  const [account, setAccount] = useState<AccountData | null>(null)

  const refresh = useCallback(async () => {
    try {
      const res = await authFetch('/api/account')
      const data = await res.json()

      // API returned an error — store it so the UI can show it
      if (data?.error) {
        setAccount(prev => prev ? { ...prev, brokerError: data.error } : { balance: 0, unrealizedPL: 0, realizedPL: 0, openTradeCount: 0, currency: 'USD', nav: 0, brokerError: data.error })
        return
      }

      // If the broker returns 0 balance, fall back to manually entered account size
      if (data && data.balance === 0) {
        const stored = localStorage.getItem('forexai_account_size')
        if (stored) {
          const n = parseFloat(stored)
          if (!isNaN(n) && n > 0) {
            data.balance = n
            data.nav = n
            data.simulated = true
          }
        }
      }

      data.brokerError = undefined
      setAccount(data)
    } catch { /* keep stale data on network error */ }
  }, [])

  useEffect(() => {
    refresh()
    const id = setInterval(refresh, 15000)
    return () => clearInterval(id)
  }, [refresh])

  return { account, refresh }
}

// ─── NEWS ─────────────────────────────────────────────────────────────────────

export interface NewsEvent {
  title: string
  currency: string
  impact: string
  minutesAway: number
  isInWindow: boolean
  time: string
}

export function useNews() {
  const [news, setNews] = useState<{ events: NewsEvent[]; hasHighImpactInWindow: boolean; simulated?: boolean }>({
    events: [], hasHighImpactInWindow: false
  })

  useEffect(() => {
    async function fetch_() {
      const res = await fetch('/api/news')
      setNews(await res.json())
    }
    fetch_()
    const id = setInterval(fetch_, 60000) // refresh every minute
    return () => clearInterval(id)
  }, [])

  return news
}

// ─── INDICATORS ───────────────────────────────────────────────────────────────

export function useIndicators(pair: string, timeframe: string) {
  const [indicators, setIndicators] = useState<any>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setLoading(true)
    setError(null)
    setIndicators(null)
    authFetch(`/api/indicators?pair=${encodeURIComponent(pair)}&timeframe=${timeframe}`)
      .then(r => r.json())
      .then(d => {
        if (d.error) setError(d.error)
        else setIndicators(d.indicators)
      })
      .catch(e => setError(e.message))
      .finally(() => setLoading(false))
  }, [pair, timeframe])

  return { indicators, loading, error }
}

// ─── TRADES ───────────────────────────────────────────────────────────────────

export function useTrades(userId?: string) {
  const [trades, setTrades] = useState<any[]>([])
  const [loading, setLoading] = useState(true)

  const refresh = useCallback(async () => {
    if (!userId) { setTrades([]); setLoading(false); return }
    try {
      const res = await fetch(`/api/trades?userId=${userId}`)
      const data = await res.json()
      setTrades(data.trades || [])
    } catch { /* keep stale on network error */ } finally {
      setLoading(false)
    }
  }, [userId])

  useEffect(() => {
    refresh()
    const id = setInterval(refresh, 30000)
    return () => clearInterval(id)
  }, [refresh])

  return { trades, loading, refresh }
}

// ─── SIGNALS ──────────────────────────────────────────────────────────────────

export function useSignals(userId?: string) {
  const [signals, setSignals] = useState<any[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!userId) { setSignals([]); setLoading(false); return }
    fetch(`/api/signals?userId=${userId}`)
      .then(r => r.json())
      .then(d => { setSignals(d.signals || []); setLoading(false) })
      .catch(() => { setSignals([]); setLoading(false) })
  }, [userId])

  return { signals, loading }
}

// ─── STRATEGY ─────────────────────────────────────────────────────────────────

const STRATEGY_LS_KEY = 'forexai_strategy_v2'

function readLocalStrategy(): StrategySettings | null {
  if (typeof window === 'undefined') return null
  try {
    const raw = localStorage.getItem(STRATEGY_LS_KEY)
    return raw ? (JSON.parse(raw) as StrategySettings) : null
  } catch { return null }
}

function writeLocalStrategy(s: StrategySettings) {
  try { localStorage.setItem(STRATEGY_LS_KEY, JSON.stringify(s)) } catch { /* quota */ }
}

export function useStrategy(userId?: string) {
  // Initialise immediately from localStorage so the UI is correct before any network call
  const [strategy, setStrategyState] = useState<StrategySettings | null>(() => readLocalStrategy())

  const setStrategy = useCallback((s: StrategySettings) => {
    writeLocalStrategy(s)
    setStrategyState(s)
  }, [])

  // On mount / userId change: pull from DB and merge if it has fresher data
  const load = useCallback(async () => {
    if (!userId) return
    try {
      const res = await fetch(`/api/strategy?userId=${userId}`)
      if (!res.ok) return
      const data = await res.json()
      // Only overwrite localStorage if the DB returned something other than bare defaults
      if (data.settings && data.settings.watchlist?.length) {
        setStrategy(data.settings)
      }
    } catch { /* keep localStorage value on network error */ }
  }, [userId, setStrategy])

  const save = useCallback(async (settings: StrategySettings): Promise<{ error?: string }> => {
    // 1. Persist to localStorage immediately — this is the reliable layer
    setStrategy(settings)

    // 2. Best-effort DB sync (non-blocking)
    if (!userId) return {}
    try {
      const res = await fetch('/api/strategy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId, settings }),
      })
      const data = await res.json()
      if (!res.ok || data.error) {
        console.warn('[strategy] DB sync failed:', data.error || res.status)
        // Don't surface as a user error — localStorage already saved it
      }
    } catch (e: any) {
      console.warn('[strategy] DB sync failed:', e.message)
    }
    return {}
  }, [userId, setStrategy])

  useEffect(() => { load() }, [load])
  return { strategy, save }
}
