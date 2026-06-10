'use client'
// components/pages/AutoTradePage.tsx
// Full-auto + semi-auto trading with prop firm enforcement

import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { Panel, LoadingDots, CopyValue } from '../ui'
import { calcStandardPositionSize, getPipValue, getPipValuePerLot } from '@/lib/brokers/interface'
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

// SL/TP clamp bounds for scalp + mirror auto paths (Option C — see ATR audit).
// strategy.slPips/tpPips act as the FLOOR (minimum SL/TP). The engine's
// ATR-derived value is allowed to widen up to MIRROR_*_CAP. This stops the
// previous behaviour where strategy.slPips=18 was acting as a ceiling on top
// of an engine that already produces 30-80 pip SLs — placing a tight stop
// inside one bar of XAU/USD noise on every trade.
//
// 35-pip cap chosen because 5-day XAU ATR has a 5th percentile of ~24 pips,
// so even calm-market signals will produce SLs below the cap. Above the cap
// the position size becomes too small to be useful.
const MIRROR_SL_CAP = 25
const MIRROR_TP_CAP = 70  // = 2 × SL cap to preserve the 1:2 R:R target

type MarketRegime = 'ranging' | 'weak-trend' | 'trending' | 'strong-trend'

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
      // Option C clamp: strategy.slPips/tpPips are the FLOOR, MIRROR_*_CAP is the
      // outer ceiling, and the engine's ATR-derived value sits in between. The raw
      // derived value is still passed as source_sl_pips for clamp-impact auditing.
      const derivedSlPips = sig.sl !== sig.entry ? Math.abs(sig.entry - sig.sl) / pip : strategy.slPips
      const derivedTpPips = sig.tp !== sig.entry ? Math.abs(sig.entry - sig.tp) / pip : strategy.tpPips
      const scalpSlPips   = Math.min(MIRROR_SL_CAP, Math.max(strategy.slPips, derivedSlPips))
      const scalpTpPips   = Math.min(MIRROR_TP_CAP, Math.max(strategy.tpPips, derivedTpPips))
      const data = await authFetch('/api/orders', {
        method: 'POST',
        body: JSON.stringify({
          pair:            sig.pair,
          direction:       sig.direction,
          strategy:        { ...strategy, slPips: scalpSlPips, tpPips: scalpTpPips },
          currentPrice:    sig.entry,
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
      const mirrorDir = sig.direction === 'BUY' ? 'SELL' : 'BUY'
      const mirrorSl  = 2 * sig.entry - sig.sl
      const mirrorTp  = 2 * sig.entry - sig.tp
      const pip = getPipValue(sig.pair)
      // Option C clamp: strategy.slPips/tpPips floor, MIRROR_*_CAP outer ceiling.
      const derivedSlPips = sig.sl !== sig.entry ? Math.abs(sig.entry - sig.sl) / pip : strategy.slPips
      const derivedTpPips = sig.tp !== sig.entry ? Math.abs(sig.entry - sig.tp) / pip : strategy.tpPips
      const slPips        = Math.min(MIRROR_SL_CAP, Math.max(strategy.slPips, derivedSlPips))
      const tpPips        = Math.min(MIRROR_TP_CAP, Math.max(strategy.tpPips, derivedTpPips))
      const data = await authFetch('/api/orders', {
        method: 'POST',
        body: JSON.stringify({
          pair:           sig.pair,
          direction:      mirrorDir,
          strategy:       { ...strategy, slPips, tpPips },
          currentPrice:   sig.entry,
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
    // Option C clamp: strategy.slPips/tpPips floor, MIRROR_*_CAP outer ceiling.
    const derivedSlPips = sig.sl !== sig.entry ? Math.abs(sig.entry - sig.sl) / pip : strategy.slPips
    const derivedTpPips = sig.tp !== sig.entry ? Math.abs(sig.entry - sig.tp) / pip : strategy.tpPips
    const slPips        = Math.min(MIRROR_SL_CAP, Math.max(strategy.slPips, derivedSlPips))
    const tpPips        = Math.min(MIRROR_TP_CAP, Math.max(strategy.tpPips, derivedTpPips))
    const direction = isMirror ? (sig.direction === 'BUY' ? 'SELL' : 'BUY') : sig.direction
    const prefix    = isMirror ? 'mirror' : 'scalp'
    const signalRef = `${prefix}-${sig.pair.replace('/', '')}-${sig.fetchedAt}`
    const body: Record<string, any> = {
      pair: sig.pair, direction,
      strategy:             { ...strategy, slPips, tpPips },
      currentPrice:         sig.entry,
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
      body.mirrorSl = 2 * sig.entry - sig.sl
      body.mirrorTp = 2 * sig.entry - sig.tp
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

      {/* Live scalp signals — always-on direction panel for Gold and Silver */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div style={{ fontSize: 10, color: 'var(--text-dim)', letterSpacing: 2, fontWeight: 700, paddingLeft: 2 }}>
          SCALP SIGNALS
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

          // Lot size: derive SL pips from the signal's actual SL distance, apply prop firm risk cap
          const signalSlPips = sig && dir !== 'HOLD' && sig.entry !== sig.sl
            ? Math.abs(sig.entry - sig.sl) / getPipValue(pair)
            : strategy.slPips
          const effectiveRiskPct = pfEnabled && pfRiskCap !== null && pfRiskCap < strategy.riskPct
            ? pfRiskCap
            : strategy.riskPct
          const scalpLots    = calcStandardPositionSize(accountBalance, effectiveRiskPct, Math.max(1, signalSlPips), pair)
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
                    {sig?.marketRegime && (
                      <span
                        title={`ADX ${sig.adx?.toFixed?.(1) ?? '?'} — gate ≥${sig.effectiveMinStrength}%`}
                        style={{
                          fontSize: 9, fontWeight: 700, letterSpacing: 1,
                          padding: '2px 6px', borderRadius: 2,
                          textTransform: 'uppercase',
                          background:
                            sig.marketRegime === 'strong-trend' ? 'rgba(0,200,83,0.18)' :
                            sig.marketRegime === 'trending'     ? 'rgba(0,150,255,0.18)' :
                            sig.marketRegime === 'weak-trend'   ? 'rgba(255,170,0,0.18)' :
                                                                  'rgba(255,255,255,0.08)',
                          color:
                            sig.marketRegime === 'strong-trend' ? 'var(--color-buy)' :
                            sig.marketRegime === 'trending'     ? '#42a5f5' :
                            sig.marketRegime === 'weak-trend'   ? '#ffaa00' :
                                                                  'var(--text-muted)',
                        }}
                      >
                        {sig.marketRegime}
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

              {/* Price levels: entry / SL / TP — each with copy button */}
              {sig && !sig.blocked && dir !== 'HOLD' && (
                <div style={{ display: 'flex', gap: 6 }}>
                  {([
                    { label: 'ENTRY', val: sig.entry, color: 'var(--color-accent)' },
                    { label: 'SL',    val: sig.sl,    color: 'var(--color-loss)' },
                    { label: 'TP',    val: sig.tp,    color: 'var(--color-profit)' },
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
              )}

              {/* Lot size / risk row */}
              {sig && !sig.blocked && dir !== 'HOLD' && (() => {
                const useManual    = typeof strategy.manualLots === 'number' && strategy.manualLots > 0
                const displayLots  = useManual ? (strategy.manualLots as number) : scalpLots
                const displayRisk  = useManual ? displayLots * 10 * Math.max(1, signalSlPips) : scalpRiskAmt
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
                        ? `${signalSlPips.toFixed(1)}p SL × $10/pip-lot`
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
        <div style={{ fontSize: 10, color: 'var(--text-dim)', letterSpacing: 2, fontWeight: 700, paddingLeft: 2 }}>
          MIRROR TRADES
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

            const mirrorSl = sig && sig.sl !== sig.entry ? 2 * sig.entry - sig.sl : 0
            const mirrorTp = sig && sig.tp !== sig.entry ? 2 * sig.entry - sig.tp : 0

            const signalSlPips = sig && dir !== 'HOLD' && sig.entry !== sig.sl
              ? Math.abs(sig.entry - sig.sl) / getPipValue(pair)
              : strategy.slPips
            const effectiveRiskPct = pfEnabled && pfRiskCap !== null && pfRiskCap < strategy.riskPct
              ? pfRiskCap
              : strategy.riskPct
            const scalpLots    = calcStandardPositionSize(accountBalance, effectiveRiskPct, Math.max(1, signalSlPips), pair)
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
                      {sig?.marketRegime && (
                        <span
                          title={`ADX ${sig.adx?.toFixed?.(1) ?? '?'} — gate ≥${sig.effectiveMinStrength}%`}
                          style={{
                            fontSize: 9, fontWeight: 700, letterSpacing: 1,
                            padding: '2px 6px', borderRadius: 2,
                            textTransform: 'uppercase',
                            background:
                              sig.marketRegime === 'strong-trend' ? 'rgba(0,200,83,0.18)' :
                              sig.marketRegime === 'trending'     ? 'rgba(0,150,255,0.18)' :
                              sig.marketRegime === 'weak-trend'   ? 'rgba(255,170,0,0.18)' :
                                                                    'rgba(255,255,255,0.08)',
                            color:
                              sig.marketRegime === 'strong-trend' ? 'var(--color-buy)' :
                              sig.marketRegime === 'trending'     ? '#42a5f5' :
                              sig.marketRegime === 'weak-trend'   ? '#ffaa00' :
                                                                    'var(--text-muted)',
                          }}
                        >
                          {sig.marketRegime}
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

                {/* Price levels with mirrored SL/TP */}
                {sig && !sig.blocked && dir !== 'HOLD' && (
                  <div style={{ display: 'flex', gap: 6 }}>
                    {([
                      { label: 'ENTRY', val: sig.entry, color: 'var(--color-accent)' },
                      { label: 'SL',    val: mirrorSl,  color: 'var(--color-loss)' },
                      { label: 'TP',    val: mirrorTp,  color: 'var(--color-profit)' },
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
                )}

                {/* Lot size / risk row */}
                {sig && !sig.blocked && dir !== 'HOLD' && (() => {
                  const useManual    = typeof strategy.manualLots === 'number' && strategy.manualLots > 0
                  const displayLots  = useManual ? (strategy.manualLots as number) : scalpLots
                  const displayRisk  = useManual ? displayLots * 10 * Math.max(1, signalSlPips) : scalpRiskAmt
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
                          ? `${signalSlPips.toFixed(1)}p SL × $10/pip-lot`
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
