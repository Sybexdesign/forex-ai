'use client'
// components/pages/AutoTradePage.tsx
// Full-auto + semi-auto trading with prop firm enforcement

import { useState, useEffect, useRef, useCallback } from 'react'
import { Panel, LoadingDots, CopyValue } from '../ui'
import { calcStandardPositionSize, getPipValue, getPipValuePerLot } from '@/lib/brokers/interface'
import { authFetch } from '@/lib/api'
import type { ScanSignal, ScanDiagnostic } from '@/hooks/useScanner'
import type { StrategySettings } from '@/lib/supabase'

const TIMEFRAMES = ['1m', '3m', '5m', '15m', '30m', '1H', '4H']
const METALS_ONLY = ['XAU/USD', 'XAG/USD']
const DIR_COLOR: Record<string, string> = { BUY: 'var(--color-buy)', SELL: 'var(--color-sell)' }
const PAGE_SIZE = 5
const SCALP_REFRESH_MS = 15_000  // refresh scalp signals every 15 seconds
const SCALP_EXPIRY_MS  = 3 * 60_000  // 3-minute signal validity

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

export default function AutoTradePage({ strategy, account, onToast, newsInWindow = false, userId, prices = {}, onRefreshAccount, onRefreshTrades, scanner, timeframe, setTimeframe, watchlist: rawWatchlist }: AutoTradePageProps) {
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

  // Auto-trading — all settings persisted to localStorage so state survives reload/refresh
  const [autoTradeEnabled, setAutoTradeEnabled] = useState<boolean>(() => {
    try { return localStorage.getItem('at_enabled') === 'true' } catch { return false }
  })
  const [profitTargetPct, setProfitTargetPct] = useState<number>(() => {
    try { return parseInt(localStorage.getItem('at_targetPct') || '75', 10) } catch { return 75 }
  })
  const [fixedProfitUsd, setFixedProfitUsd] = useState<number>(() => {
    try { return parseFloat(localStorage.getItem('at_fixedUsd') || '0') } catch { return 0 }
  })
  const [maxConcurrentTrades, setMaxConcurrentTrades] = useState<number>(() => {
    try { return parseInt(localStorage.getItem('at_maxTrades') || '2', 10) } catch { return 2 }
  })
  const [autoSections, setAutoSections] = useState<Set<string>>(() => {
    try {
      const s = localStorage.getItem('at_sections')
      return s ? new Set(JSON.parse(s)) : new Set(['scalp'])
    } catch { return new Set(['scalp']) }
  })
  const [autoPairs, setAutoPairs] = useState<Set<string>>(() => {
    try {
      const s = localStorage.getItem('at_pairs')
      return s ? new Set(JSON.parse(s)) : new Set(METALS_ONLY)
    } catch { return new Set(METALS_ONLY) }
  })
  const autoScalpExecutedRef                      = useRef<Set<string>>(new Set())
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
  useEffect(() => { openTradesRef.current = openTrades }, [openTrades])
  useEffect(() => { pricesRef.current = prices }, [prices])
  useEffect(() => { accountRef.current = account }, [account])

  // Persist auto-trade settings to localStorage on every change
  useEffect(() => { try { localStorage.setItem('at_enabled',   String(autoTradeEnabled))       } catch {} }, [autoTradeEnabled])
  useEffect(() => { try { localStorage.setItem('at_targetPct', String(profitTargetPct))         } catch {} }, [profitTargetPct])
  useEffect(() => { try { localStorage.setItem('at_fixedUsd',  String(fixedProfitUsd))          } catch {} }, [fixedProfitUsd])
  useEffect(() => { try { localStorage.setItem('at_maxTrades', String(maxConcurrentTrades))     } catch {} }, [maxConcurrentTrades])
  useEffect(() => { try { localStorage.setItem('at_sections',  JSON.stringify([...autoSections])) } catch {} }, [autoSections])
  useEffect(() => { try { localStorage.setItem('at_pairs',     JSON.stringify([...autoPairs]))    } catch {} }, [autoPairs])

  // Sync fixed profit target to EA via broker config — EA enforces it natively in MT5
  // without any browser dependency. Fires whenever the user changes the value.
  useEffect(() => {
    authFetch('/api/broker/profit-target', {
      method: 'POST',
      body: JSON.stringify({ value: fixedProfitUsd }),
    }).catch(() => {})
  }, [fixedProfitUsd])

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
      // Derive SL/TP in pips from the signal's actual price levels so the broker
      // places stops exactly where the card displayed them, and lot size matches.
      const scalpSlPips = sig.sl !== sig.entry ? Math.abs(sig.entry - sig.sl) / pip : strategy.slPips
      const scalpTpPips = sig.tp !== sig.entry ? Math.abs(sig.entry - sig.tp) / pip : strategy.tpPips
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
      const slPips = sig.sl !== sig.entry ? Math.abs(sig.entry - sig.sl) / pip : strategy.slPips
      const tpPips = sig.tp !== sig.entry ? Math.abs(sig.entry - sig.tp) / pip : strategy.tpPips
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
    const slPips = sig.sl !== sig.entry ? Math.abs(sig.entry - sig.sl) / pip : strategy.slPips
    const tpPips = sig.tp !== sig.entry ? Math.abs(sig.entry - sig.tp) / pip : strategy.tpPips
    const direction = isMirror ? (sig.direction === 'BUY' ? 'SELL' : 'BUY') : sig.direction
    const prefix    = isMirror ? 'mirror' : 'scalp'
    const body: Record<string, any> = {
      pair: sig.pair, direction,
      strategy:             { ...strategy, slPips, tpPips },
      currentPrice:         sig.entry,
      newsInWindow,
      aiConfidence:         sig.confidence,
      checklistScore:       5,
      userId,
      signalId:             `${prefix}-${sig.pair.replace('/', '')}-${sig.fetchedAt}`,
      maxConcurrentTrades,  // server enforces the same limit as the UI
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

  // Auto-trade: execute scalp/mirror signals when autoTradeEnabled
  useEffect(() => {
    if (!autoTradeEnabled) return
    void (async () => {
      // Effective open count = DB open trades minus any currently being auto-closed.
      // This prevents placing a new trade for a slot that's in the process of being freed.
      let localOpenCount = openTradesRef.current.length - closingForTargetRef.current.size
      for (const [pair, sig] of Object.entries(scalpSignals)) {
        if (!sig || sig.direction === 'HOLD' || sig.blocked) continue
        if (!autoPairs.has(pair)) continue
        if (Date.now() > sig.expiresAt) continue
        for (const section of ['scalp', 'mirror']) {
          if (!autoSections.has(section)) continue
          const key = `${section}-${pair}-${sig.fetchedAt}`
          if (autoScalpExecutedRef.current.has(key)) continue
          if (localOpenCount >= maxConcurrentTrades) continue
          autoScalpExecutedRef.current.add(key)
          const isMirror = section === 'mirror'
          const dir = isMirror ? (sig.direction === 'BUY' ? 'SELL' : 'BUY') : sig.direction
          const ok = await autoPlaceOrder(sig, isMirror)
          if (ok) {
            localOpenCount++   // immediately count this placement; don't wait for DB refresh
            onToast(`⚡ Auto: ${dir} ${pair} (${section === 'scalp' ? 'scalp' : 'mirror'})`, DIR_COLOR[dir] || '#00e5b4')
            loadOpenTrades()
            onRefreshTrades?.()
            setTimeout(() => onRefreshAccount?.(), 1500)
          }
        }
      }
    })()
  }, [scalpSignals, autoTradeEnabled, maxConcurrentTrades]) // eslint-disable-line react-hooks/exhaustive-deps

  // Profit target monitoring — 2s interval, dual mode: fixed USD (priority) + % of expected TP
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
      // This is the ONLY place we clear the guard — ensures no re-trigger until confirmed closed
      for (const guardId of [...closingForTargetRef.current]) {
        if (!trades.some((t: any) => t.id === guardId)) {
          closingForTargetRef.current.delete(guardId)
        }
      }

      for (const trade of trades) {
        if (closingForTargetRef.current.has(trade.id)) continue

        const pip     = getPipValue(trade.pair)
        const pvpl    = getPipValuePerLot(trade.pair)
        const pairKey = trade.pair.replace('/', '')
        const entry   = trade.entry_price ?? 0
        const lots    = trade.lots        ?? 0

        // ── Get current floating profit ──────────────────────────────
        // Prefer EA's live unrealizedPL (actual MT5 account P&L).
        // Match by stripped symbol + direction since EA uses no-slash keys.
        let currentProfit: number | null = null
        const eaPos = (accountRef.current?.openTrades as any[] | undefined)?.find(p => {
          const sym = String(p.pair || p.symbol || '').replace('/', '')
          return sym === pairKey && p.direction === trade.direction
        })
        if (eaPos?.unrealizedPL != null) {
          currentProfit = Number(eaPos.unrealizedPL)
        } else if (entry && lots) {
          // Fallback: compute from live bid price
          const liveBid = pricesRef.current[trade.pair]?.bid ?? pricesRef.current[pairKey]?.bid
          if (liveBid) {
            const pipsGained = trade.direction === 'BUY'
              ? (liveBid - entry) / pip
              : (entry - liveBid) / pip
            currentProfit = pipsGained * pvpl * lots
          }
        }

        if (currentProfit == null) {
          console.debug(`[profit-monitor] ${trade.pair}: no profit data (entry=${entry} lots=${lots} eaPos=${!!eaPos})`)
          continue
        }

        console.debug(`[profit-monitor] ${trade.pair} ${trade.direction}: $${currentProfit.toFixed(2)} | fixed=${fixedProfitUsd > 0 ? '$'+fixedProfitUsd : 'off'} pct=${profitTargetPct}%`)

        if (currentProfit <= 0) continue

        // Priority 1: fixed USD target — higher priority than %
        if (fixedProfitUsd > 0 && currentProfit >= fixedProfitUsd) {
          const snap = { pair: trade.pair, profit: currentProfit, target: fixedProfitUsd }
          console.log(`[profit-monitor] CLOSE ${snap.pair}: $${snap.profit.toFixed(2)} >= fixed $${snap.target}`)
          closingForTargetRef.current.add(trade.id)
          handleClose(trade)
            .then(ok => { if (ok) onToast(`⚡ Auto-closed ${snap.pair} @ $${snap.target.toFixed(2)} fixed target (+$${snap.profit.toFixed(2)})`, '#00e5b4') })
          continue
        }

        // Priority 2: % of expected TP profit
        const tp = trade.tp_price ?? 0
        if (!tp || !entry || !lots) continue
        const expectedProfit = Math.abs(tp - entry) / pip * pvpl * lots
        if (expectedProfit <= 0) continue

        if (currentProfit >= expectedProfit * profitTargetPct / 100) {
          const snap = { pair: trade.pair, profit: currentProfit, pct: profitTargetPct }
          console.log(`[profit-monitor] CLOSE ${snap.pair}: $${snap.profit.toFixed(2)} >= ${snap.pct}% of $${expectedProfit.toFixed(2)}`)
          closingForTargetRef.current.add(trade.id)
          handleClose(trade)
            .then(ok => { if (ok) onToast(`⚡ Auto-closed ${snap.pair} @ ${snap.pct}% target (+$${snap.profit.toFixed(2)})`, '#00e5b4') })
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

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>

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
                ? `Active · ${openTrades.length} / ${maxConcurrentTrades} trades open · ${fixedProfitUsd > 0 ? `$${fixedProfitUsd.toFixed(2)} fixed` : `${profitTargetPct}% target`}`
                : 'Configure below then enable'}
            </div>
          </div>
          <button
            onClick={() => setAutoTradeEnabled(v => !v)}
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
              PROFIT TARGET (%) — auto-close at this % of expected TP
            </div>
            <div className="btn-pill-row" style={{ marginBottom: 10 }}>
              {[50, 65, 75, 100].map(pct => (
                <button key={pct} onClick={() => setProfitTargetPct(pct)} style={{
                  padding: '5px 14px', borderRadius: 3, border: 'none', cursor: 'pointer',
                  fontWeight: 700, fontSize: 12,
                  background: profitTargetPct === pct ? 'rgba(0,229,180,0.18)' : 'rgba(255,255,255,0.05)',
                  color: profitTargetPct === pct ? '#00e5b4' : 'var(--text-muted)',
                }}>{pct}%</button>
              ))}
            </div>
            <div style={{ fontSize: 9, color: 'var(--text-dim)', letterSpacing: 1.5, marginBottom: 6, fontWeight: 700 }}>
              FIXED USD TARGET — close immediately at this profit (0 = disabled, overrides %)
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
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
            {fixedProfitUsd > 0 && (
              <div style={{ fontSize: 10, color: '#00e5b4', marginTop: 5 }}>
                Active — any trade reaching +${fixedProfitUsd.toFixed(2)} closes immediately
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
              {sig && !sig.blocked && dir !== 'HOLD' && (
                <div style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                  background: 'rgba(0,85,176,0.07)', border: '1px solid rgba(0,85,176,0.18)',
                  borderRadius: 2, padding: '6px 8px',
                }}>
                  <div>
                    <div style={{ fontSize: 9, color: 'var(--color-accent)', letterSpacing: 1, marginBottom: 1 }}>POSITION</div>
                    <span style={{ fontSize: 16, fontWeight: 900, color: 'var(--color-accent)', fontFamily: 'JetBrains Mono', lineHeight: 1 }}>
                      {scalpLots.toFixed(2)}
                    </span>
                    <span style={{ fontSize: 10, color: 'var(--text-muted)', marginLeft: 4 }}>lots</span>
                  </div>
                  <div style={{ textAlign: 'right', fontSize: 10, color: 'var(--text-muted)', lineHeight: 1.5 }}>
                    <div style={{ color: 'var(--color-loss)' }}>${scalpRiskAmt.toFixed(2)} at risk</div>
                    <div>{effectiveRiskPct}% of ${accountBalance.toLocaleString()}</div>
                    {pfCapped && (
                      <div style={{ color: 'var(--color-wait)', fontWeight: 700 }}>PF capped ↓{pfRiskCap}%</div>
                    )}
                  </div>
                </div>
              )}

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
                {sig && !sig.blocked && dir !== 'HOLD' && (
                  <div style={{
                    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                    background: 'rgba(0,85,176,0.07)', border: '1px solid rgba(0,85,176,0.18)',
                    borderRadius: 2, padding: '6px 8px',
                  }}>
                    <div>
                      <div style={{ fontSize: 9, color: 'var(--color-accent)', letterSpacing: 1, marginBottom: 1 }}>POSITION</div>
                      <span style={{ fontSize: 16, fontWeight: 900, color: 'var(--color-accent)', fontFamily: 'JetBrains Mono', lineHeight: 1 }}>
                        {scalpLots.toFixed(2)}
                      </span>
                      <span style={{ fontSize: 10, color: 'var(--text-muted)', marginLeft: 4 }}>lots</span>
                    </div>
                    <div style={{ textAlign: 'right', fontSize: 10, color: 'var(--text-muted)', lineHeight: 1.5 }}>
                      <div style={{ color: 'var(--color-loss)' }}>${scalpRiskAmt.toFixed(2)} at risk</div>
                      <div>{effectiveRiskPct}% of ${accountBalance.toLocaleString()}</div>
                      {pfCapped && (
                        <div style={{ color: 'var(--color-wait)', fontWeight: 700 }}>PF capped ↓{pfRiskCap}%</div>
                      )}
                    </div>
                  </div>
                )}

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
