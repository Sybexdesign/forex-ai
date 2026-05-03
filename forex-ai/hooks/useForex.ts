// hooks/useForex.ts
'use client'
import { useState, useEffect, useCallback, useRef } from 'react'
import type { StrategySettings } from '@/lib/supabase'

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
      const res = await fetch(`/api/oanda/prices?pairs=${pairs.join(',')}`)
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
  simulated?: boolean
}

export function useAccount() {
  const [account, setAccount] = useState<AccountData | null>(null)

  useEffect(() => {
    async function fetch_() {
      const res = await fetch('/api/account')
      setAccount(await res.json())
    }
    fetch_()
    const id = setInterval(fetch_, 30000)
    return () => clearInterval(id)
  }, [])

  return account
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
  const [news, setNews] = useState<{ events: NewsEvent[]; hasHighImpactInWindow: boolean }>({
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
    fetch(`/api/indicators?pair=${encodeURIComponent(pair)}&timeframe=${timeframe}`)
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
    const url = userId ? `/api/trades?userId=${userId}` : '/api/trades?userId=demo'
    const res = await fetch(url)
    const data = await res.json()
    setTrades(data.trades || [])
    setLoading(false)
  }, [userId])

  useEffect(() => { refresh() }, [refresh])
  return { trades, loading, refresh }
}

// ─── SIGNALS ──────────────────────────────────────────────────────────────────

export function useSignals(userId?: string) {
  const [signals, setSignals] = useState<any[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const url = userId ? `/api/signals?userId=${userId}` : '/api/signals?userId=demo'
    fetch(url).then(r => r.json()).then(d => {
      setSignals(d.signals || [])
      setLoading(false)
    })
  }, [userId])

  return { signals, loading }
}

// ─── STRATEGY ─────────────────────────────────────────────────────────────────

export function useStrategy(userId?: string) {
  const [strategy, setStrategy] = useState<StrategySettings | null>(null)

  const load = useCallback(async () => {
    const url = userId ? `/api/strategy?userId=${userId}` : '/api/strategy'
    const res = await fetch(url)
    const data = await res.json()
    setStrategy(data.settings)
  }, [userId])

  const save = useCallback(async (settings: StrategySettings) => {
    await fetch('/api/strategy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId, settings }),
    })
    setStrategy(settings)
  }, [userId])

  useEffect(() => { load() }, [load])
  return { strategy, save }
}
