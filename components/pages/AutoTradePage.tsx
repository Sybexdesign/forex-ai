'use client'
// components/pages/AutoTradePage.tsx
// Full-auto + semi-auto trading with prop firm enforcement

import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { Panel, LoadingDots, CopyValue } from '../ui'
import { calcStandardPositionSize, getPipValue, getPipValuePerLot } from '@/lib/brokers/interface'
import { execSlTpPips } from '@/lib/trade-levels'
import { authFetch } from '@/lib/api'
import type { ScanSignal, ScanDiagnostic } from '@/hooks/useScanner'
import { getSupabase } from '@/lib/supabase'
import type { StrategySettings } from '@/lib/supabase'
import type { AutoTradeGate } from '@/hooks/useForex'

const TIMEFRAMES = ['1m', '3m', '5m', '15m', '30m', '1H', '4H']
const METALS_ONLY = ['XAU/USD', 'XAG/USD']
const DIR_COLOR: Record<string, string> = { BUY: 'var(--color-buy)', SELL: 'var(--color-sell)' }
const PAGE_SIZE = 5
const SCALP_REFRESH_MS = 15_000  // refresh scalp signals every 15 seconds
const SCALP_EXPIRY_MS  = 3 * 60_000  // 3-minute signal validity
const PAIR_COOLDOWN_MS = 5 * 60_000  // minimum gap between two auto-trades on the same pair (any section) — caps the 30-60/hour overtrading

// SL/TP clamp bounds (Option C) now live in lib/trade-levels.ts together with
// the broker min-stop widening — shared with /api/orders so cards display the
// exact post-clamp, post-widening stop distance that gets placed.

// Re-anchor scalp/mirror entry/SL/TP onto the live bid/ask quote when a
// fresh price exists in the OANDA prices feed. The signal-time values
// (sig.entry/sl/tp) come from the most recent 5m candle close and can be
// 5-15s stale by the time the operator looks at the card; using them at
// face value made the displayed ENTRY drift from what the broker would
// actually fill at, and made OANDA/Capital adapters anchor SL/TP off a
// stale price (MT5 Direct does its own re-anchoring server-side).
//
// SL/TP levels are computed from the caller-supplied EXECUTION distances
// (post clamp + min-stop widening via execSlTpPips) — not the raw engine
// distances — so what renders on the card is what the broker places. If the
// live feed is missing/stale (bid<=0), falls back to sig.entry exactly as
// before, so the card never shows a worse value than the signal price.
function liveAnchoredLevels(
  sig: { pair: string; entry: number; sl: number; tp: number; direction: 'BUY' | 'SELL' | 'HOLD' },
  prices: Record<string, { bid?: number; ask?: number } | undefined> | undefined,
  forDirection: 'BUY' | 'SELL',
  dist: { slDist: number; tpDist: number },
): { entry: number; sl: number; tp: number; isLive: boolean } {
  const { slDist, tpDist } = dist
  const px  = prices?.[sig.pair]
  const bid = Number(px?.bid ?? 0)
  const ask = Number(px?.ask ?? 0)
  const liveOk = bid > 0 && ask > 0
  const sign   = forDirection === 'BUY' ? 1 : -1
  if (!liveOk) {
    return {
      entry: sig.entry,
      sl:    sig.entry - slDist * sign,
      tp:    sig.entry + tpDist * sign,
      isLive: false,
    }
  }
  const anchor = forDirection === 'BUY' ? ask : bid
  return {
    entry: anchor,
    sl:    anchor - slDist * sign,
    tp:    anchor + tpDist * sign,
    isLive: true,
  }
}

type MarketRegime = 'chop' | 'ranging' | 'weak-trend' | 'trending' | 'strong-trend'

// Regime badge — chop/strong-trend are HOLD-only (red), ranging is our highest-edge
// tradable condition (green), weak/trending are middle bands. Tooltip shows ADX +
// gate so the operator can see why the signal passed or failed at a glance.
const REGIME_BADGE: Record<MarketRegime, { label: string; bg: string; fg: string }> = {
  'chop':         { label: '〰 CHOP',        bg: 'rgba(255,48,86,0.18)',  fg: 'var(--color-sell)' },
  'ranging':      { label: '↔ RANGING',      bg: 'rgba(0,200,83,0.18)',   fg: 'var(--color-buy)'  },
  'weak-trend':   { label: '↗ WEAK TREND',   bg: 'rgba(255,170,0,0.18)',  fg: '#ffaa00'           },
  'trending':     { label: '↑ TRENDING',     bg: 'rgba(255,140,0,0.18)',  fg: '#ff8c00'           },
  'strong-trend': { label: '⬆ STRONG TREND', bg: 'rgba(255,48,86,0.18)',  fg: 'var(--color-sell)' },
}

type DirCheckTimeframe = '1m' | '5m'

interface DirCheckResult {
  pair: string
  timeframe?: DirCheckTimeframe
  marketType: string
  regime: MarketRegime | null
  adx: number
  bias: 'BUY' | 'SELL' | 'NEUTRAL'
  recommended: 'scalp' | 'mirror'
  direction: 'BUY' | 'SELL' | 'HOLD'
  confidence: number
  reasons: string[]
  analyzedAt: string
  expiresAt?: string
  // Background confirmation done server-side AFTER the AI fan-out, using a
  // fresh live-price fetch. Status surfaces on the card so the operator can
  // see whether the recommendation was independently corroborated.
  confirmation?: {
    status: 'confirmed' | 'contradicted' | 'neutral' | 'unavailable'
    livePrice: number | null
    candleClose: number
    driftPips: number | null
    adjustment: number   // confidence delta already applied
  }
  error?: string
  simulated?: boolean
}

interface ScalpSignal {
  pair: string
  direction: 'BUY' | 'SELL' | 'HOLD'
  confidence: number
  entry: number
  sl: number
  tp: number
  reasons: string[]
  expiresAt: number
  fetchedAt: number
  fallback: boolean
  simulated?: boolean
  blocked?: boolean
  fetchError?: string
  // Regime-aware threshold metadata from /api/scalper/signal
  marketRegime?: MarketRegime | null
  effectiveMinStrength?: number | null
  suggestedSection?: 'mirror' | 'scalp' | null
  adx?: number | null
}

function Pager({ page, total, onPage }: { page: number; total: number; onPage: (p: number) => void }) {
  const pages = Math.ceil(total / PAGE_SIZE)
  if (pages <= 1) return null
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 10, paddingTop: 8 }}>
      <button onClick={() => onPage(page - 1)} disabled={page === 0} className="btn btn-ghost" style={{ fontSize: 11, padding: '4px 12px' }}>← Prev</button>
      <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{page + 1} / {pages}</span>
      <button onClick={() => onPage(page + 1)} disabled={page >= pages - 1} className="btn btn-ghost" style={{ fontSize: 11, padding: '4px 12px' }}>Next →</button>
    </div>
  )
}

// ── Signal Reconciliation badge ───────────────────────────────────────────────
// Fetches rolling win-rate stats for scalp vs mirror from /api/signal-reconciliation
// and renders a compact comparison badge. The badge shows which signal path is
// currently winning (higher win-rate over the last 50 resolved signals) so the
// operator can see at a glance whether the mirror edge is holding.
interface ReconStats {
  winRate: number | null
  n: number
  wins: number
  losses: number
  inconclusive: number
  inconclusiveRate: number | null
}

interface ReconResponse {
  noiseThresholdPips: number
  windows: Record<string, { scalp: ReconStats; mirror: ReconStats }>
  scalp: ReconStats
  mirror: ReconStats
}

function useSignalReconciliation(userId?: string) {
  const [stats, setStats] = useState<ReconResponse | null>(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!userId) { setStats(null); return }
    const uid = userId
    let cancelled = false
    async function fetch_() {
      setLoading(true)
      try {
        const res = await fetch(`/api/signal-reconciliation?userId=${encodeURIComponent(uid)}`)

        if (!res.ok) return
        const data = await res.json()
        if (!cancelled) setStats(data)
      } catch { /* keep stale on network error */ } finally {
        if (!cancelled) setLoading(false)
      }
    }
    fetch_()
    const id = setInterval(fetch_, 60_000) // refresh every minute
    return () => { cancelled = true; clearInterval(id) }
  }, [userId])

  return { stats, loading }
}

// Compact badge rendered in the SCALP SIGNALS / MIRROR TRADES section headers.
// Shows the win-rate for the given signal type plus a comparison arrow against
// the other type. Green when this type is winning, red when losing, muted when
// no data yet.
function ReconBadge({ stats, type }: { stats: ReconResponse | null; type: 'scalp' | 'mirror' }) {
  if (!stats) return null
  const mine   = stats[type]
  const other  = stats[type === 'scalp' ? 'mirror' : 'scalp']
  if (!mine || mine.n === 0) return null

  const mineRate  = mine.winRate
  const otherRate = other?.winRate ?? null
  const diff      = mineRate !== null && otherRate !== null ? mineRate - otherRate : null
  const isWinning = diff !== null && diff > 0
  const isLosing  = diff !== null && diff < 0
  const color     = isWinning ? 'var(--color-buy)' : isLosing ? 'var(--color-sell)' : 'var(--text-muted)'
  const arrow     = isWinning ? '▲' : isLosing ? '▼' : '—'

  return (
    <span
      title={`Last ${mine.n} resolved signals · ${mine.wins}W/${mine.losses}L/${mine.inconclusive} inc · noise threshold ${stats.noiseThresholdPips} pips`}
      style={{
        fontSize: 9, fontWeight: 700, letterSpacing: 1,
        padding: '2px 6px', borderRadius: 2,
        background: isWinning ? 'rgba(0,200,83,0.15)' : isLosing ? 'rgba(255,48,86,0.15)' : 'rgba(255,255,255,0.06)',
        color,
        fontFamily: 'JetBrains Mono',
        textTransform: 'uppercase',
        cursor: 'help',
      }}
    >
      {arrow} {mineRate !== null ? `${mineRate}%` : '—'} vs {otherRate !== null ? `${otherRate}%` : '—'}
    </span>
  )
}


interface AutoTradePageProps {
  strategy: StrategySettings
  onSaveStrategy: (s: StrategySettings) => Promise<unknown> | void
  // Server-side auto-trade gate (Fix 6). Reads from strategies table top-level
  // columns via /api/strategy. Worker reads the same row independently every
  // 5 min via loadStrategy(), so toggling here turns the 24/7 worker engine on
  // or off without needing the browser to stay open.
  autoTrade: AutoTradeGate
  onSaveAutoTrade: (partial: Partial<AutoTradeGate>) => Promise<{ error?: string }>
  account: any
  onToast: (msg: string, color?: string) => void
  newsInWindow?: boolean
  userId?: string
  prices?: Record<string, any>
  onRefreshAccount?: () => void
  onRefreshTrades?: () => void
  scanner: {
    enabled: boolean
    setEnabled: (v: boolean) => void
    scanning: boolean
    lastScan: Date | null
    countdown: number
    pendingSignals: ScanSignal[]
    diagnostics?: ScanDiagnostic[]
    error: string | null
    runScan: () => void
    rejectSignal: (s: ScanSignal) => void
    clearAll: () => void
  }
  timeframe: string
  setTimeframe: (tf: string) => void
  watchlist: string[]
}

export default function AutoTradePage({ strategy, onSaveStrategy, autoTrade, onSaveAutoTrade, account, onToast, newsInWindow = false, userId, prices = {}, onRefreshAccount, onRefreshTrades, scanner, timeframe, setTimeframe, watchlist: rawWatchlist }: AutoTradePageProps) {
  // Always restrict to metals — defensive filter in case AppShell passes extra pairs
  const watchlist = rawWatchlist.filter(p => METALS_ONLY.includes(p)).length
    ? rawWatchlist.filter(p => METALS_ONLY.includes(p))
    : METALS_ONLY
  const [approvingId, setApprovingId] = useState<string | null>(null)
  const [autoExecute, setAutoExecute] = useState(false)
  const [openTrades, setOpenTrades] = useState<any[]>([])
  const [closingId, setClosingId] = useState<string | null>(null)
  const [tradesLoading, setTradesLoading] = useState(false)
  const [openPage, setOpenPage] = useState(0)
  const autoExecutedRef = useRef<Set<string>>(new Set())
  const [scalpSignals, setScalpSignals] = useState<Record<string, ScalpSignal>>({})
  const [scalpTick, setScalpTick] = useState(0)  // increments every second for expiry countdown
  const [placingScalp, setPlacingScalp] = useState<string | null>(null)
  const [placingMirrorScalp, setPlacingMirrorScalp] = useState<string | null>(null)
  const [pfEnabled, setPfEnabled]     = useState(false)
  const [pfRiskCap, setPfRiskCap]     = useState<number | null>(null)  // null = not yet loaded

  // Direction-confirmation analysis: per-pair result of the 5+5 strategy
  // fan-out (see /api/scalper/direction-check). Re-runs only when the user
  // clicks the button — no auto-polling because each click costs 5 LLM
  // calls × number of metals (=10 calls per analysis).
  //
  // Cache-prevention guarantee (per operator brief): direction-check state
  // is held strictly in React useState — never written to localStorage,
  // sessionStorage, IndexedDB, or any persistent store. On page reload it
  // initialises empty, which renders the explicit "--" / "Awaiting Fresh
  // Analysis" default state in every card field. Do NOT add a persistence
  // layer here without re-reading that brief — it exists to keep stale
  // confirmations from influencing trade decisions across sessions.
  const [dirCheck, setDirCheck] = useState<Record<string, DirCheckResult | null>>({})
  const [dirCheckLoading, setDirCheckLoading] = useState(false)
  // Operator-selectable timeframe for the direction check. 5m matches the rest
  // of the scalp pipeline; 1m gives faster reads but noisier ADX/MACD.
  const [dirCheckTimeframe, setDirCheckTimeframe] = useState<DirCheckTimeframe>('5m')

  // Auto-trading toggles + sections + pairs now live in Supabase (top-level
  // columns on strategies via onSaveAutoTrade). UI-only preferences (profit
  // target % and fixed USD amount) stay in localStorage — these don't need
  // to be server-visible because the worker doesn't use them.
  const autoTradeEnabled = autoTrade.enabled
  const setAutoTradeEnabled = (v: boolean) => { void onSaveAutoTrade({ enabled: v }) }
  const [profitTargetPct, setProfitTargetPct] = useState<number>(() => {
    try { return parseInt(localStorage.getItem('at_targetPct') || '75', 10) } catch { return 75 }
  })
  const [fixedProfitUsd, setFixedProfitUsd] = useState<number>(() => {
    try { return parseFloat(localStorage.getItem('at_fixedUsd') || '0') } catch { return 0 }
  })
  // Max concurrent trades is sourced from strategy.maxPositions (single source of truth,
  // persisted to Supabase via /api/strategy). The button row below writes back via onSaveStrategy.
  const maxConcurrentTrades = strategy.maxPositions
  const setMaxConcurrentTrades = (n: number) => onSaveStrategy({ ...strategy, maxPositions: n })
  // Sections and pairs derive from the server-side autoTrade gate. The setters
  // accept a Set updater (matching the old API) and push the new value to Supabase.
  const autoSections = useMemo(() => new Set(autoTrade.sections), [autoTrade.sections])
  const setAutoSections = (updater: (prev: Set<string>) => Set<string>) => {
    const next = updater(new Set(autoTrade.sections))
    void onSaveAutoTrade({ sections: [...next] })
  }
  const autoPairs = useMemo(() => new Set(autoTrade.pairs), [autoTrade.pairs])
  const setAutoPairs = (updater: (prev: Set<string>) => Set<string>) => {
    const next = updater(new Set(autoTrade.pairs))
    void onSaveAutoTrade({ pairs: [...next] })
  }
  const autoScalpExecutedRef                      = useRef<Set<string>>(new Set())
  const lastAutoPlacedRef                         = useRef<Map<string, number>>(new Map())  // key=section-pair → last placement ms
  const lastPairPlacedRef                         = useRef<Map<string, number>>(new Map())  // key=pair → last placement ms across ALL sections (5-min cooldown)
  const closingForTargetRef                       = useRef<Set<string>>(new Set())
  const openTradesRef                             = useRef<any[]>([])
  const pricesRef                                 = useRef<Record<string, any>>(prices)
  const accountRef                                = useRef<any>(null)

  const accountBalance = account?.balance || 10000

  // Signal Reconciliation — rolling win-rate comparison between scalp and
  // mirror signal paths. Fetched from /api/signal-reconciliation every minute.
  const { stats: reconStats } = useSignalReconciliation(userId)

  const { enabled, setEnabled, scanning, lastScan, countdown, pendingSignals, diagnostics = [], error, runScan, rejectSignal, clearAll } = scanner


  // 1-second tick for expiry countdown display
  useEffect(() => {
    const id = setInterval(() => setScalpTick(t => t + 1), 1000)
    return () => clearInterval(id)
  }, [])

  // Fetch prop firm settings once to know if risk is capped
  useEffect(() => {
    authFetch('/api/prop-firm')
      .then(r => r.json())
      .then(({ settings }) => {
        if (!settings?.enabled) return
        const baseCap = settings.maxDailyLossPct / 2
        const cap = settings.consistencyRulePct > 0
          ? Math.min(baseCap, settings.consistencyRulePct)
          : baseCap
        setPfEnabled(true)
        setPfRiskCap(cap)
      })
      .catch(() => {})
  }, [])

  const fetchScalpSignalForPair = useCallback(async (pair: string) => {
    try {
      // Step 1: fetch live indicators for this pair
      const tfRes = await fetch(`/api/scalper/tick?pair=${encodeURIComponent(pair)}&timeframe=5m`, {
        cache: 'no-store',
      })
      if (!tfRes.ok) {
        setScalpSignals(prev => {
          const existing = prev[pair]
          // Keep last valid signal if one exists; just tag it with the error
          if (existing && existing.direction !== 'HOLD') return { ...prev, [pair]: { ...existing, fetchError: `tick ${tfRes.status}` } }
          return { ...prev, [pair]: { pair, direction: 'HOLD', confidence: 0, entry: 0, sl: 0, tp: 0,
            reasons: [], expiresAt: 0, fetchedAt: Date.now(), fallback: false, fetchError: `tick ${tfRes.status}` } }
        })
        return
      }
      const tick = await tfRes.json()

      if (tick.simulated) {
        setScalpSignals(prev => ({
          ...prev,
          [pair]: { pair, direction: 'HOLD', confidence: 0, entry: tick.price, sl: tick.price, tp: tick.price,
            reasons: ['Live MT5 data required — simulated feed'], expiresAt: 0, fetchedAt: Date.now(), fallback: false, blocked: true, simulated: true },
        }))
        return
      }

      // Step 2: call scalp signal API
      const sigRes = await fetch('/api/scalper/signal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...tick, pair, strategy: 'Scalp', userId }),
      })
      if (!sigRes.ok) {
        setScalpSignals(prev => {
          const existing = prev[pair]
          if (existing && existing.direction !== 'HOLD') return { ...prev, [pair]: { ...existing, fetchError: `signal ${sigRes.status}` } }
          return { ...prev, [pair]: { pair, direction: 'HOLD', confidence: 0, entry: tick.price, sl: tick.price, tp: tick.price,
            reasons: [], expiresAt: 0, fetchedAt: Date.now(), fallback: false, fetchError: `signal ${sigRes.status}` } }
        })
        return
      }
      const sig = await sigRes.json()

      setScalpSignals(prev => ({
        ...prev,
        [pair]: {
          pair,
          direction:  sig.direction,
          confidence: sig.confidence,
          entry:      sig.entry  || tick.price,
          sl:         sig.sl     || tick.price,
          tp:         sig.tp     || tick.price,
          reasons:    sig.reasons || [],
          expiresAt:  Date.now() + SCALP_EXPIRY_MS,
          fetchedAt:  Date.now(),
          fallback:   sig.fallback ?? false,
          marketRegime:         sig.marketRegime ?? null,
          effectiveMinStrength: sig.effectiveMinStrength ?? null,
          suggestedSection:     sig.suggestedSection ?? null,
          adx:                  sig.adx ?? null,
          // fetchError cleared on success
        },
      }))
    } catch (err: any) {
      const msg = err?.message || 'Network error'
      setScalpSignals(prev => {
        const existing = prev[pair]
        if (existing && existing.direction !== 'HOLD') return { ...prev, [pair]: { ...existing, fetchError: msg } }
        return { ...prev, [pair]: { pair, direction: 'HOLD', confidence: 0, entry: 0, sl: 0, tp: 0,
          reasons: [], expiresAt: 0, fetchedAt: Date.now(), fallback: false, fetchError: msg } }
      })
    }
  }, [userId])

  // Direction-confirmation runner. Fires the 5-strategy fan-out for each
  // metal in parallel. Triggered only by the manual button — does not poll.
  const runDirectionCheck = useCallback(async () => {
    setDirCheckLoading(true)
    try {
      await Promise.all(METALS_ONLY.map(async pair => {
        try {
          const r = await fetch('/api/scalper/direction-check', {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({ pair, userId, timeframe: dirCheckTimeframe }),
          })
          const j: DirCheckResult & { error?: string } = await r.json()
          setDirCheck(prev => ({ ...prev, [pair]: j }))
        } catch (err: any) {
          setDirCheck(prev => ({
            ...prev,
            [pair]: {
              pair, marketType: '—', regime: null, adx: 0, bias: 'NEUTRAL',
              recommended: 'scalp', direction: 'HOLD', confidence: 0,
              reasons: [], analyzedAt: new Date().toISOString(),
              error: err?.message || 'Network error',
            },
          }))
        }
      }))
      // After the dir-check completes, re-fetch the scalp signal cards so both
      // the confirmation result and the per-pair signal cards reflect data
      // pulled from the same moment. Operator brief: "after each test check
      // is done reload the signal cards this way we have a fresh data for
      // both signal and market direction." Fire-and-forget — failures here
      // surface on the scalp cards via their own fetchError handling.
      METALS_ONLY.forEach(p => fetchScalpSignalForPair(p))
    } finally {
      setDirCheckLoading(false)
    }
  }, [userId, dirCheckTimeframe, fetchScalpSignalForPair])

  // Poll scalp signals for each metal pair
  useEffect(() => {
    METALS_ONLY.forEach(p => fetchScalpSignalForPair(p))
    const id = setInterval(() => {
      METALS_ONLY.forEach(p => fetchScalpSignalForPair(p))
    }, SCALP_REFRESH_MS)
    return () => clearInterval(id)
  }, [fetchScalpSignalForPair])

  const loadOpenTrades = useCallback(async (): Promise<any[]> => {
    if (!userId) return openTradesRef.current
    setTradesLoading(true)
    try {
      const res = await fetch(`/api/trades?userId=${userId}&result=OPEN`, { cache: 'no-store' })
      const data = await res.json()
      const trades: any[] = data.trades || []
      setOpenTrades(trades)
      openTradesRef.current = trades  // update ref immediately — don't wait for React re-render cycle
      return trades
    } catch { return openTradesRef.current } finally {
      setTradesLoading(false)
    }
  }, [userId])

  useEffect(() => { loadOpenTrades() }, [loadOpenTrades])

  // Account-switch reaction: when the active broker name changes (account.broker)
  // OR the broker_configs row was just re-activated (account.lastSwitchedAt), clear
  // the per-pair and per-section cooldown trackers so the new account isn't
  // throttled by stale state from the previous one.
  const accountBroker = account?.broker as string | undefined
  const accountSwitchedAt = account?.lastSwitchedAt as string | undefined
  useEffect(() => {
    if (!accountBroker && !accountSwitchedAt) return
    lastPairPlacedRef.current.clear()
    lastAutoPlacedRef.current.clear()
    autoScalpExecutedRef.current.clear()
    console.log(`[auto] Account switched (broker=${accountBroker || '?'} switchedAt=${accountSwitchedAt || '—'}) — pair cooldowns reset`)
  }, [accountBroker, accountSwitchedAt])
  useEffect(() => { openTradesRef.current = openTrades }, [openTrades])
  useEffect(() => { pricesRef.current = prices }, [prices])
  useEffect(() => { accountRef.current = account }, [account])

  // Persist auto-trade settings to localStorage on every change
  // at_enabled, at_sections, at_pairs are now server-side via onSaveAutoTrade.
  // Only the two UI-only preferences remain in localStorage.
  useEffect(() => { try { localStorage.setItem('at_targetPct', String(profitTargetPct))         } catch {} }, [profitTargetPct])
  useEffect(() => { try { localStorage.setItem('at_fixedUsd',  String(fixedProfitUsd))          } catch {} }, [fixedProfitUsd])

  // Circuit-breaker state — armed by mt5-sync after a close with loss >1R.
  // Read from account.circuitBreakerUntil (set by /api/account from the active
  // broker_configs row). A 1Hz ticker drives the countdown display until the
  // timestamp expires, then we revert to normal display + toast "cleared".
  const [circuitBreakerUntil, setCircuitBreakerUntil] = useState<number | null>(null)
  const [cbCountdown,         setCbCountdown]         = useState<string>('')
  const cbAcknowledgedRef = useRef<number | null>(null)  // dedup the "cleared" toast

  useEffect(() => {
    const ts = account?.circuitBreakerUntil ? new Date(account.circuitBreakerUntil).getTime() : null
    if (ts && ts > Date.now()) {
      setCircuitBreakerUntil(ts)
    } else if (!ts) {
      setCircuitBreakerUntil(null)
    }
  }, [account?.circuitBreakerUntil])

  useEffect(() => {
    if (!circuitBreakerUntil) return
    const tick = () => {
      const remaining = circuitBreakerUntil - Date.now()
      if (remaining <= 0) {
        // Fire the "cleared" toast once per CB-activation only.
        if (cbAcknowledgedRef.current !== circuitBreakerUntil) {
          cbAcknowledgedRef.current = circuitBreakerUntil
          onToast?.('✅ Circuit breaker cleared — auto-trade resumed', '#00ff87')
        }
        setCircuitBreakerUntil(null)
        setCbCountdown('')
        return
      }
      const mins = Math.floor(remaining / 60000)
      const secs = Math.floor((remaining % 60000) / 1000)
      setCbCountdown(`${mins}:${secs.toString().padStart(2, '0')}`)
    }
    tick()
    const id = setInterval(tick, 1000)
    return () => clearInterval(id)
  }, [circuitBreakerUntil, onToast])

  // Poll /api/worker/status every 30s so the indicator panel can show whether the
  // 24/7 worker engine will actually execute orders (PAPER = decision-log only,
  // LIVE = real orders). Critical pairing with autoTrade.enabled — both must be
  // true for the worker to autonomously place trades.
  const [workerStatus, setWorkerStatus] = useState<{ mode: string | null; isAlive: boolean; lastSeenAgeS: number | null } | null>(null)
  useEffect(() => {
    let cancelled = false
    const fetchStatus = async () => {
      try {
        const res = await authFetch('/api/worker/status')
        if (!res.ok) return
        const d = await res.json()
        if (!cancelled) setWorkerStatus({ mode: d.mode || null, isAlive: !!d.isAlive, lastSeenAgeS: d.lastSeenAgeS ?? null })
      } catch { /* keep last */ }
    }
    fetchStatus()
    const id = setInterval(fetchStatus, 30_000)
    return () => { cancelled = true; clearInterval(id) }
  }, [])

  // Sync profit target to EA — fires whenever either component changes.
  // Sends both components (fixedUsd, targetPct) and the precomputed close amount so the EA
  // can apply the formula itself: profitCloseAmount = fixedUsd × (targetPct / 100)
  useEffect(() => {
    const profitCloseAmount = fixedProfitUsd > 0 ? fixedProfitUsd * profitTargetPct / 100 : 0
    authFetch('/api/broker/profit-target', {
      method: 'POST',
      body: JSON.stringify({
        value:     profitCloseAmount,
        fixedUsd:  fixedProfitUsd,
        targetPct: profitTargetPct,
      }),
    }).catch(() => {})
  }, [fixedProfitUsd, profitTargetPct])

  async function placeOrder(signal: ScanSignal) {
    // Always use live price at order time; fall back to scan-time price if feed unavailable
    const livePrice = prices[signal.pair]?.bid || signal.currentPrice
    const res = await authFetch('/api/orders', {
      method: 'POST',
      body: JSON.stringify({
        pair: signal.pair,
        direction: signal.direction,
        strategy,
        currentPrice: livePrice,
        newsInWindow,
        aiConfidence: signal.confidence,
        checklistScore: signal.checklistScore,
        userId,
        signalId: signal.id,
        signalTimestamp: signal.scannedAt,
        maxConcurrentTrades,
        // Audit metadata — scan path uses strategy.slPips/tpPips directly (no clamp),
        // so source == clamped values. Confidence and signal id come from the scan signal.
        source:            'scan',
        source_sl_pips:    strategy.slPips,
        source_tp_pips:    strategy.tpPips,
        signal_at:         signal.scannedAt,
        signal_confidence: signal.confidence,
        signal_id_ref:     signal.id?.toString(),
      }),
    })
    return res.json()
  }

  async function handleApprove(signal: ScanSignal) {
    setApprovingId(signal.id)
    try {
      const data = await placeOrder(signal)
      if (data.blocked) {
        onToast('Blocked: ' + (data.reasons?.[0] || 'Risk rule'), '#ff3056')
      } else if (data.success) {
        onToast(`✓ ${signal.direction} ${signal.pair} — ${data.lots} lots queued for broker`, DIR_COLOR[signal.direction])
        rejectSignal(signal)
        loadOpenTrades()
        onRefreshTrades?.()
        setTimeout(() => onRefreshAccount?.(), 1500)
      } else {
        onToast('Order failed: ' + (data.error || 'Unknown'), '#ff3056')
      }
    } catch (e: any) {
      onToast('Error: ' + e.message, '#ff3056')
    } finally {
      setApprovingId(null)
    }
  }

  async function handleScalpOrder(sig: ScalpSignal) {
    if (placingScalp) return
    setPlacingScalp(sig.pair)
    try {
      const pip = getPipValue(sig.pair)
      // Option C clamp + broker min-stop widening (lib/trade-levels.ts) — the
      // exact pips /api/orders will place. The raw derived value is still
      // passed as source_sl_pips for clamp-impact auditing.
      const derivedSlPips = sig.sl !== sig.entry ? Math.abs(sig.entry - sig.sl) / pip : strategy.slPips
      const derivedTpPips = sig.tp !== sig.entry ? Math.abs(sig.entry - sig.tp) / pip : strategy.tpPips
      const { slPips: scalpSlPips, tpPips: scalpTpPips } =
        execSlTpPips(sig.pair, derivedSlPips, derivedTpPips, strategy.slPips, strategy.tpPips)
      // Re-anchor to live bid/ask so OANDA/Capital adapters compute SL/TP off
      // the actual fill price, not the candle close. MT5 Direct does its own
      // re-anchoring server-side; this is a no-op there.
      const live = liveAnchoredLevels(sig, prices, sig.direction === 'BUY' ? 'BUY' : 'SELL',
        { slDist: scalpSlPips * pip, tpDist: scalpTpPips * pip })
      const data = await authFetch('/api/orders', {
        method: 'POST',
        body: JSON.stringify({
          pair:            sig.pair,
          direction:       sig.direction,
          strategy:        { ...strategy, slPips: scalpSlPips, tpPips: scalpTpPips },
          currentPrice:    live.entry,
          signalPrice:     sig.entry,
          livePriceUsed:   live.isLive,
          newsInWindow,
          aiConfidence:    sig.confidence,
          checklistScore:  5,
          userId,
          signalId:        `scalp-${sig.pair.replace('/', '')}-${sig.fetchedAt}`,
          signalTimestamp: new Date(sig.fetchedAt).toISOString(),
          maxConcurrentTrades,
          source:            'scalp',
          source_sl_pips:    derivedSlPips,
          source_tp_pips:    derivedTpPips,
          signal_at:         new Date(sig.fetchedAt).toISOString(),
          signal_confidence: sig.confidence,
          signal_id_ref:     `scalp-${sig.pair.replace('/', '')}-${sig.fetchedAt}`,
        }),
      }).then(r => r.json())

      if (data.blocked) {
        onToast('Blocked: ' + (data.reasons?.[0] || 'Risk rule'), '#ff3056')
      } else if (data.success) {
        onToast(`✓ ${sig.direction} ${sig.pair} — ${data.lots} lots queued`, DIR_COLOR[sig.direction])
        loadOpenTrades()
        onRefreshTrades?.()
        setTimeout(() => onRefreshAccount?.(), 1500)
      } else {
        onToast('Order failed: ' + (data.error || 'Unknown'), '#ff3056')
      }
    } catch (e: any) {
      onToast('Error: ' + e.message, '#ff3056')
    } finally {
      setPlacingScalp(null)
    }
  }

  async function handleMirrorScalpOrder(sig: ScalpSignal) {
    if (placingMirrorScalp) return
    setPlacingMirrorScalp(sig.pair)
    try {
      const mirrorDir: 'BUY' | 'SELL' = sig.direction === 'BUY' ? 'SELL' : 'BUY'
      const pip = getPipValue(sig.pair)
      // Option C clamp + broker min-stop widening (lib/trade-levels.ts).
      const derivedSlPips = sig.sl !== sig.entry ? Math.abs(sig.entry - sig.sl) / pip : strategy.slPips
      const derivedTpPips = sig.tp !== sig.entry ? Math.abs(sig.entry - sig.tp) / pip : strategy.tpPips
      const { slPips, tpPips } =
        execSlTpPips(sig.pair, derivedSlPips, derivedTpPips, strategy.slPips, strategy.tpPips)
      // Re-anchor to live bid/ask in the mirror direction so the mirrored
      // SL/TP track the actual fill price instead of the candle close.
      const live = liveAnchoredLevels(sig, prices, mirrorDir,
        { slDist: slPips * pip, tpDist: tpPips * pip })
      const mirrorSl = live.sl
      const mirrorTp = live.tp
      const data = await authFetch('/api/orders', {
        method: 'POST',
        body: JSON.stringify({
          pair:           sig.pair,
          direction:      mirrorDir,
          strategy:       { ...strategy, slPips, tpPips },
          currentPrice:   live.entry,
          signalPrice:    sig.entry,
          livePriceUsed:  live.isLive,
          newsInWindow,
          aiConfidence:   sig.confidence,
          checklistScore: 5,
          userId,
          signalId:       `mirror-${sig.pair.replace('/', '')}-${sig.fetchedAt}`,
          mirrorSl,
          mirrorTp,
          maxConcurrentTrades,
          source:            'mirror',
          source_sl_pips:    derivedSlPips,
          source_tp_pips:    derivedTpPips,
          signal_at:         new Date(sig.fetchedAt).toISOString(),
          signal_confidence: sig.confidence,
          signal_id_ref:     `mirror-${sig.pair.replace('/', '')}-${sig.fetchedAt}`,
        }),
      }).then(r => r.json())

      if (data.blocked) {
        onToast('Blocked: ' + (data.reasons?.[0] || 'Risk rule'), '#ff3056')
      } else if (data.success) {
        onToast(`✓ MIRROR ${mirrorDir} ${sig.pair} — ${data.lots} lots queued`, DIR_COLOR[mirrorDir])
        loadOpenTrades()
        onRefreshTrades?.()
        setTimeout(() => onRefreshAccount?.(), 1500)
      } else {
        onToast('Order failed: ' + (data.error || 'Unknown'), '#ff3056')
      }
    } catch (e: any) {
      onToast('Error: ' + e.message, '#ff3056')
    } finally {
      setPlacingMirrorScalp(null)
    }
  }

  // Shared order placement for auto-trader — no UI loading state side-effects
  async function autoPlaceOrder(sig: ScalpSignal, isMirror: boolean): Promise<boolean> {
    const pip = getPipValue(sig.pair)
    // Option C clamp + broker min-stop widening (lib/trade-levels.ts).
    const derivedSlPips = sig.sl !== sig.entry ? Math.abs(sig.entry - sig.sl) / pip : strategy.slPips
    const derivedTpPips = sig.tp !== sig.entry ? Math.abs(sig.entry - sig.tp) / pip : strategy.tpPips
    const { slPips, tpPips } =
      execSlTpPips(sig.pair, derivedSlPips, derivedTpPips, strategy.slPips, strategy.tpPips)
    const direction: 'BUY' | 'SELL' = isMirror
      ? (sig.direction === 'BUY' ? 'SELL' : 'BUY')
      : (sig.direction as 'BUY' | 'SELL')
    const prefix    = isMirror ? 'mirror' : 'scalp'
    const signalRef = `${prefix}-${sig.pair.replace('/', '')}-${sig.fetchedAt}`
    // Re-anchor to live bid/ask in the order direction so the broker adapter
    // computes SL/TP off the actual fill price.
    const live = liveAnchoredLevels(sig, prices, direction,
      { slDist: slPips * pip, tpDist: tpPips * pip })
    const body: Record<string, any> = {
      pair: sig.pair, direction,
      strategy:             { ...strategy, slPips, tpPips },
      currentPrice:         live.entry,
      signalPrice:          sig.entry,
      livePriceUsed:        live.isLive,
      newsInWindow,
      aiConfidence:         sig.confidence,
      checklistScore:       5,
      userId,
      signalId:             signalRef,
      maxConcurrentTrades,  // server enforces the same limit as the UI
      source:               isMirror ? 'mirror' : 'scalp',
      source_sl_pips:       derivedSlPips,
      source_tp_pips:       derivedTpPips,
      signal_at:            new Date(sig.fetchedAt).toISOString(),
      signal_confidence:    sig.confidence,
      signal_id_ref:        signalRef,
    }
    if (isMirror) {
      body.mirrorSl = live.sl
      body.mirrorTp = live.tp
    }
    try {
      const data = await authFetch('/api/orders', { method: 'POST', body: JSON.stringify(body) }).then(r => r.json())
      return !!data.success && !data.blocked
    } catch { return false }
  }

  // Auto-execute: fire approved order as soon as signal arrives
  useEffect(() => {
    if (!autoExecute || !enabled) return
    for (const signal of pendingSignals) {
      if (autoExecutedRef.current.has(signal.id)) continue
      if (openTradesRef.current.length >= maxConcurrentTrades) break  // pre-check before API call
      autoExecutedRef.current.add(signal.id)
      placeOrder(signal).then(data => {
        if (data.blocked) {
          onToast(`Auto-blocked ${signal.pair}: ${data.reasons?.[0]}`, '#ff3056')
        } else if (data.success) {
          onToast(`⚡ Auto: ${signal.direction} ${signal.pair} — ${data.lots} lots`, DIR_COLOR[signal.direction])
          rejectSignal(signal)
          loadOpenTrades()
          onRefreshTrades?.()
          setTimeout(() => onRefreshAccount?.(), 1500)
        } else {
          onToast(`Auto failed ${signal.pair}: ${data.error}`, '#ff3056')
        }
      }).catch(e => onToast('Auto error: ' + e.message, '#ff3056'))
    }
  }, [pendingSignals, autoExecute, enabled]) // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-trade execution: DISABLED in the browser. The worker (workers/scalper.mjs)
  // is the single owner of auto-trade placement to prevent same-second duplicate
  // orders that were causing paired retcode 10016 cancellations (e.g. 10:50, 11:16
  // on 2026-06-08 — browser and worker both firing within the same EA polling
  // window). Manual scalp/mirror buttons still work; this only stops the loop.
  //
  // If you need to re-enable browser execution (e.g. worker outage), revert this
  // hunk — the full logic is preserved in git history at commit a63843d~1.
  useEffect(() => {
    if (!autoTradeEnabled) return
    // No-op: worker is the execution owner. The loop body is intentionally empty.
  }, [scalpSignals, autoTradeEnabled, strategy.maxPositions, strategy.minStrength, circuitBreakerUntil]) // eslint-disable-line react-hooks/exhaustive-deps

  // Worker-placed trade notifications via Supabase Realtime.
  // Subscribes to INSERTs on the trades table filtered by user_id. Fires a toast
  // and refreshes the open-trades list whenever the worker (or any other source)
  // places a new trade. UPDATEs (close events) also fire so the user sees the
  // outcome land. Restores the toast that the disabled browser auto-loop used
  // to provide for browser-fired trades.
  useEffect(() => {
    if (!userId) return
    const sb = getSupabase()
    const channel = sb
      .channel(`trades-realtime-${userId}`)
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'trades', filter: `user_id=eq.${userId}` },
        (payload) => {
          const t = (payload as any).new || {}
          const color = t.direction === 'BUY' ? DIR_COLOR.BUY : DIR_COLOR.SELL
          const conf  = t.signal_confidence ? ` ${t.signal_confidence}%` : ''
          const src   = t.source ? ` (${t.source})` : ''
          onToast?.(`⚡ ${t.direction} ${t.pair}${src}${conf}`, color)
          loadOpenTrades()
          onRefreshTrades?.()
          setTimeout(() => onRefreshAccount?.(), 1500)
        }
      )
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'trades', filter: `user_id=eq.${userId}` },
        (payload) => {
          const t   = (payload as any).new || {}
          const old = (payload as any).old || {}
          // Only toast on result transitions (OPEN → WIN/LOSS/CANCELLED/CLOSED).
          if (!old.result || old.result === t.result || old.result !== 'OPEN') return
          const isWin = t.result === 'WIN'
          const color = isWin ? '#00e5b4' : t.result === 'LOSS' ? '#ff3056' : '#888'
          const pl = typeof t.pl_usd === 'number'
            ? (t.pl_usd >= 0 ? `+$${t.pl_usd.toFixed(2)}` : `-$${Math.abs(t.pl_usd).toFixed(2)}`)
            : ''
          onToast?.(`${isWin ? '✓' : t.result === 'LOSS' ? '✗' : '○'} ${t.direction} ${t.pair} ${t.result} ${pl}`.trim(), color)
          loadOpenTrades()
          onRefreshTrades?.()
          setTimeout(() => onRefreshAccount?.(), 1000)
        }
      )
      .subscribe()
    return () => { sb.removeChannel(channel) }
  }, [userId]) // eslint-disable-line react-hooks/exhaustive-deps

  // Profit target monitoring — 2s interval
  // Close threshold = fixedProfitUsd × profitTargetPct / 100
  // e.g. $1.00 fixed × 50% = close at $0.50 floating profit
  //
  // Profit source priority:
  //   1. EA's actual unrealizedPL from account.openTrades (MT5 account-currency P&L,
  //      includes commission/swap, uses real contract spec — most accurate)
  //   2. Computed from live bid + entry price via pip constants (fallback)
  //
  // closingForTargetRef lifecycle:
  //   ADD  when close is triggered
  //   REMOVE only when the trade is gone from the open-trades list (confirmed gone from DB)
  //   Never remove in .finally() — doing so causes re-trigger every 2s until EA closes
  useEffect(() => {
    if (!autoTradeEnabled) return
    const id = setInterval(async () => {
      const trades = await loadOpenTrades()

      // Remove guard entries for trades that are no longer OPEN in DB
      for (const guardId of [...closingForTargetRef.current]) {
        if (!trades.some((t: any) => t.id === guardId)) {
          closingForTargetRef.current.delete(guardId)
        }
      }

      // No target configured — nothing to monitor
      const profitCloseAmount = fixedProfitUsd > 0 ? fixedProfitUsd * profitTargetPct / 100 : 0
      if (profitCloseAmount <= 0) return

      for (const trade of trades) {
        if (closingForTargetRef.current.has(trade.id)) continue

        const pip     = getPipValue(trade.pair)
        const pvpl    = getPipValuePerLot(trade.pair)
        const pairKey = trade.pair.replace('/', '')
        const entry   = trade.entry_price ?? 0
        const lots    = trade.lots        ?? 0

        // Prefer EA's live unrealizedPL; fall back to computed from bid price
        let currentProfit: number | null = null
        const eaPos = (accountRef.current?.openTrades as any[] | undefined)?.find(p => {
          const sym = String(p.pair || p.symbol || '').replace('/', '')
          return sym === pairKey && p.direction === trade.direction
        })
        if (eaPos?.unrealizedPL != null) {
          currentProfit = Number(eaPos.unrealizedPL)
        } else if (entry && lots) {
          const liveBid = pricesRef.current[trade.pair]?.bid ?? pricesRef.current[pairKey]?.bid
          if (liveBid) {
            const pipsGained = trade.direction === 'BUY'
              ? (liveBid - entry) / pip
              : (entry - liveBid) / pip
            currentProfit = pipsGained * pvpl * lots
          }
        }

        if (currentProfit == null) continue
        if (currentProfit <= 0) continue

        console.debug(`[profit-monitor] ${trade.pair} ${trade.direction}: $${currentProfit.toFixed(2)} | target=$${profitCloseAmount.toFixed(2)} ($${fixedProfitUsd} × ${profitTargetPct}%)`)

        // 10% buffer above nominal target — same cushion as the EA — so close fills
        // comfortably above the target after browser→server→EA→broker execution delay.
        const profitTrigger = profitCloseAmount * 1.10
        if (currentProfit >= profitTrigger) {
          const snap = { pair: trade.pair, profit: currentProfit, target: profitCloseAmount, trigger: profitTrigger }
          console.log(`[profit-monitor] CLOSE ${snap.pair}: $${snap.profit.toFixed(2)} >= trigger $${snap.trigger.toFixed(2)} (nominal $${snap.target.toFixed(2)} +10%)`)
          closingForTargetRef.current.add(trade.id)
          handleClose(trade)
            .then(ok => { if (ok) onToast(`⚡ Auto-closed ${snap.pair} @ $${snap.target.toFixed(2)} target (+$${snap.profit.toFixed(2)})`, '#00e5b4') })
        }
      }
    }, 2000)
    return () => clearInterval(id)
  }, [autoTradeEnabled, profitTargetPct, fixedProfitUsd, loadOpenTrades]) // eslint-disable-line react-hooks/exhaustive-deps

  async function handleClose(trade: any): Promise<boolean> {
    setClosingId(trade.id)
    try {
      const res = await authFetch('/api/close-trade', {
        method: 'POST',
        body: JSON.stringify({
          tradeId: trade.id,
          userId,
          pair: trade.pair,
          direction: trade.direction,
        }),
      })
      const data = await res.json()
      if (data.success) {
        loadOpenTrades()
        onRefreshTrades?.()
        setTimeout(() => onRefreshAccount?.(), 1500)
        return true
      } else {
        onToast('Close failed: ' + (data.error || 'Unknown'), '#ff3056')
        return false
      }
    } catch (e: any) {
      onToast('Close error: ' + e.message, '#ff3056')
      return false
    } finally {
      setClosingId(null)
    }
  }

  const fmtCountdown = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`

  // Session status — recomputed every render (scalpTick fires once per second).
  // Mirrors the day-aware block inside the auto-trade useEffect so UI matches
  // behaviour. Sunday 22-23 is the weekly market open (allowed); Mon-Sat 20-23
  // London-NY overlap allowlist 2026-06-09 (tightened): trade 12:00-13:59 UTC
  // weekdays only. Hourly P/L showed mirror edge degrades sharply after 13:00.
  // Single positive rule replaces prior daily-close + sun-preopen + session-bias.
  const _scalpTickRef = scalpTick  // reference so React tracks re-renders
  void _scalpTickRef
  const _utcNow   = new Date()
  const _utcHour  = _utcNow.getUTCHours()
  const _utcMin   = _utcNow.getUTCMinutes()
  const _utcDay   = _utcNow.getUTCDay()
  const _utcLabel = _utcNow.toISOString().slice(11, 19)
  const _isWeekday = _utcDay >= 1 && _utcDay <= 5
  const isLondonNYOverlap = _isWeekday && _utcHour >= 12 && _utcHour < 14
  const sessionBlocked    = !isLondonNYOverlap
  // Time-until / time-remaining helpers — recomputed each render via scalpTick.
  function fmtHM(mins: number) {
    const h = Math.floor(mins / 60); const m = mins % 60
    return h > 0 ? `${h}h ${m}m` : `${m}m`
  }
  function timeUntilNextOverlap() {
    if (_isWeekday && _utcHour < 12) return `Today 12:00 UTC (in ${fmtHM((12 - _utcHour) * 60 - _utcMin)})`
    if (_utcDay >= 1 && _utcDay <= 4 && _utcHour >= 14) return `Tomorrow 12:00 UTC (in ${fmtHM((24 - _utcHour + 12) * 60 - _utcMin)})`
    if (_utcDay === 5 && _utcHour >= 14) return 'Monday 12:00 UTC'
    if (_utcDay === 6) return 'Monday 12:00 UTC'
    if (_utcDay === 0) return 'Monday 12:00 UTC'
    return 'calculating…'
  }
  function timeRemainingInWindow() {
    return fmtHM((14 - _utcHour) * 60 - _utcMin) + ' remaining'
  }
  const sessionLabel = isLondonNYOverlap ? 'London-NY Overlap' : 'Overlap Closed'
  const sessionColor = isLondonNYOverlap ? '#00e5b4' : '#6b7280'

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>

      {/* ── Session Status Banner — surfaces the Asian/Close auto block ─── */}
      <div style={{
        background:   sessionBlocked ? 'rgba(255,48,86,0.08)' : `${sessionColor}12`,
        border:       `1px solid ${sessionBlocked ? 'rgba(255,48,86,0.35)' : `${sessionColor}40`}`,
        borderRadius: 5,
        padding:      '10px 14px',
        display:      'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          {/* Circuit-breaker label takes priority over the normal session label when active */}
          <span style={{
            fontSize: 10, fontWeight: 700, letterSpacing: 1.5,
            color: circuitBreakerUntil ? '#dc2626' : sessionColor,
            padding: '3px 8px', borderRadius: 3,
            background: circuitBreakerUntil ? 'rgba(220,38,38,0.18)' : `${sessionColor}22`,
          }}>
            {circuitBreakerUntil ? '⚡ CIRCUIT BREAKER' : sessionLabel.toUpperCase()}
          </span>
          <span className="mono" style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
            {_utcLabel} UTC
          </span>
        </div>
        <div style={{ fontSize: 11, fontWeight: 700, color: circuitBreakerUntil ? '#dc2626' : (sessionBlocked ? '#6b7280' : '#00e5b4') }}>
          {circuitBreakerUntil
            ? `⚡ AUTO-TRADE PAUSED · ${cbCountdown} remaining`
            : (autoTradeEnabled
              ? (sessionBlocked
                  ? `⏸ OUTSIDE OVERLAP — next: ${timeUntilNextOverlap()}`
                  : `▶ OVERLAP ACTIVE · ${timeRemainingInWindow()}`)
              : '○ Auto-trading off')}
        </div>
      </div>

      {/* ── Circuit Breaker Banner — only renders when CB is active ───────────── */}
      {circuitBreakerUntil && cbCountdown && (
        <div className="circuit-breaker-banner">
          <div className="circuit-breaker-icon">⚡</div>
          <div className="circuit-breaker-content">
            <div className="circuit-breaker-title">CIRCUIT BREAKER ACTIVE</div>
            <div className="circuit-breaker-subtitle">
              Auto-trade paused after large loss — resuming in
            </div>
            <div className="circuit-breaker-countdown">{cbCountdown}</div>
          </div>
          <div className="circuit-breaker-reason">
            Protecting against compounding losses
          </div>
        </div>
      )}

      {/* ── Worker Engine Status — Fix 6 (24/7 server-side mirror exec) ─────── */}
      {(() => {
        const mirrorEngineEnabled = autoTrade.enabled
        const mode                = workerStatus?.mode || 'unknown'
        const isLive              = mode === 'live'
        const isPaper             = mode === 'paper'
        const workerAlive         = workerStatus?.isAlive === true
        // Critical mismatch: user has flipped auto_trade_enabled=true but worker
        // is still in paper. Code will log decisions but won't place real orders.
        const paperWhileEnabled = mirrorEngineEnabled && isPaper
        const accent = paperWhileEnabled ? '#ffb800'
          : (mirrorEngineEnabled && isLive ? '#00ff87'
            : '#607080')
        return (
          <div style={{
            background:   `${accent}10`,
            border:       `1px solid ${accent}40`,
            borderRadius: 5,
            padding:      '10px 14px',
            display:      'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12,
            flexWrap:     'wrap',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
              <span style={{
                fontSize: 10, fontWeight: 700, letterSpacing: 1.5,
                color: accent,
                padding: '3px 8px', borderRadius: 3,
                background: `${accent}22`,
              }}>
                24/7 WORKER ENGINE
              </span>
              <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                Mirror exec: <b style={{ color: mirrorEngineEnabled ? '#00ff87' : 'var(--text-muted)' }}>{mirrorEngineEnabled ? 'ENABLED' : 'OFF'}</b>
                <span style={{ margin: '0 8px', color: 'var(--text-dim)' }}>·</span>
                Mode: <b style={{ color: isLive ? '#00ff87' : isPaper ? '#ffb800' : 'var(--text-muted)' }}>{mode.toUpperCase()}</b>
                <span style={{ margin: '0 8px', color: 'var(--text-dim)' }}>·</span>
                Worker: <b style={{ color: workerAlive ? '#00ff87' : '#ff3056' }}>{workerAlive ? 'ALIVE' : 'OFFLINE'}</b>
              </span>
            </div>
            <div style={{ fontSize: 11, color: accent, fontWeight: 600, maxWidth: 540 }}>
              {paperWhileEnabled
                ? '⚠ Mirror exec enabled but worker is in PAPER mode — logs decisions only, no real orders. Set WORKER_MODE=live on DigitalOcean to enable 24/7 execution.'
                : mirrorEngineEnabled && isLive
                  ? '✓ Worker will autonomously execute even when this browser tab is closed.'
                  : '○ Browser must remain open for auto-trades to execute. Flip auto_trade_enabled=true and WORKER_MODE=live for 24/7 execution.'}
            </div>
          </div>
        )
      })()}

      {/* ── Auto Trading Control Panel ──────────────────────────────── */}
      <div style={{
        background: autoTradeEnabled ? 'rgba(0,229,180,0.05)' : 'rgba(255,255,255,0.02)',
        border: `1px solid ${autoTradeEnabled ? 'rgba(0,229,180,0.3)' : 'rgba(255,255,255,0.07)'}`,
        borderRadius: 5, padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 12,
      }}>
        {/* Toggle row */}
        <div className="at-toggle-row" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
          <div>
            <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: 2, color: autoTradeEnabled ? '#00e5b4' : 'var(--text-muted)' }}>
              AUTO TRADING
            </div>
            <div style={{ fontSize: 10, color: 'var(--text-dim)', marginTop: 2 }}>
              {autoTradeEnabled
                ? `Active · ${openTrades.length} / ${maxConcurrentTrades} trades open · ${fixedProfitUsd > 0 ? `close @ $${(fixedProfitUsd * profitTargetPct / 100).toFixed(2)}` : 'no target set'}`
                : 'Configure below then enable'}
            </div>
          </div>
          <button
            onClick={() => setAutoTradeEnabled(!autoTradeEnabled)}
            style={{
              padding: '8px 22px', borderRadius: 4, border: 'none', cursor: 'pointer',
              fontWeight: 700, fontSize: 13, letterSpacing: 1.5, flexShrink: 0,
              background: autoTradeEnabled ? 'rgba(0,229,180,0.18)' : 'rgba(255,255,255,0.06)',
              color: autoTradeEnabled ? '#00e5b4' : 'var(--text-muted)',
            }}
          >
            {autoTradeEnabled ? '● ON' : '○ OFF'}
          </button>
        </div>

        {/* Settings */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, opacity: autoTradeEnabled ? 1 : 0.7 }}>

          {/* Profit Target */}
          <div>
            <div style={{ fontSize: 9, color: 'var(--text-dim)', letterSpacing: 1.5, marginBottom: 6, fontWeight: 700 }}>
              FIXED USD TARGET — base close amount in dollars (0 = disabled)
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
              <span style={{ color: 'var(--text-muted)', fontSize: 13, fontWeight: 700 }}>$</span>
              <input
                type="number" min="0" step="0.25"
                value={fixedProfitUsd || ''}
                placeholder="0.00"
                onChange={e => setFixedProfitUsd(Math.max(0, parseFloat(e.target.value) || 0))}
                className="at-usd-input"
                style={{
                  border: `1px solid ${fixedProfitUsd > 0 ? 'rgba(0,229,180,0.4)' : 'rgba(255,255,255,0.1)'}`,
                  color: fixedProfitUsd > 0 ? '#00e5b4' : 'var(--text-muted)',
                }}
              />
              {fixedProfitUsd > 0 && (
                <button onClick={() => setFixedProfitUsd(0)} style={{
                  background: 'rgba(255,48,86,0.15)', color: '#ff3056', border: 'none',
                  borderRadius: 3, padding: '4px 10px', cursor: 'pointer', fontSize: 12, fontWeight: 700,
                }}>✕ Clear</button>
              )}
            </div>
            <div style={{ fontSize: 9, color: 'var(--text-dim)', letterSpacing: 1.5, marginBottom: 6, fontWeight: 700 }}>
              PROFIT TARGET (%) — close at this % of the Fixed USD Target
            </div>
            <div className="btn-pill-row">
              {[50, 65, 75, 100].map(pct => (
                <button key={pct} onClick={() => setProfitTargetPct(pct)} style={{
                  padding: '5px 14px', borderRadius: 3, border: 'none', cursor: 'pointer',
                  fontWeight: 700, fontSize: 12,
                  background: profitTargetPct === pct ? 'rgba(0,229,180,0.18)' : 'rgba(255,255,255,0.05)',
                  color: profitTargetPct === pct ? '#00e5b4' : 'var(--text-muted)',
                }}>{pct}%</button>
              ))}
            </div>
            {fixedProfitUsd > 0 && (
              <div style={{ fontSize: 10, color: '#00e5b4', marginTop: 6 }}>
                Active — closes at +${(fixedProfitUsd * profitTargetPct / 100).toFixed(2)} (${fixedProfitUsd.toFixed(2)} × {profitTargetPct}%)
              </div>
            )}
          </div>

          {/* Max Concurrent Trades */}
          <div>
            <div style={{ fontSize: 9, color: 'var(--text-dim)', letterSpacing: 1.5, marginBottom: 6, fontWeight: 700 }}>
              MAX CONCURRENT TRADES — maximum open positions at any time
            </div>
            <div className="btn-pill-row">
              {[1, 2, 3, 5, 10].map(n => (
                <button key={n} onClick={() => setMaxConcurrentTrades(n)} style={{
                  padding: '5px 14px', borderRadius: 3, border: 'none', cursor: 'pointer',
                  fontWeight: 700, fontSize: 12,
                  background: maxConcurrentTrades === n ? 'rgba(0,229,180,0.18)' : 'rgba(255,255,255,0.05)',
                  color: maxConcurrentTrades === n ? '#00e5b4' : 'var(--text-muted)',
                }}>{n}</button>
              ))}
            </div>
          </div>

          {/* Signal Sections */}
          <div>
            <div style={{ fontSize: 9, color: 'var(--text-dim)', letterSpacing: 1.5, marginBottom: 6, fontWeight: 700 }}>
              SIGNAL SECTIONS — choose which section to execute signals from
            </div>
            <div className="btn-pill-row">
              {[{ key: 'scalp', label: 'SCALP SIGNALS' }, { key: 'mirror', label: 'MIRROR TRADE' }].map(({ key, label }) => {
                const active = autoSections.has(key)
                return (
                  <button key={key} onClick={() => setAutoSections(prev => {
                    const next = new Set(prev)
                    active ? next.delete(key) : next.add(key)
                    return next
                  })} style={{
                    padding: '5px 14px', borderRadius: 3, border: 'none', cursor: 'pointer',
                    fontWeight: 700, fontSize: 11,
                    background: active ? 'rgba(96,192,255,0.15)' : 'rgba(255,255,255,0.05)',
                    color: active ? '#60c0ff' : 'var(--text-muted)',
                  }}>{label}</button>
                )
              })}
            </div>
          </div>

          {/* Pairs */}
          <div>
            <div style={{ fontSize: 9, color: 'var(--text-dim)', letterSpacing: 1.5, marginBottom: 6, fontWeight: 700 }}>
              PAIRS — only execute signals for selected instruments
            </div>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {METALS_ONLY.map(pair => {
                const active = autoPairs.has(pair)
                const label  = pair === 'XAU/USD' ? 'Gold · XAU/USD' : 'Silver · XAG/USD'
                return (
                  <button key={pair} onClick={() => setAutoPairs(prev => {
                    const next = new Set(prev)
                    active ? next.delete(pair) : next.add(pair)
                    return next
                  })} style={{
                    padding: '5px 14px', borderRadius: 3, border: 'none', cursor: 'pointer',
                    fontWeight: 700, fontSize: 11,
                    background: active ? 'rgba(255,200,0,0.12)' : 'rgba(255,255,255,0.05)',
                    color: active ? '#ffc800' : 'var(--text-muted)',
                  }}>{label}</button>
                )
              })}
            </div>
          </div>

          {/* Max trades status */}
          {autoTradeEnabled && (
            <div style={{
              display: 'flex', alignItems: 'center', gap: 8,
              padding: '7px 10px', borderRadius: 3,
              background: openTrades.length >= maxConcurrentTrades ? 'rgba(255,48,86,0.07)' : 'rgba(0,229,180,0.05)',
              border: `1px solid ${openTrades.length >= maxConcurrentTrades ? 'rgba(255,48,86,0.2)' : 'rgba(0,229,180,0.15)'}`,
            }}>
              <span style={{ fontSize: 12, color: openTrades.length >= maxConcurrentTrades ? 'var(--color-sell)' : '#00e5b4', fontWeight: 700 }}>
                {openTrades.length >= maxConcurrentTrades ? '⚠ Max trades reached' : '✓ Ready'}
              </span>
              <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                {openTrades.length} / {maxConcurrentTrades} active — new signals {openTrades.length >= maxConcurrentTrades ? 'paused' : 'will execute'}
              </span>
            </div>
          )}
        </div>
      </div>

      {/* Direction confirmation — manual 5+5 strategy fan-out per metal */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          paddingLeft: 2, gap: 12, flexWrap: 'wrap',
        }}>
          <div style={{ fontSize: 10, color: 'var(--text-dim)', letterSpacing: 2, fontWeight: 700 }}>
            CURRENT MARKET &amp; SIGNAL DIRECTION CONFIRMATION
          </div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'stretch' }}>
            {/* 1m / 5m segmented toggle — picks the candle timeframe the fan-out
                runs against. Disabled while an analysis is in flight. */}
            <div
              role="group"
              aria-label="Timeframe"
              style={{
                display: 'flex', alignItems: 'stretch',
                border: '1px solid rgba(255,255,255,0.12)', borderRadius: 2,
                overflow: 'hidden',
              }}
            >
              {(['1m', '5m'] as const).map(tf => {
                const active = dirCheckTimeframe === tf
                return (
                  <button
                    key={tf}
                    type="button"
                    onClick={() => setDirCheckTimeframe(tf)}
                    disabled={dirCheckLoading}
                    title={tf === '1m'
                      ? 'Run analysis on 1-minute candles — faster reads, noisier indicators'
                      : 'Run analysis on 5-minute candles — matches the rest of the scalp pipeline'}
                    style={{
                      fontSize: 11, padding: '6px 12px', letterSpacing: 1,
                      fontWeight: 700, fontFamily: 'JetBrains Mono',
                      background: active ? 'rgba(0,85,176,0.25)' : 'transparent',
                      color:      active ? 'var(--color-accent)' : 'var(--text-muted)',
                      border:     'none', cursor: 'pointer',
                      borderRight: tf === '1m' ? '1px solid rgba(255,255,255,0.12)' : 'none',
                      minWidth: 40, minHeight: 32,
                    }}
                  >
                    {tf.toUpperCase()}
                  </button>
                )
              })}
            </div>
            <button
              className="btn btn-ghost"
              onClick={() => setDirCheck({})}
              disabled={dirCheckLoading || Object.keys(dirCheck).length === 0}
              title="Discard current analysis result so the next decision uses a fresh fetch"
              style={{ fontSize: 11, padding: '6px 12px', letterSpacing: 1, minHeight: 32 }}
            >
              CLEAR
            </button>
            <button
              className="btn btn-ghost"
              onClick={runDirectionCheck}
              disabled={dirCheckLoading}
              style={{ fontSize: 11, padding: '6px 14px', letterSpacing: 1, minHeight: 32 }}
            >
              {dirCheckLoading ? 'ANALYSING…' : 'TEST / CHECK MARKET DIRECTION'}
            </button>
          </div>
        </div>
        <div className="scalp-signal-grid">
          {METALS_ONLY.map(pair => {
            void scalpTick   // force per-second re-render so age + status update live
            const r = dirCheck[pair]
            const name = pair === 'XAU/USD' ? 'Gold' : 'Silver'
            const hasResult = !!r && !r.error && !r.simulated
            const placeholder = !r && !dirCheckLoading
            const dirColor =
              r?.direction === 'BUY'  ? 'var(--color-buy)'  :
              r?.direction === 'SELL' ? 'var(--color-sell)' :
                                        'var(--text-muted)'
            const confColor =
              !r ? 'var(--text-muted)' :
              r.confidence >= 75 ? 'var(--color-buy)'  :
              r.confidence >= 50 ? '#ffaa00'           :
                                   'var(--color-sell)'
            const recoTag = r?.recommended === 'mirror' ? 'MIRROR' : 'SCALP'
            const recoColor = r?.recommended === 'mirror' ? '#42a5f5' : 'var(--color-accent)'
            // Age — used for the soft-fade colour on the analysed-time label.
            const ageMs    = r?.analyzedAt ? Date.now() - new Date(r.analyzedAt).getTime() : 0
            const ageSec   = Math.floor(ageMs / 1000)
            const ageColor = !r ? 'var(--text-muted)' :
                             ageSec < 60   ? 'var(--text-muted)' :
                             ageSec < 300  ? '#ffaa00'           :
                                             'var(--color-sell)'
            const ageLabel = ageSec < 60
              ? `${ageSec}s ago`
              : ageSec < 3600
                ? `${Math.floor(ageSec / 60)}m ${ageSec % 60}s ago`
                : `${Math.floor(ageSec / 3600)}h ago`
            // Expiry + status — driven by the analysed timeframe (1m = 60s
            // validity, 5m = 300s validity). Re-derived per tick so the badge
            // flips from ACTIVE -> EXPIRED at the exact second the candle window
            // closes. Server emits expiresAt; if missing (old payloads) we fall
            // back to analyzedAt + timeframe span on the client.
            const expiresAtMs = r?.expiresAt
              ? new Date(r.expiresAt).getTime()
              : r?.analyzedAt
                ? new Date(r.analyzedAt).getTime() + (r.timeframe === '1m' ? 60_000 : 300_000)
                : 0
            const isExpired = hasResult && Date.now() >= expiresAtMs
            const secsLeft  = hasResult ? Math.max(0, Math.ceil((expiresAtMs - Date.now()) / 1000)) : 0
            const statusLabel = !hasResult ? 'AWAITING'
                              : isExpired   ? 'EXPIRED'
                                            : 'ACTIVE'
            const statusColor = !hasResult ? 'var(--text-muted)'
                              : isExpired   ? 'var(--color-sell)'
                                            : 'var(--color-buy)'
            const statusBg    = !hasResult ? 'rgba(255,255,255,0.06)'
                              : isExpired   ? 'rgba(255,48,86,0.18)'
                                            : 'rgba(0,200,83,0.18)'
            const fmtTime = (iso?: string) => iso
              ? new Date(iso).toLocaleTimeString([], { hour12: false })
              : '--'

            return (
              <div key={pair} style={{
                padding: '14px 16px', borderRadius: 4,
                background: 'rgba(0,85,176,0.04)',
                border: '1px solid rgba(0,85,176,0.18)',
                display: 'flex', flexDirection: 'column', gap: 10,
                opacity: placeholder ? 0.7 : 1,
              }}>
                {/* Header */}
                <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
                  <div style={{ minWidth: 0, display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
                    <div style={{ minWidth: 0 }}>
                      <div style={{
                        fontSize: 10, color: 'var(--text-dim)', letterSpacing: 1.5,
                        fontWeight: 700, marginBottom: 2, display: 'flex',
                        alignItems: 'center', gap: 6, flexWrap: 'wrap',
                      }}>
                        <span>{name} · DIRECTION CONFIRMATION</span>
                        {r?.timeframe && (
                          <span style={{
                            fontSize: 9, fontWeight: 700, letterSpacing: 1,
                            padding: '1px 5px', borderRadius: 2,
                            background: 'rgba(0,85,176,0.25)',
                            color: 'var(--color-accent)',
                            fontFamily: 'JetBrains Mono',
                          }}>
                            {r.timeframe.toUpperCase()}
                          </span>
                        )}
                      </div>
                      <div style={{ fontSize: 18, fontWeight: 700, fontFamily: 'Rajdhani', letterSpacing: 1.5, color: 'var(--text)' }}>
                        {hasResult ? r!.marketType : '— awaiting fresh analysis —'}
                      </div>
                    </div>
                    {/* Status badge — ACTIVE / EXPIRED / AWAITING. Replaces the old
                        STALE badge with a precise expiry-driven readout. */}
                    <span
                      title={
                        statusLabel === 'ACTIVE'  ? `Valid for ${secsLeft}s — re-run before acting if you wait longer`
                        : statusLabel === 'EXPIRED' ? 'Signal validity period has ended. Run a new market confirmation.'
                                                    : 'Awaiting fresh analysis. Click TEST / CHECK MARKET DIRECTION.'
                      }
                      style={{
                        fontSize: 9, fontWeight: 700, letterSpacing: 1,
                        padding: '2px 6px', borderRadius: 2,
                        background: statusBg, color: statusColor,
                        textTransform: 'uppercase', alignSelf: 'center',
                      }}
                    >
                      {statusLabel}
                      {statusLabel === 'ACTIVE' && ` · ${secsLeft}s left`}
                    </span>
                  </div>
                  <div style={{ textAlign: 'right', fontSize: 10, flexShrink: 0 }}>
                    {r?.analyzedAt && (
                      <>
                        <div style={{ fontFamily: 'JetBrains Mono', color: ageColor, fontWeight: isExpired ? 700 : 400 }}>
                          {ageLabel}
                        </div>
                        <div style={{ color: 'var(--text-dim)', marginTop: 1, fontFamily: 'JetBrains Mono' }}>
                          {new Date(r.analyzedAt).toLocaleTimeString([], { hour12: false })}
                        </div>
                      </>
                    )}
                  </div>
                </div>

                {/* Error or simulated states */}
                {r?.error && (
                  <div style={{ fontSize: 11, color: 'var(--color-sell)', fontStyle: 'italic' }}>
                    {r.error}
                  </div>
                )}
                {r?.simulated && (
                  <div style={{ fontSize: 11, color: 'var(--color-sell)', fontStyle: 'italic' }}>
                    Live MT5 feed required
                  </div>
                )}

                {/* Top metrics row — recommended / direction / confidence. Always
                    rendered (even in placeholder state) so the field labels are
                    visible and consistent. -- shown when no result yet. */}
                {!r?.error && !r?.simulated && (
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                    <div style={{ flex: '1 1 80px', minWidth: 80, background: 'rgba(0,0,0,0.15)', borderRadius: 2, padding: '6px 8px' }}>
                      <div style={{ fontSize: 9, color: 'var(--text-dim)', letterSpacing: 1, marginBottom: 3 }}>RECOMMENDED</div>
                      <div style={{ fontSize: 13, color: hasResult ? recoColor : 'var(--text-muted)', fontWeight: 700, fontFamily: 'JetBrains Mono' }}>
                        {hasResult ? recoTag : '--'}
                      </div>
                    </div>
                    <div style={{ flex: '1 1 70px', minWidth: 70, background: 'rgba(0,0,0,0.15)', borderRadius: 2, padding: '6px 8px' }}>
                      <div style={{ fontSize: 9, color: 'var(--text-dim)', letterSpacing: 1, marginBottom: 3 }}>DIRECTION</div>
                      <div style={{ fontSize: 13, color: dirColor, fontWeight: 700, fontFamily: 'JetBrains Mono' }}>
                        {hasResult ? r!.direction : '--'}
                      </div>
                    </div>
                    <div style={{ flex: '1 1 70px', minWidth: 70, background: 'rgba(0,0,0,0.15)', borderRadius: 2, padding: '6px 8px' }}>
                      <div style={{ fontSize: 9, color: 'var(--text-dim)', letterSpacing: 1, marginBottom: 3 }}>CONFIDENCE</div>
                      <div style={{ fontSize: 13, color: confColor, fontWeight: 700, fontFamily: 'JetBrains Mono' }}>
                        {hasResult ? `${r!.confidence}%` : '--'}
                      </div>
                    </div>
                  </div>
                )}

                {/* Time + timeframe + status row — required by the spec. Same
                    -- placeholder treatment when no result. */}
                {!r?.error && !r?.simulated && (
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                    <div style={{ flex: '1 1 70px', minWidth: 70, background: 'rgba(0,0,0,0.15)', borderRadius: 2, padding: '6px 8px' }}>
                      <div style={{ fontSize: 9, color: 'var(--text-dim)', letterSpacing: 1, marginBottom: 3 }}>TIMEFRAME</div>
                      <div style={{ fontSize: 13, color: hasResult ? 'var(--color-accent)' : 'var(--text-muted)', fontWeight: 700, fontFamily: 'JetBrains Mono' }}>
                        {hasResult ? r!.timeframe!.toUpperCase() : 'Not Selected'}
                      </div>
                    </div>
                    <div style={{ flex: '1 1 80px', minWidth: 80, background: 'rgba(0,0,0,0.15)', borderRadius: 2, padding: '6px 8px' }}>
                      <div style={{ fontSize: 9, color: 'var(--text-dim)', letterSpacing: 1, marginBottom: 3 }}>ANALYSIS TIME</div>
                      <div style={{ fontSize: 13, color: hasResult ? 'var(--text)' : 'var(--text-muted)', fontWeight: 700, fontFamily: 'JetBrains Mono' }}>
                        {hasResult ? fmtTime(r!.analyzedAt) : '--'}
                      </div>
                    </div>
                    <div style={{ flex: '1 1 80px', minWidth: 80, background: 'rgba(0,0,0,0.15)', borderRadius: 2, padding: '6px 8px' }}>
                      <div style={{ fontSize: 9, color: 'var(--text-dim)', letterSpacing: 1, marginBottom: 3 }}>EST. EXPIRY</div>
                      <div style={{
                        fontSize: 13,
                        color: !hasResult ? 'var(--text-muted)' : isExpired ? 'var(--color-sell)' : 'var(--text)',
                        fontWeight: 700, fontFamily: 'JetBrains Mono',
                      }}>
                        {hasResult ? fmtTime(new Date(expiresAtMs).toISOString()) : '--'}
                      </div>
                    </div>
                  </div>
                )}

                {/* Background confirmation badge — surfaces the live-price
                    verification done server-side after the AI fan-out. Shows
                    confirmed (green) / contradicted (red) / neutral (muted)
                    / unavailable (amber) so the operator can see the result
                    of the independent check at a glance, without having to
                    parse the reasoning bullets. */}
                {hasResult && r!.confirmation && (() => {
                  const c = r!.confirmation
                  const cf = c.status
                  const cfBg = cf === 'confirmed'    ? 'rgba(0,200,83,0.18)'
                             : cf === 'contradicted' ? 'rgba(255,48,86,0.18)'
                             : cf === 'unavailable'  ? 'rgba(255,170,0,0.18)'
                                                     : 'rgba(255,255,255,0.06)'
                  const cfFg = cf === 'confirmed'    ? 'var(--color-buy)'
                             : cf === 'contradicted' ? 'var(--color-sell)'
                             : cf === 'unavailable'  ? '#ffaa00'
                                                     : 'var(--text-muted)'
                  const cfLabel = cf === 'confirmed'    ? '✓ LIVE CONFIRMED'
                                : cf === 'contradicted' ? '✗ LIVE CONTRADICTED'
                                : cf === 'unavailable'  ? '⚠ LIVE UNAVAILABLE'
                                                        : '— LIVE NEUTRAL'
                  const driftStr = c.driftPips !== null && c.driftPips !== undefined
                    ? `${c.driftPips >= 0 ? '+' : ''}${c.driftPips.toFixed(1)} pips`
                    : '—'
                  return (
                    <div style={{
                      display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap',
                      padding: '6px 8px', borderRadius: 2,
                      background: cfBg, border: `1px solid ${cfFg}33`,
                    }}>
                      <span style={{
                        fontSize: 9, fontWeight: 700, letterSpacing: 1,
                        color: cfFg, fontFamily: 'JetBrains Mono',
                      }}>
                        {cfLabel}
                      </span>
                      <span style={{ fontSize: 10, color: 'var(--text-dim)', fontFamily: 'JetBrains Mono' }}>
                        drift {driftStr}
                      </span>
                      {c.livePrice !== null && (
                        <span style={{ fontSize: 10, color: 'var(--text-dim)', fontFamily: 'JetBrains Mono' }}>
                          live {c.livePrice.toFixed(pair === 'XAU/USD' ? 2 : 3)} vs close {c.candleClose.toFixed(pair === 'XAU/USD' ? 2 : 3)}
                        </span>
                      )}
                      {c.adjustment !== 0 && (
                        <span style={{ fontSize: 10, color: cfFg, fontWeight: 700, fontFamily: 'JetBrains Mono' }}>
                          {c.adjustment > 0 ? `+${c.adjustment}` : c.adjustment} conf
                        </span>
                      )}
                    </div>
                  )
                })()}

                {/* AI reasoning bullets — shown when present; otherwise the
                    placeholder line below explains how to populate the card. */}
                {hasResult && r!.reasons.length > 0 && (
                  <div style={{ fontSize: 10, color: 'var(--text-dim)', lineHeight: 1.6 }}>
                    <div style={{
                      fontSize: 9, color: 'var(--text-dim)', letterSpacing: 1,
                      marginBottom: 3, fontWeight: 700,
                    }}>
                      AI ANALYSIS
                    </div>
                    {r!.reasons.map((reason, i) => (
                      <div key={i} style={{ display: 'flex', gap: 4, alignItems: 'flex-start' }}>
                        <span style={{ color: recoColor, flexShrink: 0, marginTop: 1 }}>›</span>
                        <span style={{ wordBreak: 'break-word' }}>{reason}</span>
                      </div>
                    ))}
                  </div>
                )}

                {/* Expired warning — exactly as specified by the operator brief */}
                {isExpired && (
                  <div style={{ fontSize: 10, color: 'var(--color-sell)', fontStyle: 'italic', lineHeight: 1.5 }}>
                    Signal validity period has ended. Run a new market confirmation.
                  </div>
                )}

                {/* Awaiting state — replaces the previous prose placeholder */}
                {placeholder && (
                  <div style={{ fontSize: 11, color: 'var(--text-dim)', fontStyle: 'italic' }}>
                    Click <b>TEST / CHECK MARKET DIRECTION</b> to run the 5-strategy fan-out for {name}.
                  </div>
                )}
              </div>
            )
          })}
        </div>
      </div>

      {/* Live scalp signals — always-on direction panel for Gold and Silver */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div style={{ fontSize: 10, color: 'var(--text-dim)', letterSpacing: 2, fontWeight: 700, paddingLeft: 2, display: 'flex', alignItems: 'center', gap: 8 }}>
          SCALP SIGNALS
          <ReconBadge stats={reconStats} type="scalp" />
        </div>

      <div className="scalp-signal-grid">
        {METALS_ONLY.map(pair => {
          const sig  = scalpSignals[pair]
          const name = pair === 'XAU/USD' ? 'Gold' : 'Silver'
          const dir  = sig?.direction ?? 'HOLD'
          const conf = sig?.confidence ?? 0
          // scalpTick forces re-render; expiry recomputed from real Date.now() each second
          void scalpTick
          const actualMsLeft = sig ? Math.max(0, sig.expiresAt - Date.now()) : 0
          const mLeft = Math.floor(actualMsLeft / 60000)
          const sLeft = Math.floor((actualMsLeft % 60000) / 1000)
          const dirColor    = dir === 'BUY' ? 'var(--color-buy)' : dir === 'SELL' ? 'var(--color-sell)' : 'var(--text-muted)'
          const borderColor = dir === 'BUY' ? 'rgba(0,200,83,0.3)' : dir === 'SELL' ? 'rgba(255,48,86,0.3)' : 'rgba(255,255,255,0.1)'
          const bgColor     = dir === 'BUY' ? 'rgba(0,200,83,0.05)' : dir === 'SELL' ? 'rgba(255,48,86,0.05)' : 'rgba(255,255,255,0.02)'
          const dp = pair.startsWith('XAU') ? 2 : 3

          // Execution pips: Option C clamp + broker min-stop widening
          // (lib/trade-levels.ts) — the exact stop distance /api/orders will
          // place. Displayed SL/TP, lots and risk all derive from these so
          // the card matches execution instead of the raw engine distances.
          const pipVal = getPipValue(pair)
          const derivedSlPips = sig && dir !== 'HOLD' && sig.entry !== sig.sl
            ? Math.abs(sig.entry - sig.sl) / pipVal
            : strategy.slPips
          const derivedTpPips = sig && dir !== 'HOLD' && sig.entry !== sig.tp
            ? Math.abs(sig.entry - sig.tp) / pipVal
            : strategy.tpPips
          const { slPips: execSlPips, tpPips: execTpPips } =
            execSlTpPips(pair, derivedSlPips, derivedTpPips, strategy.slPips, strategy.tpPips)
          const effectiveRiskPct = pfEnabled && pfRiskCap !== null && pfRiskCap < strategy.riskPct
            ? pfRiskCap
            : strategy.riskPct
          const scalpLots    = calcStandardPositionSize(accountBalance, effectiveRiskPct, Math.max(1, execSlPips), pair)
          const scalpRiskAmt = accountBalance * effectiveRiskPct / 100
          const pfCapped     = pfEnabled && pfRiskCap !== null && pfRiskCap < strategy.riskPct
          return (
            <div key={pair} style={{
              padding: '14px 16px', borderRadius: 4,
              background: bgColor, border: `1px solid ${borderColor}`,
              display: 'flex', flexDirection: 'column', gap: 8,
            }}>

              {/* Header row: name + direction + confidence + expiry */}
              <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8 }}>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 10, color: 'var(--text-dim)', letterSpacing: 1.5, fontWeight: 700, marginBottom: 2 }}>
                    {name} SCALP · 1–5m
                  </div>
                  <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
                    <span className="signal-dir-text" style={{ color: dirColor }}>
                      {dir}
                    </span>
                    {dir !== 'HOLD' && conf > 0 && (
                      <span style={{ fontSize: 15, fontWeight: 700, fontFamily: 'JetBrains Mono', color: dirColor }}>
                        {conf}%
                      </span>
                    )}
                    {sig?.marketRegime && REGIME_BADGE[sig.marketRegime] && (
                      <span
                        title={`ADX ${sig.adx?.toFixed?.(1) ?? '?'} — gate ≥${sig.effectiveMinStrength}%`}
                        style={{
                          fontSize: 9, fontWeight: 700, letterSpacing: 1,
                          padding: '2px 6px', borderRadius: 2,
                          textTransform: 'uppercase',
                          background: REGIME_BADGE[sig.marketRegime].bg,
                          color:      REGIME_BADGE[sig.marketRegime].fg,
                        }}
                      >
                        {REGIME_BADGE[sig.marketRegime].label}
                      </span>
                    )}
                  </div>
                </div>
                <div style={{ textAlign: 'right', flexShrink: 0, fontSize: 10 }}>
                  {sig && !sig.blocked && dir !== 'HOLD' ? (
                    <>
                      <div style={{ color: actualMsLeft < 60000 ? 'var(--color-sell)' : 'var(--text-muted)', fontFamily: 'JetBrains Mono', fontWeight: 700 }}>
                        {mLeft}m {String(sLeft).padStart(2, '0')}s
                      </div>
                      <div style={{ color: 'var(--text-dim)', marginTop: 1 }}>valid until</div>
                    </>
                  ) : sig?.fetchError ? (
                    <div style={{ color: 'var(--color-sell)', fontStyle: 'italic', maxWidth: 120, wordBreak: 'break-all' }}>
                      error: {sig.fetchError}
                    </div>
                  ) : !sig ? (
                    <div style={{ color: 'var(--text-dim)', fontStyle: 'italic' }}>loading…</div>
                  ) : null}
                </div>
              </div>

              {/* Price levels: entry / SL / TP — re-anchored to live bid/ask
                  every render, at the EXECUTION stop distances (clamp +
                  min-stop widening), so the displayed values match what the
                  broker will actually place. Falls back to the signal entry
                  if the live OANDA feed is missing or zero. */}
              {sig && !sig.blocked && dir !== 'HOLD' && (() => {
                const live = liveAnchoredLevels(sig, prices, dir as 'BUY' | 'SELL',
                  { slDist: execSlPips * pipVal, tpDist: execTpPips * pipVal })
                return (
                  <div style={{ display: 'flex', gap: 6 }}>
                    {([
                      { label: live.isLive ? 'ENTRY · LIVE' : 'ENTRY', val: live.entry, color: 'var(--color-accent)' },
                      { label: 'SL',                                    val: live.sl,    color: 'var(--color-loss)' },
                      { label: 'TP',                                    val: live.tp,    color: 'var(--color-profit)' },
                    ] as const).map(({ label, val, color }) => (
                      <div key={label} style={{
                        flex: 1, minWidth: 0,
                        background: 'rgba(0,0,0,0.15)', borderRadius: 2, padding: '6px 8px',
                      }}>
                        <div style={{ fontSize: 9, color: 'var(--text-dim)', letterSpacing: 1, marginBottom: 3 }}>{label}</div>
                        <div style={{ fontSize: 11, color, fontWeight: 700, fontFamily: 'JetBrains Mono' }}>
                          <CopyValue value={val.toFixed(dp)}>{val.toFixed(dp)}</CopyValue>
                        </div>
                      </div>
                    ))}
                  </div>
                )
              })()}

              {/* Lot size / risk row */}
              {sig && !sig.blocked && dir !== 'HOLD' && (() => {
                const useManual    = typeof strategy.manualLots === 'number' && strategy.manualLots > 0
                const displayLots  = useManual ? (strategy.manualLots as number) : scalpLots
                const displayRisk  = useManual ? displayLots * 10 * Math.max(1, execSlPips) : scalpRiskAmt
                return (
                <div style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                  background: 'rgba(0,85,176,0.07)', border: '1px solid rgba(0,85,176,0.18)',
                  borderRadius: 2, padding: '6px 8px',
                }}>
                  <div>
                    <div style={{ fontSize: 9, color: 'var(--color-accent)', letterSpacing: 1, marginBottom: 1 }}>
                      POSITION
                      <span style={{
                        marginLeft: 6, fontSize: 8, fontWeight: 700, letterSpacing: 1,
                        padding: '1px 5px', borderRadius: 2,
                        background: useManual ? 'rgba(255,184,0,0.18)' : 'rgba(0,200,83,0.18)',
                        color:      useManual ? '#ffb800' : 'var(--color-buy)',
                      }}>
                        {useManual ? 'MANUAL' : 'AUTO'}
                      </span>
                    </div>
                    <span style={{ fontSize: 16, fontWeight: 900, color: 'var(--color-accent)', fontFamily: 'JetBrains Mono', lineHeight: 1 }}>
                      {displayLots.toFixed(2)}
                    </span>
                    <span style={{ fontSize: 10, color: 'var(--text-muted)', marginLeft: 4 }}>lots</span>
                  </div>
                  <div style={{ textAlign: 'right', fontSize: 10, color: 'var(--text-muted)', lineHeight: 1.5 }}>
                    <div style={{ color: 'var(--color-loss)' }}>${displayRisk.toFixed(2)} at risk</div>
                    <div>
                      {useManual
                        ? `${execSlPips.toFixed(1)}p SL × $10/pip-lot`
                        : `${effectiveRiskPct}% of $${accountBalance.toLocaleString()}`}
                    </div>
                    {pfCapped && !useManual && (
                      <div style={{ color: 'var(--color-wait)', fontWeight: 700 }}>PF capped ↓{pfRiskCap}%</div>
                    )}
                  </div>
                </div>
                )
              })()}

              {/* Reasons */}
              {sig?.reasons && sig.reasons.length > 0 && dir !== 'HOLD' && (
                <div style={{ fontSize: 10, color: 'var(--text-dim)', lineHeight: 1.6 }}>
                  {sig.reasons.slice(0, 2).map((r, i) => (
                    <div key={i} style={{ display: 'flex', gap: 4, alignItems: 'flex-start' }}>
                      <span style={{ color: dirColor, flexShrink: 0, marginTop: 1 }}>›</span>
                      <span style={{ wordBreak: 'break-word' }}>{r}</span>
                    </div>
                  ))}
                </div>
              )}

              {/* Place order button */}
              {sig && !sig.blocked && dir !== 'HOLD' && actualMsLeft > 0 && (
                <button
                  className={`btn ${dir === 'BUY' ? 'btn-buy' : 'btn-sell'}`}
                  onClick={() => handleScalpOrder(sig)}
                  disabled={placingScalp === pair}
                  style={{ padding: '10px', fontSize: 13, letterSpacing: 1.5, width: '100%' }}
                >
                  {placingScalp === pair
                    ? <LoadingDots color={dirColor} />
                    : `▶ PLACE ${dir}`}
                </button>
              )}

              {sig?.blocked && (
                <div style={{ fontSize: 11, color: 'var(--color-sell)', fontStyle: 'italic' }}>
                  Live MT5 feed required
                </div>
              )}
            </div>
          )
        })}
      </div>
      </div>

      {/* Mirror Trades — opposite-direction cards for Gold and Silver */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div style={{ fontSize: 10, color: 'var(--text-dim)', letterSpacing: 2, fontWeight: 700, paddingLeft: 2, display: 'flex', alignItems: 'center', gap: 8 }}>
          MIRROR TRADES
          <ReconBadge stats={reconStats} type="mirror" />
        </div>

        <div className="scalp-signal-grid">
          {METALS_ONLY.map(pair => {
            const sig      = scalpSignals[pair]
            const name     = pair === 'XAU/USD' ? 'Gold' : 'Silver'
            const origDir  = sig?.direction ?? 'HOLD'
            const dir: 'BUY' | 'SELL' | 'HOLD' =
              origDir === 'BUY' ? 'SELL' : origDir === 'SELL' ? 'BUY' : 'HOLD'
            const conf = sig?.confidence ?? 0
            void scalpTick
            const actualMsLeft = sig ? Math.max(0, sig.expiresAt - Date.now()) : 0
            const mLeft = Math.floor(actualMsLeft / 60000)
            const sLeft = Math.floor((actualMsLeft % 60000) / 1000)
            const dirColor    = dir === 'BUY' ? 'var(--color-buy)' : dir === 'SELL' ? 'var(--color-sell)' : 'var(--text-muted)'
            const borderColor = dir === 'BUY' ? 'rgba(0,200,83,0.2)' : dir === 'SELL' ? 'rgba(255,48,86,0.2)' : 'rgba(255,255,255,0.08)'
            const bgColor     = dir === 'BUY' ? 'rgba(0,200,83,0.03)' : dir === 'SELL' ? 'rgba(255,48,86,0.03)' : 'rgba(255,255,255,0.01)'
            const dp = pair.startsWith('XAU') ? 2 : 3

            // Execution pips — same clamp + min-stop widening as the scalp
            // card and /api/orders (lib/trade-levels.ts).
            const pipVal = getPipValue(pair)
            const derivedSlPips = sig && dir !== 'HOLD' && sig.entry !== sig.sl
              ? Math.abs(sig.entry - sig.sl) / pipVal
              : strategy.slPips
            const derivedTpPips = sig && dir !== 'HOLD' && sig.entry !== sig.tp
              ? Math.abs(sig.entry - sig.tp) / pipVal
              : strategy.tpPips
            const { slPips: execSlPips, tpPips: execTpPips } =
              execSlTpPips(pair, derivedSlPips, derivedTpPips, strategy.slPips, strategy.tpPips)
            const effectiveRiskPct = pfEnabled && pfRiskCap !== null && pfRiskCap < strategy.riskPct
              ? pfRiskCap
              : strategy.riskPct
            const scalpLots    = calcStandardPositionSize(accountBalance, effectiveRiskPct, Math.max(1, execSlPips), pair)
            const scalpRiskAmt = accountBalance * effectiveRiskPct / 100
            const pfCapped     = pfEnabled && pfRiskCap !== null && pfRiskCap < strategy.riskPct

            return (
              <div key={pair} style={{
                padding: '14px 16px', borderRadius: 4,
                background: bgColor, border: `1px solid ${borderColor}`,
                display: 'flex', flexDirection: 'column', gap: 8,
                opacity: dir === 'HOLD' ? 0.5 : 1,
              }}>

                {/* Header */}
                <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8 }}>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: 10, color: 'var(--text-dim)', letterSpacing: 1.5, fontWeight: 700, marginBottom: 2 }}>
                      {name} MIRROR · 1–5m
                    </div>
                    <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
                      <span style={{ fontSize: 28, fontWeight: 900, fontFamily: 'Rajdhani', letterSpacing: 2, color: dirColor, lineHeight: 1 }}>
                        {dir}
                      </span>
                      {dir !== 'HOLD' && conf > 0 && (
                        <span style={{ fontSize: 15, fontWeight: 700, fontFamily: 'JetBrains Mono', color: dirColor }}>
                          {conf}%
                        </span>
                      )}
                      {sig?.marketRegime && REGIME_BADGE[sig.marketRegime] && (
                        <span
                          title={`ADX ${sig.adx?.toFixed?.(1) ?? '?'} — gate ≥${sig.effectiveMinStrength}%`}
                          style={{
                            fontSize: 9, fontWeight: 700, letterSpacing: 1,
                            padding: '2px 6px', borderRadius: 2,
                            textTransform: 'uppercase',
                            background: REGIME_BADGE[sig.marketRegime].bg,
                            color:      REGIME_BADGE[sig.marketRegime].fg,
                          }}
                        >
                          {REGIME_BADGE[sig.marketRegime].label}
                        </span>
                      )}
                    </div>
                  </div>
                  <div style={{ textAlign: 'right', flexShrink: 0, fontSize: 10 }}>
                    {sig && !sig.blocked && dir !== 'HOLD' ? (
                      <>
                        <div style={{ color: actualMsLeft < 60000 ? 'var(--color-sell)' : 'var(--text-muted)', fontFamily: 'JetBrains Mono', fontWeight: 700 }}>
                          {mLeft}m {String(sLeft).padStart(2, '0')}s
                        </div>
                        <div style={{ color: 'var(--text-dim)', marginTop: 1 }}>valid until</div>
                      </>
                    ) : sig?.fetchError ? (
                      <div style={{ color: 'var(--color-sell)', fontStyle: 'italic', maxWidth: 120, wordBreak: 'break-all' }}>
                        error: {sig.fetchError}
                      </div>
                    ) : !sig ? (
                      <div style={{ color: 'var(--text-dim)', fontStyle: 'italic' }}>loading…</div>
                    ) : null}
                  </div>
                </div>

                {/* Price levels with mirrored SL/TP — re-anchored to live
                    bid/ask in the mirror direction every render, at the
                    EXECUTION stop distances (clamp + min-stop widening). */}
                {sig && !sig.blocked && dir !== 'HOLD' && (() => {
                  const live = liveAnchoredLevels(sig, prices, dir as 'BUY' | 'SELL',
                    { slDist: execSlPips * pipVal, tpDist: execTpPips * pipVal })
                  return (
                    <div style={{ display: 'flex', gap: 6 }}>
                      {([
                        { label: live.isLive ? 'ENTRY · LIVE' : 'ENTRY', val: live.entry, color: 'var(--color-accent)' },
                        { label: 'SL',                                    val: live.sl,    color: 'var(--color-loss)' },
                        { label: 'TP',                                    val: live.tp,    color: 'var(--color-profit)' },
                      ] as const).map(({ label, val, color }) => (
                        <div key={label} style={{
                          flex: 1, minWidth: 0,
                          background: 'rgba(0,0,0,0.15)', borderRadius: 2, padding: '6px 8px',
                        }}>
                          <div style={{ fontSize: 9, color: 'var(--text-dim)', letterSpacing: 1, marginBottom: 3 }}>{label}</div>
                          <div style={{ fontSize: 11, color, fontWeight: 700, fontFamily: 'JetBrains Mono' }}>
                            <CopyValue value={val.toFixed(dp)}>{val.toFixed(dp)}</CopyValue>
                          </div>
                        </div>
                      ))}
                    </div>
                  )
                })()}

                {/* Lot size / risk row */}
                {sig && !sig.blocked && dir !== 'HOLD' && (() => {
                  const useManual    = typeof strategy.manualLots === 'number' && strategy.manualLots > 0
                  const displayLots  = useManual ? (strategy.manualLots as number) : scalpLots
                  const displayRisk  = useManual ? displayLots * 10 * Math.max(1, execSlPips) : scalpRiskAmt
                  return (
                  <div style={{
                    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                    background: 'rgba(0,85,176,0.07)', border: '1px solid rgba(0,85,176,0.18)',
                    borderRadius: 2, padding: '6px 8px',
                  }}>
                    <div>
                      <div style={{ fontSize: 9, color: 'var(--color-accent)', letterSpacing: 1, marginBottom: 1 }}>
                        POSITION
                        <span style={{
                          marginLeft: 6, fontSize: 8, fontWeight: 700, letterSpacing: 1,
                          padding: '1px 5px', borderRadius: 2,
                          background: useManual ? 'rgba(255,184,0,0.18)' : 'rgba(0,200,83,0.18)',
                          color:      useManual ? '#ffb800' : 'var(--color-buy)',
                        }}>
                          {useManual ? 'MANUAL' : 'AUTO'}
                        </span>
                      </div>
                      <span style={{ fontSize: 16, fontWeight: 900, color: 'var(--color-accent)', fontFamily: 'JetBrains Mono', lineHeight: 1 }}>
                        {displayLots.toFixed(2)}
                      </span>
                      <span style={{ fontSize: 10, color: 'var(--text-muted)', marginLeft: 4 }}>lots</span>
                    </div>
                    <div style={{ textAlign: 'right', fontSize: 10, color: 'var(--text-muted)', lineHeight: 1.5 }}>
                      <div style={{ color: 'var(--color-loss)' }}>${displayRisk.toFixed(2)} at risk</div>
                      <div>
                        {useManual
                          ? `${execSlPips.toFixed(1)}p SL × $10/pip-lot`
                          : `${effectiveRiskPct}% of $${accountBalance.toLocaleString()}`}
                      </div>
                      {pfCapped && !useManual && (
                        <div style={{ color: 'var(--color-wait)', fontWeight: 700 }}>PF capped ↓{pfRiskCap}%</div>
                      )}
                    </div>
                  </div>
                  )
                })()}

                {/* Reasons (inherited from original) */}
                {sig?.reasons && sig.reasons.length > 0 && dir !== 'HOLD' && (
                  <div style={{ fontSize: 10, color: 'var(--text-dim)', lineHeight: 1.6 }}>
                    {sig.reasons.slice(0, 2).map((r, i) => (
                      <div key={i} style={{ display: 'flex', gap: 4, alignItems: 'flex-start' }}>
                        <span style={{ color: dirColor, flexShrink: 0, marginTop: 1 }}>›</span>
                        <span style={{ wordBreak: 'break-word' }}>{r}</span>
                      </div>
                    ))}
                  </div>
                )}

                {/* Place Mirror button */}
                {sig && !sig.blocked && dir !== 'HOLD' && actualMsLeft > 0 && (
                  <button
                    className={`btn ${dir === 'BUY' ? 'btn-buy' : 'btn-sell'}`}
                    onClick={() => handleMirrorScalpOrder(sig)}
                    disabled={placingMirrorScalp === pair}
                    style={{ padding: '10px', fontSize: 13, letterSpacing: 1.5, width: '100%' }}
                  >
                    {placingMirrorScalp === pair
                      ? <LoadingDots color={dirColor} />
                      : `▶ PLACE MIRROR ${dir}`}
                  </button>
                )}

                {sig?.blocked && (
                  <div style={{ fontSize: 11, color: 'var(--color-sell)', fontStyle: 'italic' }}>
                    Live MT5 feed required
                  </div>
                )}
              </div>
            )
          })}
        </div>
      </div>

      {/* AUTO TRADER panel — commented out, scalp signal cards shown instead
      <Panel title="AUTO TRADER" bright>
        ...scanner controls, timeframe selector, watchlist pills...
      </Panel>
      */}

      {/* OPEN POSITIONS panel — commented out
      <Panel title="OPEN POSITIONS">
        ...open trades list with close buttons...
      </Panel>
      */}

    </div>
  )
}

// ─── Signal Card ───────────────────────────────────────────────────────────────

function SignalCard({
  signal, strategy, accountBalance, livePrice, approving, onApprove, onReject,
}: {
  signal: ScanSignal
  strategy: StrategySettings
  accountBalance: number
  livePrice?: number
  approving: boolean
  onApprove: () => void
  onReject: () => void
}) {
  // Prefer live broker price; fall back to scan-time price
  const price = livePrice || signal.currentPrice
  const color = DIR_COLOR[signal.direction] || 'var(--color-wait)'
  const pip = getPipValue(signal.pair)
  const pipPerLot = getPipValuePerLot(signal.pair)
  const lots = calcStandardPositionSize(accountBalance, strategy.riskPct, strategy.slPips, signal.pair)
  const riskAmt = (accountBalance * strategy.riskPct / 100).toFixed(2)
  const tpProfit = (pipPerLot * lots * strategy.tpPips).toFixed(2)
  const slLoss = (pipPerLot * lots * strategy.slPips).toFixed(2)
  const dp = signal.pair.includes('JPY') ? 3 : signal.pair.startsWith('XA') ? 2 : 5
  const sign = signal.direction === 'BUY' ? 1 : -1
  const tpPrice = (price + strategy.tpPips * pip * sign).toFixed(dp)
  const slPrice = (price - strategy.slPips * pip * sign).toFixed(dp)

  // Expiry countdown
  const msLeft = new Date(signal.expiresAt).getTime() - Date.now()
  const minsLeft = Math.max(0, Math.floor(msLeft / 60000))
  const secsLeft = Math.max(0, Math.floor((msLeft % 60000) / 1000))

  return (
    <div className="dir-card" data-dir={signal.direction} style={{ padding: 16 }}>
      {/* Top row */}
      <div className="signal-top-row" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 14, gap: 10 }}>
        <div className="signal-meta-group" style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
          <div>
            <div style={{ fontSize: 22, fontWeight: 900, color, fontFamily: 'Rajdhani', letterSpacing: 2, lineHeight: 1 }}>
              {signal.direction}
            </div>
            <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--text-primary)', fontFamily: 'Rajdhani', marginTop: 1 }}>
              {signal.pair}
            </div>
          </div>
          <div style={{ textAlign: 'center' }}>
            <div style={{ fontSize: 22, fontWeight: 700, color, fontFamily: 'JetBrains Mono', lineHeight: 1 }}>
              {signal.confidence}%
            </div>
            <div style={{ fontSize: 9, color: 'var(--text-muted)', letterSpacing: 1 }}>CONFIDENCE</div>
          </div>
          <div style={{ textAlign: 'center' }}>
            <div style={{ fontSize: 20, fontWeight: 700, color: signal.checklistScore >= 7 ? 'var(--color-buy)' : 'var(--color-wait)', fontFamily: 'JetBrains Mono', lineHeight: 1 }}>
              {signal.checklistScore}/8
            </div>
            <div style={{ fontSize: 9, color: 'var(--text-muted)', letterSpacing: 1 }}>CHECKLIST</div>
          </div>
          {signal.mlScore && (
            <div style={{ textAlign: 'center' }}>
              <div style={{ fontSize: 20, fontWeight: 700, fontFamily: 'JetBrains Mono', lineHeight: 1,
                color: signal.mlScore.win_probability >= 0.65 ? 'var(--color-buy)' : signal.mlScore.win_probability >= 0.50 ? 'var(--color-wait)' : 'var(--color-sell)' }}>
                {Math.round(signal.mlScore.win_probability * 100)}%
              </div>
              <div style={{ fontSize: 9, color: 'var(--text-muted)', letterSpacing: 1 }}>ML WIN</div>
            </div>
          )}
        </div>
        <div className="signal-expiry" style={{ textAlign: 'right', fontSize: 11, color: 'var(--text-dim)', flexShrink: 0 }}>
          <div style={{ color: minsLeft < 5 ? 'var(--color-sell)' : 'var(--text-muted)' }}>
            Expires in {minsLeft}m {secsLeft}s
          </div>
          <div style={{ marginTop: 2 }}>{signal.timeframe} · {new Date(signal.scannedAt).toLocaleTimeString('en', { hour12: false })}</div>
        </div>
      </div>

      {/* Entry zone */}
      <div className="entry-zone-bar" style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '8px 12px', borderRadius: 3, background: 'rgba(96,192,255,0.06)', border: '1px solid rgba(96,192,255,0.22)', marginBottom: 10 }}>
        <div style={{ fontSize: 9, color: 'var(--color-accent)', letterSpacing: 1.5, fontWeight: 700, flexShrink: 0 }}>ENTRY ZONE</div>
        <div className="mono" style={{ fontSize: 14, fontWeight: 700, color: 'var(--color-accent)' }}>
          <CopyValue value={signal.entryZone.low.toFixed(dp)}>{signal.entryZone.low.toFixed(dp)}</CopyValue>
          {' – '}
          <CopyValue value={signal.entryZone.high.toFixed(dp)}>{signal.entryZone.high.toFixed(dp)}</CopyValue>
        </div>
        <div className="entry-zone-hint" style={{ marginLeft: 'auto', fontSize: 10, color: 'var(--text-muted)', fontStyle: 'italic' }}>
          Wait for price to enter this zone
        </div>
      </div>

      {/* Price levels */}
      <div className="signal-price-grid" style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
        <div style={{ flex: 1, minWidth: 0, background: 'rgba(0,0,0,0.1)', borderRadius: 3, padding: '6px 10px' }}>
          <div style={{ fontSize: 9, color: 'var(--text-muted)', letterSpacing: 1, marginBottom: 2 }}>LIVE PRICE</div>
          <div className="mono" style={{ fontSize: 11, color: 'var(--color-accent-dim)', fontWeight: 700 }}>{price.toFixed(dp)}</div>
        </div>
        <div style={{ flex: 1, minWidth: 0, background: 'rgba(0,0,0,0.1)', borderRadius: 3, padding: '6px 10px' }}>
          <div style={{ fontSize: 9, color: 'var(--text-muted)', letterSpacing: 1, marginBottom: 2 }}>TAKE PROFIT</div>
          <div className="mono" style={{ fontSize: 11, color: 'var(--color-profit)', fontWeight: 700 }}>
            <CopyValue value={tpPrice}>{tpPrice}</CopyValue>
          </div>
        </div>
        <div style={{ flex: 1, minWidth: 0, background: 'rgba(0,0,0,0.1)', borderRadius: 3, padding: '6px 10px' }}>
          <div style={{ fontSize: 9, color: 'var(--text-muted)', letterSpacing: 1, marginBottom: 2 }}>STOP LOSS</div>
          <div className="mono" style={{ fontSize: 11, color: 'var(--color-loss)', fontWeight: 700 }}>
            <CopyValue value={slPrice}>{slPrice}</CopyValue>
          </div>
        </div>
      </div>

      {/* Reasons */}
      <div style={{ marginBottom: 12 }}>
        {signal.reasons.map((r, i) => (
          <div key={i} style={{ display: 'flex', gap: 8, marginBottom: 5, fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.5 }}>
            <span style={{ color, flexShrink: 0 }}>→</span>
            <span>{r}</span>
          </div>
        ))}
      </div>

      {/* Risk note */}
      <div style={{
        fontSize: 11, color: 'var(--color-warn-text)', lineHeight: 1.5,
        padding: '7px 10px', borderRadius: 3,
        background: 'rgba(138,98,0,0.07)', border: '1px solid rgba(138,98,0,0.22)',
        marginBottom: 14,
      }}>
        <span style={{ fontWeight: 700 }}>⚠ </span>{signal.riskNote}
      </div>

      {/* Position size */}
      <div style={{
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        background: 'rgba(0,85,176,0.07)', border: '1px solid rgba(0,85,176,0.2)',
        borderRadius: 3, padding: '8px 12px', marginBottom: 14,
      }}>
        <div>
          <div style={{ fontSize: 9, color: 'var(--color-accent)', letterSpacing: 1, marginBottom: 2 }}>POSITION SIZE</div>
          <div style={{ fontSize: 22, fontWeight: 900, color: 'var(--color-accent)', fontFamily: 'JetBrains Mono', lineHeight: 1 }}>
            {lots.toFixed(2)} <span style={{ fontSize: 12, fontWeight: 400, color: 'var(--text-muted)' }}>lots</span>
          </div>
          <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 2 }}>
            ${riskAmt} risk ({strategy.riskPct}% of ${accountBalance.toLocaleString()})
          </div>
        </div>
        <div style={{ textAlign: 'right', fontSize: 11, color: 'var(--text-muted)' }}>
          <div>${(pipPerLot * lots).toFixed(2)} / pip</div>
          <div style={{ color: 'var(--color-profit)', marginTop: 3 }}>TP +${tpProfit}</div>
          <div style={{ color: 'var(--color-loss)', marginTop: 2 }}>SL −${slLoss}</div>
        </div>
      </div>

      {/* Action buttons */}
      <div style={{ display: 'flex', gap: 10 }}>
        <button
          className={`btn ${signal.direction === 'BUY' ? 'btn-buy' : 'btn-sell'}`}
          onClick={onApprove}
          disabled={approving}
          style={{ flex: 2, padding: '12px', fontSize: 14, letterSpacing: 2 }}
        >
          {approving ? <LoadingDots color={color} /> : `✓ APPROVE & PLACE ${signal.direction}`}
        </button>
        <button
          className="btn btn-ghost"
          onClick={onReject}
          disabled={approving}
          style={{ flex: 1, padding: '12px', fontSize: 13 }}
        >
          ✕ Reject
        </button>
      </div>
    </div>
  )
}
