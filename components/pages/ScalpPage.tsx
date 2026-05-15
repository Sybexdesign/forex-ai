'use client'
// components/pages/ScalpPage.tsx — 5m Scalping Mode

import { useState, useEffect, useCallback, useRef } from 'react'
import { Panel, LoadingDots, ChecklistItem } from '../ui'
import { authFetch } from '@/lib/api'
import { getPipValue, getPipValuePerLot, calcStandardPositionSize } from '@/lib/brokers/interface'
import type { StrategySettings } from '@/lib/supabase'
import type { PriceData } from '@/hooks/useForex'

// ─── Types ────────────────────────────────────────────────────────────────────

type SessionStatus = 'IDLE' | 'ACTIVE' | 'PAUSED' | 'COOLDOWN' | 'STOPPED'

interface SessionTrade {
  id: string
  pair: string
  direction: 'BUY' | 'SELL'
  lots: number
  entryPrice: number
  slPrice: number
  tp1Price: number
  tp2Price: number
  tp3Price: number
  result?: 'WIN' | 'LOSS'
  closedPL?: number
  enteredAt: number
  closedAt?: number
  oandaTradeId?: string
}

interface SessionState {
  status: SessionStatus
  startTime: number | null
  tradeCount: number
  lossStreak: number
  cooldownEnd: number | null
  sessionPL: number
  trades: SessionTrade[]
}

interface Ind {
  ema20: number
  ema50: number
  emaCrossed: boolean
  emaCrossSignal: string
  rsi: number
  macdHistogram: number
  macdCrossover: string
  currentPrice: number
  adx: number
  adxStrength: string
}

// ─── Constants ────────────────────────────────────────────────────────────────

const SESSION_MAX_MS  = 2 * 60 * 60 * 1000
const SESSION_WARN_MS = (1 * 60 + 45) * 60 * 1000
const COOLDOWN_MS     = 60 * 60 * 1000
const MAX_TRADES      = 5
const MAX_LOSS_STREAK = 2

const SCALP_PAIRS = ['EUR/USD', 'GBP/USD', 'USD/JPY', 'AUD/USD', 'XAU/USD']

const SPREAD_RED: Record<string, number> = {
  'EUR/USD': 0.00015,
  'GBP/USD': 0.00020,
  'USD/JPY': 0.020,
  'AUD/USD': 0.00020,
  'XAU/USD': 0.50,
}
const SPREAD_YELLOW: Record<string, number> = {
  'EUR/USD': 0.00012,
  'GBP/USD': 0.00015,
  'USD/JPY': 0.015,
  'AUD/USD': 0.00015,
  'XAU/USD': 0.35,
}

const C_GREEN  = '#00ff87'
const C_RED    = '#ff3056'
const C_AMBER  = '#ffb800'
const C_BLUE   = '#0080ff'
const C_DIM    = 'var(--text-muted)'

// ─── Helpers ─────────────────────────────────────────────────────────────────

function fmtDuration(ms: number): string {
  const s = Math.floor(ms / 1000)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
  return `${m}:${String(sec).padStart(2, '0')}`
}

function getSpreadColor(spread: number, pair: string): 'green' | 'yellow' | 'red' {
  const red    = SPREAD_RED[pair]    ?? 0.00030
  const yellow = SPREAD_YELLOW[pair] ?? 0.00020
  if (spread >= red)    return 'red'
  if (spread >= yellow) return 'yellow'
  return 'green'
}

function spreadToPips(spread: number, pair: string): number {
  return +(spread / getPipValue(pair)).toFixed(1)
}

function getScalpSLPips(pair: string, fallback: number): number {
  if (pair === 'XAU/USD')  return Math.min(fallback, 50)
  if (pair.includes('JPY')) return Math.min(fallback, 20)
  return Math.min(fallback, 15)
}

function isBlockedSessionTime(h: number, m: number): boolean {
  return (h === 7 && m < 15) || (h === 16 && m >= 45)
}

function dp(pair: string): number {
  return pair.includes('JPY') ? 3 : pair.startsWith('XAU') ? 2 : 5
}

const STATUS_COLOR: Record<SessionStatus, string> = {
  IDLE: '#8090a0', ACTIVE: C_GREEN, PAUSED: C_AMBER, COOLDOWN: C_RED, STOPPED: '#8090a0',
}

// ─── ScalpPage ────────────────────────────────────────────────────────────────

interface Props {
  prices: Record<string, PriceData>
  account: any
  strategy: StrategySettings
  onToast: (msg: string, color?: string) => void
  userId?: string
  onRefreshAccount?: () => void
  onRefreshTrades?: () => void
}

export default function ScalpPage({ prices, account, strategy, onToast, userId, onRefreshAccount, onRefreshTrades }: Props) {
  const [pair, setPair]         = useState('EUR/USD')
  const [ind5m, setInd5m]       = useState<Ind | null>(null)
  const [ind4h, setInd4h]       = useState<Ind | null>(null)
  const [loadingInd, setLoading] = useState(false)
  const [dataSimulated, setDataSimulated] = useState(false)
  const [now, setNow]           = useState(() => new Date())
  const [activeTrade, setActive] = useState<SessionTrade | null>(null)
  const [placing, setPlacing]   = useState(false)
  const [closing, setClosing]   = useState(false)

  const [session, setSession] = useState<SessionState>({
    status: 'IDLE', startTime: null, tradeCount: 0,
    lossStreak: 0, cooldownEnd: null, sessionPL: 0, trades: [],
  })

  const warned1h45 = useRef(false)
  const tp1Alerted = useRef(false)

  // 1-second ticker
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000)
    return () => clearInterval(id)
  }, [])

  // Auto-stop after 2h + warn at 1h45m
  useEffect(() => {
    if (session.status !== 'ACTIVE' || !session.startTime) return
    const elapsed = Date.now() - session.startTime
    if (elapsed >= SESSION_MAX_MS) {
      setSession(s => ({ ...s, status: 'STOPPED' }))
      onToast('Session auto-stopped — 2 hour limit reached', C_AMBER)
    } else if (elapsed >= SESSION_WARN_MS && !warned1h45.current) {
      warned1h45.current = true
      onToast('⚠ 1h45m elapsed — session stops in 15 minutes', C_AMBER)
    }
  }, [now]) // eslint-disable-line react-hooks/exhaustive-deps

  // Cooldown countdown → auto-resume
  useEffect(() => {
    if (session.status !== 'COOLDOWN' || !session.cooldownEnd) return
    if (Date.now() >= session.cooldownEnd) {
      setSession(s => ({ ...s, status: 'ACTIVE', lossStreak: 0, cooldownEnd: null }))
      onToast('Cooldown complete — trading resumed', C_GREEN)
    }
  }, [now]) // eslint-disable-line react-hooks/exhaustive-deps

  // Fetch both timeframe indicators
  const fetchIndicators = useCallback(async () => {
    setLoading(true)
    try {
      const [r5m, r4h] = await Promise.all([
        authFetch(`/api/indicators?pair=${encodeURIComponent(pair)}&timeframe=5m`),
        authFetch(`/api/indicators?pair=${encodeURIComponent(pair)}&timeframe=4H`),
      ])
      const [d5m, d4h] = await Promise.all([r5m.json(), r4h.json()])
      if (d5m.indicators) setInd5m(d5m.indicators)
      if (d4h.indicators) setInd4h(d4h.indicators)
      setDataSimulated(!!(d5m.simulated || d4h.simulated))
    } catch { /* keep stale */ }
    finally { setLoading(false) }
  }, [pair])

  useEffect(() => {
    fetchIndicators()
    const id = setInterval(fetchIndicators, 30000)
    return () => clearInterval(id)
  }, [fetchIndicators])

  // ─── Derived ──────────────────────────────────────────────────────────────

  const priceData     = prices[pair]
  const livePrice     = priceData?.bid ?? ind5m?.currentPrice ?? 0
  const spread        = priceData?.spread ?? 0
  const spreadClr     = getSpreadColor(spread, pair)
  const spreadPips    = spreadToPips(spread, pair)
  const utcH          = now.getUTCHours()
  const utcM          = now.getUTCMinutes()
  const blockedTime   = isBlockedSessionTime(utcH, utcM)

  // 4H trend
  const noTrend4h = ind4h != null && ind4h.adx < 20
  const trend4h: 'BULLISH' | 'BEARISH' | 'NEUTRAL' = noTrend4h ? 'NEUTRAL' : (
    ind4h ? (ind4h.emaCrossed ? 'BULLISH' : 'BEARISH') : 'NEUTRAL'
  )
  const direction: 'BUY' | 'SELL' | null = trend4h === 'BULLISH' ? 'BUY' : trend4h === 'BEARISH' ? 'SELL' : null

  // 5m confirmations
  const emaOk = ind5m != null && (direction === 'BUY' ? ind5m.emaCrossed : !ind5m.emaCrossed)
  const rsiOk = ind5m != null && (
    direction === 'BUY'  ? (ind5m.rsi >= 40 && ind5m.rsi <= 55) :
    direction === 'SELL' ? (ind5m.rsi >= 45 && ind5m.rsi <= 60) : false
  )
  const macdOk = ind5m != null && (
    direction === 'BUY'  ? ind5m.macdHistogram > 0 :
    direction === 'SELL' ? ind5m.macdHistogram < 0 : false
  )
  const confirmCount = [emaOk, rsiOk, macdOk].filter(Boolean).length

  // Pullback detection: price within 0.3% of EMA20
  const nearEma20 = ind5m != null && livePrice > 0 &&
    Math.abs(livePrice - ind5m.ema20) / ind5m.ema20 < 0.003

  const signalStatus =
    !ind5m                         ? 'LOADING'               :
    trend4h === 'NEUTRAL'          ? 'NO SIGNAL'             :
    confirmCount === 3 && nearEma20 ? 'ENTRY READY'          :
    confirmCount >= 2              ? 'PULLBACK IN PROGRESS'  :
    'WAIT FOR PULLBACK'

  // Position sizing
  const balance  = account?.balance || 10000
  const slPips   = getScalpSLPips(pair, strategy.slPips || 15)
  const lots     = calcStandardPositionSize(balance, strategy.riskPct || 1, slPips, pair)
  const pip      = getPipValue(pair)
  const ppl      = getPipValuePerLot(pair)
  const pDp      = dp(pair)

  function calcLevels(dir: 'BUY' | 'SELL', price: number) {
    const s = dir === 'BUY' ? 1 : -1
    return {
      sl:  price - s * slPips       * pip,
      tp1: price + s * slPips       * pip,
      tp2: price + s * slPips * 1.5 * pip,
      tp3: price + s * slPips * 2   * pip,
    }
  }

  // Unrealized P/L for active trade
  const activePL = activeTrade && livePrice ? (() => {
    const s = activeTrade.direction === 'BUY' ? 1 : -1
    const pipGain = s * (livePrice - activeTrade.entryPrice) / pip
    return pipGain * ppl * activeTrade.lots
  })() : 0

  const tp1Hit = activeTrade && livePrice > 0 && (
    activeTrade.direction === 'BUY' ? livePrice >= activeTrade.tp1Price : livePrice <= activeTrade.tp1Price
  )
  const tp2Hit = activeTrade && livePrice > 0 && (
    activeTrade.direction === 'BUY' ? livePrice >= activeTrade.tp2Price : livePrice <= activeTrade.tp2Price
  )
  const tp3Hit = activeTrade && livePrice > 0 && (
    activeTrade.direction === 'BUY' ? livePrice >= activeTrade.tp3Price : livePrice <= activeTrade.tp3Price
  )

  // TP1 toast — once per trade
  useEffect(() => {
    if (tp1Hit && !tp1Alerted.current) {
      tp1Alerted.current = true
      onToast('TP1 hit — consider closing 50%', C_GREEN)
    }
  }, [tp1Hit]) // eslint-disable-line react-hooks/exhaustive-deps

  // Block reasons
  const blockReasons: string[] = []
  if (session.status !== 'ACTIVE')           blockReasons.push(`Session ${session.status}`)
  if (session.tradeCount >= MAX_TRADES)      blockReasons.push(`Max ${MAX_TRADES} trades used this session`)
  if (spreadClr === 'red')                   blockReasons.push(`Spread too wide (${spreadPips}p)`)
  if (blockedTime)                           blockReasons.push('First/last 15 min of session blocked')
  if (confirmCount < 3)                      blockReasons.push(`Need 3/3 confirmations (${confirmCount}/3)`)
  if (trend4h === 'NEUTRAL')                 blockReasons.push('No clear 4H trend')
  if (activeTrade)                           blockReasons.push('Close current trade first')
  const canTrade = blockReasons.length === 0

  // ─── Actions ─────────────────────────────────────────────────────────────

  function startSession() {
    warned1h45.current = false
    tp1Alerted.current = false
    setSession({ status: 'ACTIVE', startTime: Date.now(), tradeCount: 0, lossStreak: 0, cooldownEnd: null, sessionPL: 0, trades: [] })
    onToast('⚡ Scalp session started', C_GREEN)
  }

  function stopSession() {
    setSession(s => ({ ...s, status: 'STOPPED' }))
    setActive(null)
    onToast('Session stopped', C_AMBER)
  }

  function togglePause() {
    setSession(s => ({ ...s, status: s.status === 'ACTIVE' ? 'PAUSED' : 'ACTIVE' }))
  }

  async function placeTrade(dir: 'BUY' | 'SELL') {
    if (!canTrade || placing) return
    setPlacing(true)
    try {
      const price  = livePrice
      const levels = calcLevels(dir, price)
      const res = await authFetch('/api/orders', {
        method: 'POST',
        body: JSON.stringify({
          pair, direction: dir, strategy, currentPrice: price,
          newsInWindow: false, aiConfidence: confirmCount >= 3 ? 85 : 65,
          checklistScore: confirmCount + 3, userId, scalp: true, slPips,
        }),
      })
      const data = await res.json()
      if (data.blocked) {
        onToast('Blocked: ' + (data.reasons?.[0] || 'Risk rule'), C_RED)
        return
      }
      if (data.success || data.trade) {
        tp1Alerted.current = false
        const trade: SessionTrade = {
          id: data.tradeId || data.trade?.id || String(Date.now()),
          pair, direction: dir, lots, entryPrice: price,
          slPrice: levels.sl, tp1Price: levels.tp1, tp2Price: levels.tp2, tp3Price: levels.tp3,
          enteredAt: Date.now(), oandaTradeId: data.oandaTradeId,
        }
        setActive(trade)
        setSession(s => ({ ...s, tradeCount: s.tradeCount + 1, trades: [...s.trades, trade] }))
        onToast(
          `${dir} ${lots} lots ${pair} — SL ${levels.sl.toFixed(pDp)} — TP1 ${levels.tp1.toFixed(pDp)}`,
          dir === 'BUY' ? C_GREEN : C_RED
        )
        onRefreshTrades?.()
        setTimeout(() => onRefreshAccount?.(), 1500)
      } else {
        onToast('Order failed: ' + (data.error || 'Unknown'), C_RED)
      }
    } catch (e: any) {
      onToast('Error: ' + e.message, C_RED)
    } finally {
      setPlacing(false)
    }
  }

  async function closeTrade(partial = false) {
    if (!activeTrade || closing) return
    setClosing(true)
    try {
      const res = await authFetch('/api/close-trade', {
        method: 'POST',
        body: JSON.stringify({
          tradeId: activeTrade.oandaTradeId || activeTrade.id,
          userId, pair: activeTrade.pair, direction: activeTrade.direction, partial,
        }),
      })
      const data = await res.json()
      const pl = data.pl ?? activePL
      const result: 'WIN' | 'LOSS' = pl >= 0 ? 'WIN' : 'LOSS'

      setSession(s => {
        const newStreak = result === 'LOSS' ? s.lossStreak + 1 : 0
        const updatedTrades = s.trades.map(t =>
          t.id === activeTrade.id ? { ...t, closedPL: pl, result, closedAt: Date.now() } : t
        )
        const newPL = s.sessionPL + pl
        if (!partial && newStreak >= MAX_LOSS_STREAK) {
          const end = Date.now() + COOLDOWN_MS
          onToast('2 consecutive losses — 60-minute cooldown started', C_RED)
          return { ...s, status: 'COOLDOWN', lossStreak: newStreak, cooldownEnd: end, sessionPL: newPL, trades: updatedTrades }
        }
        return { ...s, lossStreak: newStreak, sessionPL: newPL, trades: updatedTrades }
      })

      if (!partial) {
        setActive(null)
        onToast(`Trade closed — ${pl >= 0 ? '+' : ''}$${pl.toFixed(2)}`, pl >= 0 ? C_GREEN : C_RED)
      } else {
        onToast('Closed half at TP1', C_GREEN)
      }
      onRefreshTrades?.()
      onRefreshAccount?.()
    } catch (e: any) {
      onToast('Close error: ' + e.message, C_RED)
    } finally {
      setClosing(false)
    }
  }

  function moveSLtoBE() {
    if (!activeTrade) return
    setActive(t => t ? { ...t, slPrice: t.entryPrice } : t)
    onToast('SL moved to break even (update on broker too)', C_AMBER)
  }

  // Session summary stats
  const wins       = session.trades.filter(t => t.result === 'WIN').length
  const losses     = session.trades.filter(t => t.result === 'LOSS').length
  const closedPips = session.trades.filter(t => t.closedPL !== undefined).reduce((acc, t) => {
    const s = t.direction === 'BUY' ? 1 : -1
    return acc + s * ((t.result === 'WIN' ? t.tp1Price : t.slPrice) - t.entryPrice) / pip
  }, 0)
  const sessionElapsed  = session.startTime ? Date.now() - session.startTime : 0
  const cooldownLeft    = session.cooldownEnd ? Math.max(0, session.cooldownEnd - Date.now()) : 0
  const sessionWarnLeft = session.startTime ? Math.max(0, SESSION_MAX_MS - sessionElapsed) : 0

  // ─── Render helpers ──────────────────────────────────────────────────────

  function Row({ label, value, color }: { label: string; value: React.ReactNode; color?: string }) {
    return (
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
        <span style={{ fontSize: 11, color: C_DIM }}>{label}</span>
        <span className="mono" style={{ fontSize: 12, fontWeight: 700, color: color || 'var(--text-primary)' }}>{value}</span>
      </div>
    )
  }

  // ─── JSX ─────────────────────────────────────────────────────────────────

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>

      {/* ── Simulation Warning ──────────────────────────────────────────── */}
      {dataSimulated && (
        <div style={{
          background: 'rgba(255,184,0,0.12)', border: '1px solid #ffb800',
          borderRadius: 6, padding: '8px 14px',
          color: '#ffb800', fontSize: 13, fontFamily: 'Rajdhani', fontWeight: 700,
          letterSpacing: 0.5,
        }}>
          ⚠ Broker unavailable — indicator data is SIMULATED. Live trading disabled until real data is available.
        </div>
      )}

      {/* ── Trading Hours Bar ───────────────────────────────────────────── */}
      <TradingHoursBar utcHour={utcH} utcMin={utcM} />

      {/* ── Pair Selector ───────────────────────────────────────────────── */}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        {SCALP_PAIRS.map(p => {
          const pd = prices[p]
          const sc = pd ? getSpreadColor(pd.spread, p) : 'yellow'
          const scColor = sc === 'green' ? C_GREEN : sc === 'yellow' ? C_AMBER : C_RED
          const active = p === pair
          return (
            <button
              key={p}
              onClick={() => setPair(p)}
              style={{
                padding: '8px 14px', borderRadius: 4, cursor: 'pointer',
                fontFamily: 'Rajdhani', fontWeight: 700, fontSize: 13, letterSpacing: 1,
                background: active ? 'rgba(0,128,255,0.12)' : 'rgba(255,255,255,0.02)',
                border: `1px solid ${active ? 'rgba(0,128,255,0.5)' : 'var(--border)'}`,
                color: active ? C_BLUE : 'var(--text-secondary)',
                transition: 'all 0.15s',
                display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2, minWidth: 90,
              }}
            >
              <span>{p}</span>
              <span className="mono" style={{ fontSize: 9, color: scColor }}>
                {pd ? pd.bid.toFixed(dp(p)) : '—'}
              </span>
              <span style={{ fontSize: 8, color: scColor }}>
                {pd ? `${spreadToPips(pd.spread, p)}p` : '—'}
              </span>
            </button>
          )
        })}
        {loadingInd && (
          <div style={{ display: 'flex', alignItems: 'center', marginLeft: 8 }}>
            <LoadingDots color={C_BLUE} />
          </div>
        )}
      </div>

      {/* ── Session Control Panel ───────────────────────────────────────── */}
      <Panel bright title="SESSION CONTROL" badge={
        <span style={{
          fontSize: 10, fontWeight: 700, letterSpacing: 1.5, padding: '2px 10px',
          borderRadius: 2, color: STATUS_COLOR[session.status],
          background: `${STATUS_COLOR[session.status]}18`,
          border: `1px solid ${STATUS_COLOR[session.status]}40`,
        }}>
          {session.status}
        </span>
      }>
        <div style={{ padding: '14px 16px' }}>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center', marginBottom: 14 }}>

            {/* START / STOP */}
            {session.status === 'IDLE' || session.status === 'STOPPED' ? (
              <button
                onClick={startSession}
                style={{
                  padding: '12px 32px', borderRadius: 4, cursor: 'pointer',
                  fontFamily: 'Rajdhani', fontWeight: 900, fontSize: 18, letterSpacing: 3,
                  background: 'rgba(0,104,51,0.14)', border: '2px solid rgba(0,255,135,0.45)',
                  color: C_GREEN, boxShadow: '0 0 18px rgba(0,255,135,0.1)',
                }}
              >
                ▶ START SESSION
              </button>
            ) : (
              <>
                <button
                  onClick={stopSession}
                  style={{
                    padding: '12px 28px', borderRadius: 4, cursor: 'pointer',
                    fontFamily: 'Rajdhani', fontWeight: 900, fontSize: 18, letterSpacing: 3,
                    background: 'rgba(255,48,86,0.12)', border: '2px solid rgba(255,48,86,0.45)',
                    color: C_RED,
                  }}
                >
                  ⏹ STOP
                </button>
                {(session.status === 'ACTIVE' || session.status === 'PAUSED') && (
                  <button
                    onClick={togglePause}
                    style={{
                      padding: '10px 20px', borderRadius: 4, cursor: 'pointer',
                      fontFamily: 'Rajdhani', fontWeight: 700, fontSize: 14, letterSpacing: 1,
                      background: 'rgba(255,184,0,0.08)', border: '1px solid rgba(255,184,0,0.35)',
                      color: C_AMBER,
                    }}
                  >
                    {session.status === 'ACTIVE' ? '⏸ PAUSE' : '▶ RESUME'}
                  </button>
                )}
              </>
            )}

            {/* Timer */}
            {session.startTime && session.status !== 'IDLE' && (
              <div style={{ fontFamily: 'JetBrains Mono', fontSize: 24, fontWeight: 700, color: sessionWarnLeft < 15 * 60 * 1000 ? C_AMBER : 'var(--text-primary)' }}>
                {fmtDuration(sessionElapsed)}
              </div>
            )}
          </div>

          {/* Cooldown countdown */}
          {session.status === 'COOLDOWN' && cooldownLeft > 0 && (
            <div style={{
              padding: '10px 14px', borderRadius: 4, marginBottom: 12,
              background: 'rgba(255,48,86,0.08)', border: '1px solid rgba(255,48,86,0.3)',
              display: 'flex', alignItems: 'center', gap: 12,
            }}>
              <span style={{ fontSize: 20 }}>🔴</span>
              <div>
                <div style={{ fontSize: 12, fontWeight: 700, color: C_RED, letterSpacing: 1 }}>COOLDOWN ACTIVE</div>
                <div style={{ fontSize: 11, color: C_DIM, marginTop: 2 }}>
                  2 consecutive losses. Resume in{' '}
                  <span className="mono" style={{ color: C_AMBER }}>{fmtDuration(cooldownLeft)}</span>
                </div>
              </div>
            </div>
          )}

          {/* Stats row */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 10 }}>
            {[
              ['TRADES', `${session.tradeCount}/${MAX_TRADES}`, session.tradeCount >= MAX_TRADES ? C_RED : C_GREEN],
              ['LOSS STREAK', `${session.lossStreak}/${MAX_LOSS_STREAK}`, session.lossStreak >= MAX_LOSS_STREAK ? C_RED : session.lossStreak === 1 ? C_AMBER : 'var(--text-primary)'],
              ['SESSION P/L', `${session.sessionPL >= 0 ? '+' : ''}$${session.sessionPL.toFixed(2)}`, session.sessionPL >= 0 ? C_GREEN : C_RED],
              ['STATUS', session.status, STATUS_COLOR[session.status]],
            ].map(([l, v, c]) => (
              <div key={l as string} style={{ background: 'rgba(0,0,0,0.15)', borderRadius: 3, padding: '8px 10px' }}>
                <div style={{ fontSize: 9, color: C_DIM, letterSpacing: 1.5, marginBottom: 4, fontWeight: 700 }}>{l}</div>
                <div className="mono" style={{ fontSize: 14, fontWeight: 700, color: c as string }}>{v}</div>
              </div>
            ))}
          </div>
        </div>
      </Panel>

      {/* ── Active session panels ────────────────────────────────────────── */}
      {(session.status === 'ACTIVE' || session.status === 'PAUSED' || session.status === 'COOLDOWN') && (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>

            {/* ── Trend Alignment (4H) ─────────────────────────────────── */}
            <Panel title="4H TREND ALIGNMENT">
              <div style={{ padding: '12px 16px' }}>
                {!ind4h ? (
                  <div style={{ textAlign: 'center', padding: 12 }}><LoadingDots /></div>
                ) : (
                  <>
                    {/* Trend direction badge */}
                    <div style={{
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      padding: '12px', marginBottom: 12, borderRadius: 4,
                      background: trend4h === 'BULLISH' ? 'rgba(0,255,135,0.08)' : trend4h === 'BEARISH' ? 'rgba(255,48,86,0.08)' : 'rgba(255,184,0,0.06)',
                      border: `1px solid ${trend4h === 'BULLISH' ? 'rgba(0,255,135,0.3)' : trend4h === 'BEARISH' ? 'rgba(255,48,86,0.3)' : 'rgba(255,184,0,0.25)'}`,
                    }}>
                      <span style={{
                        fontSize: 22, fontWeight: 900, fontFamily: 'Rajdhani', letterSpacing: 3,
                        color: trend4h === 'BULLISH' ? C_GREEN : trend4h === 'BEARISH' ? C_RED : C_AMBER,
                      }}>
                        {trend4h === 'BULLISH' ? '▲ BULLISH' : trend4h === 'BEARISH' ? '▼ BEARISH' : '◆ NEUTRAL'}
                      </span>
                    </div>

                    {/* EMA alignment bar */}
                    <div style={{ marginBottom: 10 }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: C_DIM, marginBottom: 4 }}>
                        <span>EMA 20</span>
                        <span className="mono">{ind4h.ema20.toFixed(pDp)}</span>
                      </div>
                      <div style={{ height: 6, borderRadius: 3, background: 'var(--border)', overflow: 'hidden', marginBottom: 6 }}>
                        <div style={{
                          height: '100%',
                          width: `${Math.min(100, Math.abs(ind4h.ema20 - ind4h.ema50) / ind4h.ema50 * 5000 + 30)}%`,
                          background: ind4h.emaCrossed ? C_GREEN : C_RED,
                          boxShadow: `0 0 6px ${ind4h.emaCrossed ? C_GREEN : C_RED}60`,
                          transition: 'width 0.5s',
                        }} />
                      </div>
                      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: C_DIM, marginBottom: 4 }}>
                        <span>EMA 50</span>
                        <span className="mono">{ind4h.ema50.toFixed(pDp)}</span>
                      </div>
                    </div>

                    <Row label="ADX Strength" value={`${ind4h.adx.toFixed(0)} (${ind4h.adxStrength})`}
                      color={ind4h.adx >= 25 ? C_GREEN : ind4h.adx >= 20 ? C_AMBER : C_RED} />

                    {trend4h === 'NEUTRAL' && (
                      <div style={{ marginTop: 8, padding: '8px 10px', borderRadius: 3, background: 'rgba(255,184,0,0.07)', border: '1px solid rgba(255,184,0,0.25)', fontSize: 11, color: C_AMBER }}>
                        No scalp — 4H trend unclear (ADX &lt; 20)
                      </div>
                    )}
                  </>
                )}
              </div>
            </Panel>

            {/* ── Spread Monitor ───────────────────────────────────────── */}
            <Panel title="SPREAD MONITOR">
              <div style={{ padding: '12px 16px' }}>
                <div style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  padding: '14px', marginBottom: 12, borderRadius: 4,
                  background: spreadClr === 'green' ? 'rgba(0,255,135,0.07)' : spreadClr === 'yellow' ? 'rgba(255,184,0,0.07)' : 'rgba(255,48,86,0.08)',
                  border: `1px solid ${spreadClr === 'green' ? 'rgba(0,255,135,0.3)' : spreadClr === 'yellow' ? 'rgba(255,184,0,0.25)' : 'rgba(255,48,86,0.3)'}`,
                }}>
                  <div style={{ textAlign: 'center' }}>
                    <div className="mono" style={{
                      fontSize: 32, fontWeight: 900, lineHeight: 1,
                      color: spreadClr === 'green' ? C_GREEN : spreadClr === 'yellow' ? C_AMBER : C_RED,
                    }}>
                      {spreadPips}p
                    </div>
                    <div style={{ fontSize: 10, color: C_DIM, marginTop: 4, letterSpacing: 1 }}>
                      {spreadClr === 'green' ? 'GOOD TO TRADE' : spreadClr === 'yellow' ? 'BORDERLINE' : 'TOO WIDE'}
                    </div>
                  </div>
                </div>

                {spreadClr === 'red' && (
                  <div style={{ padding: '8px 10px', borderRadius: 3, background: 'rgba(255,48,86,0.08)', border: '1px solid rgba(255,48,86,0.3)', fontSize: 11, color: C_RED, marginBottom: 8 }}>
                    ⛔ Spread too wide — trade button disabled
                  </div>
                )}

                <div style={{ fontSize: 10, color: C_DIM, marginTop: 8 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 3 }}>
                    <span>Yellow threshold</span>
                    <span className="mono">{spreadToPips(SPREAD_YELLOW[pair] ?? 0.00020, pair)}p</span>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                    <span>Red threshold</span>
                    <span className="mono">{spreadToPips(SPREAD_RED[pair] ?? 0.00030, pair)}p</span>
                  </div>
                </div>

                {blockedTime && (
                  <div style={{ marginTop: 10, padding: '7px 10px', borderRadius: 3, background: 'rgba(255,184,0,0.07)', border: '1px solid rgba(255,184,0,0.25)', fontSize: 11, color: C_AMBER }}>
                    ⚠ Blocked: first/last 15 min of session
                  </div>
                )}
              </div>
            </Panel>
          </div>

          {/* ── Entry Signal Panel (5m) ────────────────────────────────── */}
          <Panel title="5M ENTRY SIGNALS" badge={
            <span style={{
              fontSize: 10, fontWeight: 700, padding: '2px 10px', borderRadius: 2, letterSpacing: 1,
              color: signalStatus === 'ENTRY READY' ? C_GREEN : signalStatus === 'PULLBACK IN PROGRESS' ? C_BLUE : signalStatus === 'NO SIGNAL' ? C_RED : C_AMBER,
              background: signalStatus === 'ENTRY READY' ? 'rgba(0,255,135,0.1)' : 'rgba(0,0,0,0.15)',
              border: `1px solid ${signalStatus === 'ENTRY READY' ? 'rgba(0,255,135,0.3)' : 'rgba(255,255,255,0.08)'}`,
            }}>
              {signalStatus}
            </span>
          }>
            <div style={{ padding: '12px 16px' }}>
              {!ind5m ? (
                <div style={{ textAlign: 'center', padding: 12 }}><LoadingDots /></div>
              ) : (
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12 }}>

                  {/* EMA alignment */}
                  <div style={{ background: 'rgba(0,0,0,0.12)', borderRadius: 3, padding: '10px 12px' }}>
                    <div style={{ fontSize: 9, color: C_DIM, letterSpacing: 1.5, marginBottom: 6, fontWeight: 700 }}>EMA 20 vs 50</div>
                    <div style={{ fontSize: 13, fontWeight: 700, color: emaOk ? C_GREEN : C_RED, marginBottom: 4, fontFamily: 'Rajdhani' }}>
                      {ind5m.emaCrossed ? '▲ BULLISH' : '▼ BEARISH'}
                    </div>
                    <div style={{ fontSize: 10, color: C_DIM }}>{ind5m.ema20.toFixed(pDp)} / {ind5m.ema50.toFixed(pDp)}</div>
                  </div>

                  {/* RSI */}
                  <div style={{ background: 'rgba(0,0,0,0.12)', borderRadius: 3, padding: '10px 12px' }}>
                    <div style={{ fontSize: 9, color: C_DIM, letterSpacing: 1.5, marginBottom: 6, fontWeight: 700 }}>RSI (14)</div>
                    <div className="mono" style={{
                      fontSize: 22, fontWeight: 700, lineHeight: 1, marginBottom: 4,
                      color: rsiOk ? C_GREEN : (ind5m.rsi > 70 || ind5m.rsi < 30) ? C_RED : C_AMBER,
                    }}>
                      {ind5m.rsi.toFixed(1)}
                    </div>
                    <div style={{ fontSize: 10, color: rsiOk ? C_GREEN : C_DIM }}>
                      {direction === 'BUY' ? '40–55 buy zone' : direction === 'SELL' ? '45–60 sell zone' : 'zone —'}
                    </div>
                  </div>

                  {/* MACD */}
                  <div style={{ background: 'rgba(0,0,0,0.12)', borderRadius: 3, padding: '10px 12px' }}>
                    <div style={{ fontSize: 9, color: C_DIM, letterSpacing: 1.5, marginBottom: 6, fontWeight: 700 }}>MACD HISTOGRAM</div>
                    <div className="mono" style={{
                      fontSize: 18, fontWeight: 700, lineHeight: 1, marginBottom: 4,
                      color: macdOk ? C_GREEN : C_RED,
                    }}>
                      {ind5m.macdHistogram > 0 ? '+' : ''}{ind5m.macdHistogram.toFixed(5)}
                    </div>
                    {/* Mini histogram bars */}
                    <div style={{ display: 'flex', gap: 2, alignItems: 'flex-end', height: 16 }}>
                      {[0.3, 0.5, 0.8, 1.0, 0.7, 0.9, 0.6].map((h, i) => (
                        <div key={i} style={{
                          flex: 1, height: `${h * 100}%`, borderRadius: 1,
                          background: ind5m.macdHistogram > 0 ? C_GREEN : C_RED,
                          opacity: 0.4 + h * 0.6,
                        }} />
                      ))}
                    </div>
                  </div>

                  {/* Confirmations checklist (full width) */}
                  <div style={{ gridColumn: '1 / -1', marginTop: 4 }}>
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center', justifyContent: 'space-between' }}>
                      <div style={{ display: 'flex', gap: 10 }}>
                        <ChecklistItem label="EMA aligned to 4H trend" pass={emaOk} />
                        <ChecklistItem label="RSI in zone" pass={rsiOk} />
                        <ChecklistItem label="MACD confirming" pass={macdOk} />
                      </div>
                      <div style={{
                        fontFamily: 'Rajdhani', fontWeight: 900, fontSize: 20,
                        color: confirmCount === 3 ? C_GREEN : confirmCount === 2 ? C_AMBER : C_RED,
                      }}>
                        {confirmCount}/3 {confirmCount === 3 ? 'GO' : 'WAIT'}
                      </div>
                    </div>
                    {nearEma20 && (
                      <div style={{ marginTop: 8, padding: '6px 10px', borderRadius: 3, background: 'rgba(0,255,135,0.08)', border: '1px solid rgba(0,255,135,0.3)', fontSize: 11, color: C_GREEN }}>
                        ⚡ Price near EMA20 — pullback in progress
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
          </Panel>

          {/* ── Quick Trade Execution ────────────────────────────────────── */}
          <Panel bright title="QUICK TRADE EXECUTION">
            <div style={{ padding: '14px 16px' }}>

              {/* Preview */}
              {direction && livePrice > 0 && (() => {
                const lvl = calcLevels(direction, livePrice)
                return (
                  <div style={{
                    padding: '10px 14px', borderRadius: 3, marginBottom: 14,
                    background: 'rgba(0,128,255,0.07)', border: '1px solid rgba(0,128,255,0.2)',
                    fontSize: 12, color: 'var(--text-secondary)', fontFamily: 'JetBrains Mono',
                  }}>
                    {direction} {lots} lots {pair} — SL {lvl.sl.toFixed(pDp)} — TP1 {lvl.tp1.toFixed(pDp)} — TP2 {lvl.tp2.toFixed(pDp)} — TP3 {lvl.tp3.toFixed(pDp)}
                  </div>
                )
              })()}

              {/* Block reasons */}
              {blockReasons.length > 0 && (
                <div style={{ marginBottom: 12 }}>
                  {blockReasons.map((r, i) => (
                    <div key={i} style={{ fontSize: 11, color: C_RED, padding: '3px 0', display: 'flex', gap: 6 }}>
                      <span>⛔</span><span>{r}</span>
                    </div>
                  ))}
                </div>
              )}

              {/* BUY / SELL buttons */}
              <div style={{ display: 'flex', gap: 10 }}>
                <button
                  disabled={!canTrade || direction !== 'BUY' || placing || session.status !== 'ACTIVE' || dataSimulated}
                  onClick={() => placeTrade('BUY')}
                  style={{
                    flex: 1, padding: '16px', borderRadius: 4, cursor: canTrade && direction === 'BUY' ? 'pointer' : 'not-allowed',
                    fontFamily: 'Rajdhani', fontWeight: 900, fontSize: 20, letterSpacing: 3,
                    background: direction === 'BUY' && canTrade ? 'rgba(0,104,51,0.18)' : 'rgba(0,0,0,0.08)',
                    border: `2px solid ${direction === 'BUY' && canTrade ? 'rgba(0,255,135,0.5)' : 'rgba(0,255,135,0.15)'}`,
                    color: direction === 'BUY' && canTrade ? C_GREEN : 'rgba(0,255,135,0.25)',
                    opacity: direction !== 'BUY' ? 0.4 : 1,
                    transition: 'all 0.15s',
                  }}
                >
                  {placing ? <LoadingDots color={C_GREEN} /> : '▲ BUY'}
                </button>

                <button
                  disabled={!canTrade || direction !== 'SELL' || placing || session.status !== 'ACTIVE' || dataSimulated}
                  onClick={() => placeTrade('SELL')}
                  style={{
                    flex: 1, padding: '16px', borderRadius: 4, cursor: canTrade && direction === 'SELL' ? 'pointer' : 'not-allowed',
                    fontFamily: 'Rajdhani', fontWeight: 900, fontSize: 20, letterSpacing: 3,
                    background: direction === 'SELL' && canTrade ? 'rgba(255,48,86,0.14)' : 'rgba(0,0,0,0.08)',
                    border: `2px solid ${direction === 'SELL' && canTrade ? 'rgba(255,48,86,0.5)' : 'rgba(255,48,86,0.15)'}`,
                    color: direction === 'SELL' && canTrade ? C_RED : 'rgba(255,48,86,0.25)',
                    opacity: direction !== 'SELL' ? 0.4 : 1,
                    transition: 'all 0.15s',
                  }}
                >
                  {placing ? <LoadingDots color={C_RED} /> : '▼ SELL'}
                </button>
              </div>

              {/* Risk preview */}
              <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                {[
                  ['LOTS', `${lots}`, 'var(--text-primary)'],
                  ['RISK', `$${(balance * (strategy.riskPct || 1) / 100).toFixed(2)}`, C_AMBER],
                  ['SL PIPS', `${slPips}p`, C_RED],
                  ['TP1', `${(slPips * 1).toFixed(0)}p`, C_GREEN],
                  ['TP2', `${(slPips * 1.5).toFixed(0)}p`, C_GREEN],
                  ['TP3', `${(slPips * 2).toFixed(0)}p`, C_GREEN],
                ].map(([l, v, c]) => (
                  <div key={l} style={{ flex: 1, background: 'rgba(0,0,0,0.12)', borderRadius: 3, padding: '6px 8px', textAlign: 'center' }}>
                    <div style={{ fontSize: 8, color: C_DIM, letterSpacing: 1, marginBottom: 3 }}>{l}</div>
                    <div className="mono" style={{ fontSize: 11, fontWeight: 700, color: c as string }}>{v}</div>
                  </div>
                ))}
              </div>
            </div>
          </Panel>

          {/* ── Active Trade Manager ───────────────────────────────────── */}
          {activeTrade && (
            <Panel bright title="ACTIVE TRADE" badge={
              <span className="mono" style={{ fontSize: 11, color: C_AMBER }}>
                {fmtDuration(Date.now() - activeTrade.enteredAt)} in trade
              </span>
            }>
              <div style={{ padding: '14px 16px' }}>
                {/* Header */}
                <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: 14 }}>
                  <span style={{
                    fontFamily: 'Rajdhani', fontWeight: 900, fontSize: 28, letterSpacing: 2,
                    color: activeTrade.direction === 'BUY' ? C_GREEN : C_RED,
                  }}>
                    {activeTrade.direction}
                  </span>
                  <div>
                    <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--text-primary)', fontFamily: 'Rajdhani' }}>
                      {activeTrade.pair}
                    </div>
                    <div style={{ fontSize: 11, color: C_DIM }}>{activeTrade.lots} lots @ {activeTrade.entryPrice.toFixed(pDp)}</div>
                  </div>
                  <div style={{ marginLeft: 'auto', textAlign: 'right' }}>
                    <div className="mono" style={{ fontSize: 26, fontWeight: 900, color: activePL >= 0 ? C_GREEN : C_RED, lineHeight: 1 }}>
                      {activePL >= 0 ? '+' : ''}${activePL.toFixed(2)}
                    </div>
                    <div style={{ fontSize: 10, color: C_DIM, marginTop: 2 }}>unrealized P/L</div>
                  </div>
                </div>

                {/* TP progress bars */}
                {[
                  { label: 'TP1 (1:1)', price: activeTrade.tp1Price, hit: tp1Hit },
                  { label: 'TP2 (1:1.5)', price: activeTrade.tp2Price, hit: tp2Hit },
                  { label: 'TP3 (1:2)', price: activeTrade.tp3Price, hit: tp3Hit },
                ].map(({ label, price, hit }) => {
                  const total = Math.abs(price - activeTrade.entryPrice)
                  const current = Math.abs(livePrice - activeTrade.entryPrice)
                  const pct = total > 0 ? Math.min(100, (current / total) * 100) : 0
                  return (
                    <div key={label} style={{ marginBottom: 8 }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: hit ? C_GREEN : C_DIM, marginBottom: 3 }}>
                        <span>{label} {hit ? '✓ HIT' : ''}</span>
                        <span className="mono">{price.toFixed(pDp)}</span>
                      </div>
                      <div style={{ height: 5, background: 'var(--border)', borderRadius: 3, overflow: 'hidden' }}>
                        <div style={{
                          height: '100%', width: `${pct}%`, borderRadius: 3,
                          background: hit ? C_GREEN : C_BLUE,
                          boxShadow: hit ? `0 0 8px ${C_GREEN}60` : 'none',
                          transition: 'width 0.5s',
                        }} />
                      </div>
                    </div>
                  )
                })}

                {/* SL */}
                <div style={{ marginBottom: 14 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: C_RED, marginBottom: 3 }}>
                    <span>STOP LOSS</span>
                    <span className="mono">{activeTrade.slPrice.toFixed(pDp)}</span>
                  </div>
                  <div style={{ height: 3, background: 'rgba(255,48,86,0.2)', borderRadius: 2 }} />
                </div>

                {/* Action buttons */}
                <div style={{ display: 'flex', gap: 8 }}>
                  {tp1Hit && (
                    <button
                      onClick={() => closeTrade(true)}
                      disabled={closing}
                      style={{
                        flex: 1, padding: '10px', borderRadius: 3, cursor: 'pointer',
                        fontFamily: 'Rajdhani', fontWeight: 700, fontSize: 13, letterSpacing: 1,
                        background: 'rgba(0,255,135,0.08)', border: '1px solid rgba(0,255,135,0.35)', color: C_GREEN,
                      }}
                    >
                      {closing ? <LoadingDots /> : '↕ Close Half at TP1'}
                    </button>
                  )}
                  <button
                    onClick={moveSLtoBE}
                    style={{
                      flex: 1, padding: '10px', borderRadius: 3, cursor: 'pointer',
                      fontFamily: 'Rajdhani', fontWeight: 700, fontSize: 13, letterSpacing: 1,
                      background: 'rgba(255,184,0,0.07)', border: '1px solid rgba(255,184,0,0.3)', color: C_AMBER,
                    }}
                  >
                    → Move SL to BE
                  </button>
                  <button
                    onClick={() => closeTrade(false)}
                    disabled={closing}
                    style={{
                      flex: 1, padding: '10px', borderRadius: 3, cursor: 'pointer',
                      fontFamily: 'Rajdhani', fontWeight: 700, fontSize: 13, letterSpacing: 1,
                      background: 'rgba(255,48,86,0.1)', border: '1px solid rgba(255,48,86,0.35)', color: C_RED,
                    }}
                  >
                    {closing ? <LoadingDots /> : '✕ Close All'}
                  </button>
                </div>
              </div>
            </Panel>
          )}

          {/* ── Scalp Rules Engine ──────────────────────────────────────── */}
          <Panel title="SCALP RULES ENGINE">
            <div style={{ padding: '12px 16px', display: 'flex', flexDirection: 'column', gap: 6 }}>
              <ChecklistItem label={`Max ${MAX_TRADES} trades per session (${session.tradeCount}/${MAX_TRADES} used)`} pass={session.tradeCount < MAX_TRADES} />
              <ChecklistItem label={`2 consecutive losses triggers 60-min cooldown (streak: ${session.lossStreak}/${MAX_LOSS_STREAK})`} pass={session.lossStreak < MAX_LOSS_STREAK} />
              <ChecklistItem label={`Only trade in 4H direction (${trend4h})`} pass={trend4h !== 'NEUTRAL'} />
              <ChecklistItem label={`Spread within threshold (${spreadPips}p)`} pass={spreadClr !== 'red'} />
              <ChecklistItem label="Not in blocked time window (07:00–07:15 / 16:45–17:00 UTC)" pass={!blockedTime} />
              <ChecklistItem label={`3/3 confirmations required (${confirmCount}/3)`} pass={confirmCount >= 3} />
            </div>
          </Panel>
        </>
      )}

      {/* ── Session Summary ──────────────────────────────────────────────── */}
      {session.status === 'STOPPED' && session.trades.length > 0 && (
        <Panel bright title="SESSION SUMMARY">
          <div style={{ padding: '16px' }}>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 12, marginBottom: 16 }}>
              {[
                ['TOTAL TRADES', session.tradeCount, 'var(--text-primary)'],
                ['WINS', wins, C_GREEN],
                ['LOSSES', losses, C_RED],
                ['SESSION P/L', `${session.sessionPL >= 0 ? '+' : ''}$${session.sessionPL.toFixed(2)}`, session.sessionPL >= 0 ? C_GREEN : C_RED],
                ['PIPS', `${closedPips >= 0 ? '+' : ''}${closedPips.toFixed(1)}`, closedPips >= 0 ? C_GREEN : C_RED],
                ['DURATION', fmtDuration(sessionElapsed), C_BLUE],
              ].map(([l, v, c]) => (
                <div key={l as string} style={{ background: 'rgba(0,0,0,0.15)', borderRadius: 4, padding: '10px 12px' }}>
                  <div style={{ fontSize: 9, color: C_DIM, letterSpacing: 1.5, marginBottom: 4, fontWeight: 700 }}>{l}</div>
                  <div className="mono" style={{ fontSize: 18, fontWeight: 700, color: c as string }}>{v}</div>
                </div>
              ))}
            </div>

            {/* Trade log */}
            <div style={{ fontSize: 10, color: C_DIM, letterSpacing: 1.5, marginBottom: 8, fontWeight: 700 }}>TRADE LOG</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {session.trades.map((t, i) => {
                const pl = t.closedPL ?? 0
                const color = t.result === 'WIN' ? C_GREEN : t.result === 'LOSS' ? C_RED : C_AMBER
                return (
                  <div key={t.id} style={{
                    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                    padding: '7px 10px', borderRadius: 3,
                    background: 'rgba(0,0,0,0.1)', border: `1px solid ${color}20`,
                  }}>
                    <span style={{ fontSize: 11, color: C_DIM }}>#{i + 1}</span>
                    <span style={{ fontSize: 12, fontWeight: 700, color, fontFamily: 'Rajdhani', letterSpacing: 1 }}>{t.direction}</span>
                    <span style={{ fontSize: 11, color: 'var(--text-secondary)' }}>{t.pair}</span>
                    <span className="mono" style={{ fontSize: 11, color }}>{t.result || 'OPEN'}</span>
                    <span className="mono" style={{ fontSize: 11, color: pl >= 0 ? C_GREEN : C_RED }}>
                      {t.closedPL !== undefined ? `${pl >= 0 ? '+' : ''}$${pl.toFixed(2)}` : '—'}
                    </span>
                    {t.closedAt && t.enteredAt && (
                      <span style={{ fontSize: 10, color: C_DIM }}>{fmtDuration(t.closedAt - t.enteredAt)}</span>
                    )}
                  </div>
                )
              })}
            </div>

            <button
              onClick={startSession}
              style={{
                marginTop: 16, width: '100%', padding: '12px', borderRadius: 4, cursor: 'pointer',
                fontFamily: 'Rajdhani', fontWeight: 700, fontSize: 15, letterSpacing: 2,
                background: 'rgba(0,128,255,0.07)', border: '1px solid rgba(0,128,255,0.3)', color: C_BLUE,
              }}
            >
              ▶ START NEW SESSION
            </button>
          </div>
        </Panel>
      )}

    </div>
  )
}

// ─── Trading Hours Bar ────────────────────────────────────────────────────────

function TradingHoursBar({ utcHour, utcMin }: { utcHour: number; utcMin: number }) {
  const pct = ((utcHour * 60 + utcMin) / (24 * 60)) * 100
  const isOverlap = utcHour >= 13 && utcHour < 16
  const isAsian   = utcHour < 7
  const isLondon  = utcHour >= 7 && utcHour < 16
  const isNY      = utcHour >= 13 && utcHour < 22

  const sessionLabel = isOverlap ? 'OVERLAP (OPTIMAL)' : isLondon && !isNY ? 'LONDON' : isNY && !isLondon ? 'NY' : isAsian ? 'ASIAN (AVOID FOREX)' : 'OFF-SESSION'
  const sessionColor = isOverlap ? C_GREEN : isLondon || isNY ? C_BLUE : isAsian ? C_RED : C_DIM

  return (
    <div style={{ background: 'var(--bg-panel)', border: '1px solid var(--border)', borderRadius: 4, padding: '10px 14px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <span style={{ fontSize: 10, color: C_DIM, letterSpacing: 1.5, fontWeight: 700 }}>TRADING HOURS (UTC)</span>
        <span style={{
          fontSize: 10, fontWeight: 700, letterSpacing: 1, padding: '2px 8px', borderRadius: 2,
          color: sessionColor, background: `${sessionColor}16`, border: `1px solid ${sessionColor}30`,
        }}>
          {sessionLabel}
        </span>
      </div>
      {/* 24-hour bar */}
      <div style={{ position: 'relative', height: 22, borderRadius: 3, background: 'rgba(0,0,0,0.2)', overflow: 'hidden' }}>
        {/* London */}
        <div style={{ position: 'absolute', left: `${7/24*100}%`, width: `${9/24*100}%`, top: 0, bottom: 0, background: 'rgba(0,128,255,0.2)', borderLeft: '1px solid rgba(0,128,255,0.4)' }} />
        {/* NY */}
        <div style={{ position: 'absolute', left: `${13/24*100}%`, width: `${9/24*100}%`, top: 0, bottom: 0, background: 'rgba(0,128,255,0.15)', borderLeft: '1px solid rgba(0,128,255,0.3)' }} />
        {/* Overlap */}
        <div style={{ position: 'absolute', left: `${13/24*100}%`, width: `${3/24*100}%`, top: 0, bottom: 0, background: 'rgba(0,255,135,0.18)', borderLeft: '1px solid rgba(0,255,135,0.4)' }} />
        {/* Current time marker */}
        <div style={{
          position: 'absolute', left: `${pct}%`, top: 0, bottom: 0, width: 2,
          background: C_AMBER, boxShadow: `0 0 6px ${C_AMBER}`,
          transform: 'translateX(-50%)',
        }} />
        {/* Labels */}
        {[
          { pos: 7/24*100 + 1, label: 'LON', color: C_BLUE },
          { pos: 13/24*100 + 0.5, label: 'OVERLAP', color: C_GREEN },
          { pos: 17/24*100 + 1, label: 'NY', color: C_BLUE },
        ].map(({ pos, label, color }) => (
          <span key={label} style={{ position: 'absolute', left: `${pos}%`, top: '50%', transform: 'translateY(-50%)', fontSize: 8, color, letterSpacing: 0.5, fontWeight: 700 }}>
            {label}
          </span>
        ))}
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 9, color: C_DIM, marginTop: 3 }}>
        <span>00:00</span><span>06:00</span><span>12:00</span><span>18:00</span><span>24:00</span>
      </div>
    </div>
  )
}
