'use client'
// components/pages/ScalperPage.tsx — ForexAI Scalper Phase 2 (Real Infrastructure)

import { useState, useEffect, useCallback, useRef } from 'react'
import { Panel, ChecklistItem, LiveDot, StrengthBar, CopyValue } from '../ui'
import { authJson } from '@/lib/api'
import type { PriceData } from '@/hooks/useForex'
import type { StrategySettings } from '@/lib/supabase'

// ─── Types ───────────────────────────────────────────────────────────────────

type EngineStatus = 'STOPPED' | 'RUNNING' | 'PAUSED'
type TradeDirection = 'BUY' | 'SELL' | 'HOLD'
type Mode = 'PAPER' | 'LIVE'
type ConnStatus = 'idle' | 'live' | 'simulated' | 'fallback' | 'error'

interface TickData {
  price: number; rsi14: number; rsi7: number
  ema9: number; ema21: number; ema20: number; ema50: number
  macdLine: number; macdSignal: number; macdHistogram: number
  bbUpper: number; bbMiddle: number; bbLower: number; bbWidth: number
  adx: number; atr: number; atrPips: number
  spread: number; spreadPips: number; buyPressure: number; tickVolume: number
  stochRsiK?: number; stochRsiD?: number
  emaCrossSignal: string; broker: string; simulated: boolean; timestamp: number
}

interface Signal {
  direction: TradeDirection; confidence: number; reasons: string[]
  entry: number; sl: number; tp: number; risk_note?: string; fallback?: boolean
  strategy: string; timestamp: number
}

interface RiskCheck {
  passed: boolean
  checks: { label: string; ok: boolean }[]
}

interface ScalperTrade {
  id: string; pair: string; direction: TradeDirection
  entry: number; sl: number; tp: number
  confidence: number; strategy: string; openTime: string
  closeTime?: string; closePrice?: number; pnl: number
  result?: 'TP' | 'SL'; mode: Mode
}

interface LogEntry {
  msg: string; type: 'info' | 'trade' | 'win' | 'loss' | 'system' | 'risk'; time: string
}

interface Props {
  prices: Record<string, PriceData>
  account: any
  strategy: StrategySettings
  onToast: (msg: string, color?: string) => void
  userId?: string
  onRefreshAccount?: () => void
  onRefreshTrades?: () => void
}

// ─── Constants ───────────────────────────────────────────────────────────────

const SCALPER_PAIRS = ['XAU/USD', 'XAG/USD']
const TIMEFRAMES    = ['1m', '3m', '5m', '15m']
const STRATEGIES    = ['Momentum', 'Mean Reversion', 'Breakout', 'Order Flow']
const TICK_INTERVAL = 10_000
const SIGNAL_EVERY  = 3

const C = {
  green: '#00ff87', greenDim: 'rgba(0,255,135,0.12)', greenBorder: 'rgba(0,255,135,0.3)',
  red: '#ff3056', redDim: 'rgba(255,48,86,0.1)', redBorder: 'rgba(255,48,86,0.25)',
  amber: '#ffb800', amberDim: 'rgba(255,184,0,0.08)', amberBorder: 'rgba(255,184,0,0.25)',
  blue: '#0080ff', cyan: '#00c8ff', purple: '#a855f7', teal: '#14b8a6',
  muted: 'var(--text-muted)',
}

function dp(pair: string) { return pair.includes('JPY') ? 3 : pair.startsWith('XA') ? 2 : 5 }
function pipSize(pair: string) { return pair.includes('JPY') ? 0.01 : pair.startsWith('XAU') ? 0.1 : pair.startsWith('XAG') ? 0.01 : 0.0001 }

// ─── Risk gate ────────────────────────────────────────────────────────────────

const RISK_CFG = { maxRiskPct: 1, maxDailyLossPct: 3, maxOpenTrades: 3, minConfidence: 70, slMult: 1.5, tpMult: 2.5 }

function checkRisk(sig: Signal | null, balance: number, dailyPnL: number, openCount: number): RiskCheck {
  const checks: { label: string; ok: boolean }[] = []
  let passed = true

  const riskAmt = balance * RISK_CFG.maxRiskPct / 100
  const riskOk  = balance > 0  // balance 0 = can't size a trade
  if (!riskOk) passed = false
  checks.push({ label: `Risk ≤ ${RISK_CFG.maxRiskPct}% ($${riskAmt.toFixed(0)})`, ok: riskOk })

  const limit = balance * RISK_CFG.maxDailyLossPct / 100
  if (dailyPnL < -limit) { checks.push({ label: 'Daily loss limit hit', ok: false }); passed = false }
  else checks.push({ label: `Daily P&L: $${dailyPnL.toFixed(2)}`, ok: true })

  if (openCount >= RISK_CFG.maxOpenTrades) { checks.push({ label: `Max ${RISK_CFG.maxOpenTrades} trades reached`, ok: false }); passed = false }
  else checks.push({ label: `${openCount}/${RISK_CFG.maxOpenTrades} open`, ok: true })

  if (!sig || sig.direction === 'HOLD') { checks.push({ label: 'No signal (HOLD)', ok: false }); passed = false }
  else if (sig.confidence < RISK_CFG.minConfidence) {
    checks.push({ label: `Confidence ${sig.confidence}% < ${RISK_CFG.minConfidence}%`, ok: false }); passed = false
  } else checks.push({ label: `Confidence: ${sig.confidence}%`, ok: true })

  return { passed, checks }
}

// ─── Sparkline ────────────────────────────────────────────────────────────────

function Sparkline({ data, color = C.cyan, h = 40 }: { data: number[]; color?: string; h?: number }) {
  if (!data || data.length < 2) return null
  const min = Math.min(...data), max = Math.max(...data), range = max - min || 1
  const w = 200
  const pts = data.map((v, i) => `${(i / (data.length - 1)) * w},${h - ((v - min) / range) * (h - 4)}`).join(' ')
  return (
    <svg width="100%" viewBox={`0 0 ${w} ${h}`} style={{ display: 'block' }}>
      <polyline points={pts} fill="none" stroke={color} strokeWidth="1.5" strokeLinejoin="round" opacity={0.8} />
    </svg>
  )
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function ScalperPage({ prices, account, strategy, onToast, userId, onRefreshAccount, onRefreshTrades }: Props) {
  const [engineStatus, setEngineStatus]     = useState<EngineStatus>('STOPPED')
  const [mode, setMode]                     = useState<Mode>('PAPER')
  const [confirmLive, setConfirmLive]       = useState(false)
  const [pair, setPair]                     = useState('XAU/USD')
  const [timeframe, setTimeframe]           = useState('5m')
  const [activeStrategy, setActiveStrategy] = useState('Breakout')

  const [tickData, setTickData]       = useState<TickData | null>(null)
  const [signal, setSignal]           = useState<Signal | null>(null)
  const [riskResult, setRiskResult]   = useState<RiskCheck | null>(null)
  const [brokerConn, setBrokerConn]   = useState<ConnStatus>('idle')
  const [aiConn, setAiConn]           = useState<ConnStatus>('idle')

  const [priceHistory, setPriceHistory] = useState<number[]>([])
  const [rsiHistory, setRsiHistory]     = useState<number[]>([])

  const [openTrades, setOpenTrades]   = useState<ScalperTrade[]>([])
  const [closedTrades, setClosedTrades] = useState<ScalperTrade[]>([])
  const [dailyPnL, setDailyPnL]       = useState(0)
  const [tradeCount, setTradeCount]   = useState(0)
  const [winCount, setWinCount]       = useState(0)
  const [balance, setBalance]         = useState(10000)
  const [logs, setLogs]               = useState<LogEntry[]>([])
  const [tickCount, setTickCount]     = useState(0)
  const [isFetching, setIsFetching]   = useState(false)

  const intervalRef   = useRef<ReturnType<typeof setInterval> | null>(null)
  const tickCountRef  = useRef(0)
  const latestTickRef = useRef<() => Promise<void>>(async () => {})

  // Refs for volatile state — avoids stale closures in tick/fetchSignal
  const signalRef     = useRef<Signal | null>(null)
  const balanceRef    = useRef(balance)
  const dailyPnLRef   = useRef(dailyPnL)
  const openTradesRef = useRef<ScalperTrade[]>([])
  const modeRef       = useRef<Mode>('PAPER')
  const pairRef       = useRef(pair)
  const strategyRef   = useRef(activeStrategy)
  const decimalsRef   = useRef(dp(pair))

  useEffect(() => { signalRef.current     = signal },      [signal])
  useEffect(() => { balanceRef.current    = balance },     [balance])
  useEffect(() => { dailyPnLRef.current   = dailyPnL },   [dailyPnL])
  useEffect(() => { openTradesRef.current = openTrades },  [openTrades])
  useEffect(() => { modeRef.current       = mode },                          [mode])
  useEffect(() => { pairRef.current       = pair; decimalsRef.current = dp(pair) }, [pair])
  useEffect(() => { strategyRef.current   = activeStrategy },               [activeStrategy])
  const timeframeRef = useRef(timeframe)
  useEffect(() => { timeframeRef.current  = timeframe },                    [timeframe])

  const decimals = dp(pair)

  const addLog = useCallback((msg: string, type: LogEntry['type'] = 'info') => {
    setLogs(prev => [{ msg, type, time: new Date().toLocaleTimeString('en', { hour12: false }) }, ...prev].slice(0, 80))
  }, [])

  useEffect(() => { if (account?.balance)     setBalance(account.balance) },     [account?.balance])
  // In LIVE mode, sync daily P&L from broker's realizedPL (OANDA's session P&L)
  useEffect(() => {
    if (mode === 'LIVE' && account?.realizedPL !== undefined) setDailyPnL(account.realizedPL)
  }, [mode, account?.realizedPL])

  // ── Reset on pair change ──────────────────────────────────────────────────
  useEffect(() => {
    setTickData(null); setSignal(null); setRiskResult(null)
    setPriceHistory([]); setRsiHistory([])
    setOpenTrades([]); setBrokerConn('idle'); setAiConn('idle')
    tickCountRef.current = 0; setTickCount(0); setIsFetching(false)
    addLog(`Switched to ${pair}`, 'system')
  }, [pair]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Monitor paper trades for SL/TP on each tick ──────────────────────────
  const monitorTrades = useCallback((price: number) => {
    setOpenTrades(prev => {
      const stillOpen: ScalperTrade[] = []
      const nowClosed: ScalperTrade[] = []

      prev.forEach(t => {
        let hit: 'SL' | 'TP' | null = null
        if (t.direction === 'BUY')  { if (price <= t.sl) hit = 'SL'; else if (price >= t.tp) hit = 'TP' }
        else                        { if (price >= t.sl) hit = 'SL'; else if (price <= t.tp) hit = 'TP' }

        if (hit) {
          const rawPnl = t.direction === 'BUY' ? price - t.entry : t.entry - price
          const pnlUsd = pair.startsWith('XAU') ? rawPnl * 100 : pair.includes('JPY') ? rawPnl * 1000 : rawPnl * 100000
          const closed = { ...t, closePrice: price, closeTime: new Date().toLocaleTimeString('en', { hour12: false }), pnl: pnlUsd, result: hit }
          nowClosed.push(closed)
          addLog(`Closed ${t.pair} ${t.direction} → ${hit} | P&L: $${pnlUsd.toFixed(2)}`, pnlUsd >= 0 ? 'win' : 'loss')
          setDailyPnL(d => d + pnlUsd)
          setTradeCount(c => c + 1)
          if (pnlUsd > 0) setWinCount(w => w + 1)
          setBalance(b => b + pnlUsd)
        } else stillOpen.push(t)
      })

      if (nowClosed.length) setClosedTrades(p => [...nowClosed, ...p].slice(0, 50))
      return stillOpen
    })
  }, [pair, addLog])

  // ── Fetch signal from API ────────────────────────────────────────────────
  // Note: reads volatile state from refs to avoid stale closures
  const fetchSignal = useCallback(async (tick: TickData) => {
    const currentPair     = pairRef.current
    const currentStrategy = strategyRef.current
    const currentDecimals = decimalsRef.current

    try {
      const data = await authJson<any>('/api/scalper/signal', {
        method: 'POST',
        body: JSON.stringify({ ...tick, pair: currentPair, strategy: currentStrategy, userId }),
      })

      const sig: Signal = {
        direction:  data.direction,
        confidence: data.confidence,
        reasons:    data.reasons || [],
        entry:      data.entry,
        sl:         data.sl,
        tp:         data.tp,
        risk_note:  data.risk_note,
        fallback:   data.fallback,
        strategy:   currentStrategy,
        timestamp:  Date.now(),
      }
      setSignal(sig)
      signalRef.current = sig
      setAiConn(data.fallback ? 'fallback' : 'live')

      // Evaluate risk with the FRESH signal (not the stale previous one)
      const freshRisk = checkRisk(sig, balanceRef.current, dailyPnLRef.current, openTradesRef.current.length)
      setRiskResult(freshRisk)

      if (sig.direction !== 'HOLD' && freshRisk.passed) {
        if (modeRef.current === 'PAPER') {
          const trade: ScalperTrade = {
            id: Date.now().toString(), pair: currentPair, direction: sig.direction,
            entry: sig.entry, sl: sig.sl, tp: sig.tp,
            confidence: sig.confidence, strategy: currentStrategy,
            openTime: new Date().toLocaleTimeString('en', { hour12: false }),
            pnl: 0, mode: 'PAPER',
          }
          setOpenTrades(prev => {
            if (prev.length < RISK_CFG.maxOpenTrades) {
              addLog(`[PAPER] ${sig.direction} ${currentPair} @ ${sig.entry.toFixed(currentDecimals)} | SL ${sig.sl.toFixed(currentDecimals)} TP ${sig.tp.toFixed(currentDecimals)} | ${sig.confidence}%`, 'trade')
              onToast(`Paper: ${sig.direction} ${currentPair} @ ${sig.entry.toFixed(currentDecimals)}`, sig.direction === 'BUY' ? C.green : C.red)
              return [...prev, trade]
            }
            return prev
          })
        } else {
          try {
            const order = await authJson<any>('/api/orders', {
              method: 'POST',
              body: JSON.stringify({
                pair: currentPair, direction: sig.direction, strategy,
                userId, newsInWindow: false,
                aiConfidence: sig.confidence, checklistScore: 0,
                currentPrice: tick.price,
              }),
            })
            if (order.success || order.tradeId) {
              addLog(`[LIVE] ${sig.direction} ${currentPair} @ ${tick.price.toFixed(currentDecimals)} — order placed`, 'trade')
              onToast(`LIVE: ${sig.direction} ${currentPair} @ ${tick.price.toFixed(currentDecimals)}`, sig.direction === 'BUY' ? C.green : C.red)
              const liveTrade: ScalperTrade = {
                id: order.tradeId || Date.now().toString(),
                pair: currentPair, direction: sig.direction,
                entry: tick.price, sl: sig.sl, tp: sig.tp,
                confidence: sig.confidence, strategy: currentStrategy,
                openTime: new Date().toLocaleTimeString('en', { hour12: false }),
                pnl: 0, mode: 'LIVE',
              }
              setOpenTrades(prev => prev.length < RISK_CFG.maxOpenTrades ? [...prev, liveTrade] : prev)
              onRefreshAccount?.()
              onRefreshTrades?.()
            } else {
              addLog(`[LIVE] Order blocked: ${order.reasons?.[0] || order.reason || 'unknown'}`, 'risk')
            }
          } catch (e: any) {
            addLog(`[LIVE] Order failed: ${e.message}`, 'risk')
          }
        }
      }
    } catch {
      setAiConn('error')
      addLog('Signal API error — retrying next cycle', 'risk')
    }
  }, [userId, strategy, addLog, onToast, onRefreshAccount])

  // ── Main tick — reads volatile state from refs, stable dep array ─────────
  const tick = useCallback(async () => {
    const currentPair = pairRef.current
    const currentTF   = timeframeRef.current ?? timeframe

    setIsFetching(true)
    try {
      const data: TickData = await authJson(`/api/scalper/tick?pair=${encodeURIComponent(currentPair)}&timeframe=${encodeURIComponent(currentTF)}`)
      setTickData(data)
      setBrokerConn(data.simulated ? 'simulated' : 'live')
      setPriceHistory(p => [...p, data.price].slice(-60))
      setRsiHistory(p => [...p, data.rsi14].slice(-60))

      tickCountRef.current++
      setTickCount(tickCountRef.current)

      if (modeRef.current === 'PAPER') {
        monitorTrades(data.price)
      } else {
        // LIVE mode: pull real open positions from broker each tick
        try {
          const posData = await authJson<{ trades: any[] }>('/api/oanda/trades')
          if (Array.isArray(posData.trades)) {
            const liveTrades: ScalperTrade[] = posData.trades.map(t => ({
              id: t.id,
              pair: t.pair,
              direction: t.direction as TradeDirection,
              entry: t.entryPrice,
              sl: t.stopLossPrice ?? 0,
              tp: t.takeProfitPrice ?? 0,
              confidence: 0,
              strategy: 'Broker',
              openTime: new Date(t.openTime).toLocaleTimeString('en', { hour12: false }),
              pnl: t.unrealizedPL ?? 0,
              mode: 'LIVE',
            }))
            // Detect positions that closed since last tick
            const newIds = new Set(liveTrades.map(t => t.id))
            openTradesRef.current.forEach(pt => {
              if (pt.mode === 'LIVE' && !newIds.has(pt.id)) {
                addLog(`[LIVE] Position closed: ${pt.pair} ${pt.direction} | P&L: $${pt.pnl.toFixed(2)}`, pt.pnl >= 0 ? 'win' : 'loss')
                setClosedTrades(p => [{
                  ...pt,
                  closeTime: new Date().toLocaleTimeString('en', { hour12: false }),
                  closePrice: data.price,
                  result: (pt.pnl >= 0 ? 'TP' : 'SL') as 'TP' | 'SL',
                }, ...p].slice(0, 50))
                setTradeCount(c => c + 1)
                if (pt.pnl > 0) setWinCount(w => w + 1)
              }
            })
            setOpenTrades(liveTrades)
          }
        } catch { /* non-critical */ }
      }

      if (tickCountRef.current % SIGNAL_EVERY === 0) {
        await fetchSignal(data)
      } else {
        const risk = checkRisk(signalRef.current, balanceRef.current, dailyPnLRef.current, openTradesRef.current.length)
        setRiskResult(risk)
      }
    } catch {
      setBrokerConn('error')
      addLog('Tick fetch failed — check broker connection', 'risk')
    } finally {
      setIsFetching(false)
    }
  }, [timeframe, monitorTrades, fetchSignal, addLog]) // pair/TF refs kept in sync; no volatile state in deps

  // Keep latestTickRef pointing to the current tick function
  useEffect(() => { latestTickRef.current = tick }, [tick])

  // ── Engine start/stop — interval calls latestTickRef, never restarts mid-run
  useEffect(() => {
    if (engineStatus === 'RUNNING') {
      addLog(`Scalper engine started [${modeRef.current} mode]`, 'system')
      latestTickRef.current()
      intervalRef.current = setInterval(() => latestTickRef.current(), TICK_INTERVAL)
    } else {
      if (intervalRef.current) clearInterval(intervalRef.current)
      setIsFetching(false)
      if (engineStatus === 'STOPPED') { tickCountRef.current = 0; setTickCount(0) }
      if (engineStatus === 'PAUSED') addLog('Engine paused', 'system')
    }
    return () => { if (intervalRef.current) clearInterval(intervalRef.current) }
  }, [engineStatus, addLog])

  const currentPrice = tickData?.price ?? prices[pair]?.bid ?? 0
  const winRate = tradeCount > 0 ? Math.round((winCount / tradeCount) * 100) : 0

  const dirColor  = (d?: TradeDirection) => d === 'BUY' ? C.green : d === 'SELL' ? C.red : C.amber
  const dirBg     = (d?: TradeDirection) => d === 'BUY' ? 'rgba(0,255,135,0.12)' : d === 'SELL' ? 'rgba(255,48,86,0.1)' : 'rgba(255,184,0,0.08)'
  const dirBorder = (d?: TradeDirection) => d === 'BUY' ? 'rgba(0,255,135,0.3)' : d === 'SELL' ? 'rgba(255,48,86,0.25)' : 'rgba(255,184,0,0.25)'

  const connColor: Record<ConnStatus, string> = {
    idle: 'var(--text-muted)', live: C.green, simulated: C.amber, fallback: C.amber, error: C.red,
  }
  const connLabel: Record<ConnStatus, string> = {
    idle: 'IDLE', live: 'LIVE', simulated: 'SIM', fallback: 'FALLBACK', error: 'ERROR',
  }

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div style={{ maxWidth: 1200 }}>
      <style>{`@keyframes spin { from { transform: rotate(0deg) } to { transform: rotate(360deg) } }`}</style>
      {/* LIVE mode confirmation dialog */}
      {confirmLive && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', zIndex: 2000, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ background: 'var(--bg-panel)', border: '1px solid rgba(255,48,86,0.5)', borderRadius: 6, padding: 28, maxWidth: 440, width: '90%' }}>
            <div style={{ fontFamily: 'Rajdhani', fontSize: 18, fontWeight: 700, color: C.red, marginBottom: 10 }}>⚠ Switch to LIVE Mode?</div>
            <div style={{ fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.7, marginBottom: 20 }}>
              In LIVE mode the scalper will place <strong>real orders</strong> with your connected broker using your strategy risk settings.
              Trades are executed automatically when signal confidence ≥ {RISK_CFG.minConfidence}% and all risk checks pass.
              <br /><br />
              Make sure your broker is connected and risk limits are configured correctly before proceeding.
            </div>
            <div style={{ display: 'flex', gap: 10 }}>
              <button
                onClick={() => { setEngineStatus('STOPPED'); setMode('LIVE'); setConfirmLive(false); addLog('Switched to LIVE mode — restart engine to begin', 'system') }}
                style={btnStyle(C.red)}
              >
                YES, GO LIVE
              </button>
              <button onClick={() => setConfirmLive(false)} style={btnStyle('var(--text-muted)')}>CANCEL</button>
            </div>
          </div>
        </div>
      )}

      {/* ── Header ── */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12, flexWrap: 'wrap', gap: 12 }}>
        <div>
          <div style={{ fontFamily: 'Rajdhani', fontSize: 22, fontWeight: 700, color: C.cyan, letterSpacing: 1 }}>
            FOREXAI SCALPER
          </div>
          <div style={{ fontSize: 11, color: 'var(--text-muted)', letterSpacing: 1 }}>
            6-layer AI scalping engine — real broker + Claude AI
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          {/* Mode toggle */}
          <div style={{ display: 'flex', borderRadius: 3, overflow: 'hidden', border: '1px solid var(--border)' }}>
            <button
              onClick={() => setMode('PAPER')}
              style={{ padding: '5px 14px', fontSize: 11, fontWeight: 700, letterSpacing: 1, cursor: 'pointer', border: 'none', background: mode === 'PAPER' ? C.amber + '30' : 'transparent', color: mode === 'PAPER' ? C.amber : 'var(--text-muted)' }}
            >
              PAPER
            </button>
            <button
              onClick={() => { if (mode !== 'LIVE') setConfirmLive(true) }}
              style={{ padding: '5px 14px', fontSize: 11, fontWeight: 700, letterSpacing: 1, cursor: 'pointer', border: 'none', background: mode === 'LIVE' ? 'rgba(255,48,86,0.2)' : 'transparent', color: mode === 'LIVE' ? C.red : 'var(--text-muted)' }}
            >
              LIVE
            </button>
          </div>
          {/* Engine status */}
          <LiveDot color={engineStatus === 'RUNNING' ? C.green : C.red} />
          <span className="mono" style={{ fontSize: 11, fontWeight: 700, letterSpacing: 1, color: engineStatus === 'RUNNING' ? C.green : engineStatus === 'PAUSED' ? C.amber : 'var(--text-muted)' }}>
            {engineStatus}
          </span>
          {engineStatus === 'RUNNING' ? (
            <div style={{ display: 'flex', gap: 6 }}>
              <button onClick={() => setEngineStatus('PAUSED')} style={btnStyle(C.amber)}>⏸ PAUSE</button>
              <button onClick={() => setEngineStatus('STOPPED')} style={btnStyle(C.red)}>■ STOP</button>
            </div>
          ) : (
            <button onClick={() => setEngineStatus('RUNNING')} style={btnStyle(C.green)}>▶ START ENGINE</button>
          )}
        </div>
      </div>

      {/* ── Connection status bar ── */}
      <div style={{ display: 'flex', gap: 12, marginBottom: 10, flexWrap: 'wrap', fontSize: 10, alignItems: 'center' }}>
        <StatusPill label="BROKER" value={tickData?.broker || 'Not connected'} color={connColor[brokerConn]} tag={connLabel[brokerConn]} />
        <StatusPill label="AI" value={aiConn === 'live' ? 'Claude API' : aiConn === 'fallback' ? 'Rule-based fallback' : 'Not called yet'} color={connColor[aiConn]} tag={connLabel[aiConn]} />
        <StatusPill label="MODE" value={mode === 'LIVE' ? 'Real execution' : 'Simulated P&L'} color={mode === 'LIVE' ? C.red : C.amber} tag={mode} />
        {tickData && (
          <StatusPill label="LAST TICK" value={new Date(tickData.timestamp).toLocaleTimeString('en', { hour12: false })} color="var(--text-muted)" tag="" />
        )}
        {engineStatus === 'RUNNING' && tickCount > 0 && (
          <StatusPill
            label="NEXT SIGNAL"
            value={tickCount % SIGNAL_EVERY === 0 ? 'Analysing…' : `in ${SIGNAL_EVERY - (tickCount % SIGNAL_EVERY)} tick${SIGNAL_EVERY - (tickCount % SIGNAL_EVERY) === 1 ? '' : 's'}`}
            color={tickCount % SIGNAL_EVERY === 0 ? C.cyan : 'var(--text-muted)'}
            tag=""
          />
        )}
        {isFetching && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '4px 10px', borderRadius: 3, border: `1px solid ${C.cyan}30`, background: `${C.cyan}08`, fontSize: 10, color: C.cyan }}>
            <span style={{ animation: 'spin 1s linear infinite', display: 'inline-block' }}>⟳</span>
            <span>FETCHING</span>
          </div>
        )}
      </div>

      {/* ── Pair selector ── */}
      <div style={{ display: 'flex', gap: 6, marginBottom: 8, flexWrap: 'wrap' }}>
        {SCALPER_PAIRS.map(p => (
          <button key={p} onClick={() => { setPair(p); setEngineStatus('STOPPED') }} style={pillStyle(p === pair)}>
            <span className="mono">{p}</span>
            {prices[p] && <span className="mono" style={{ fontSize: 10, color: 'var(--text-muted)', marginLeft: 4 }}>{prices[p].bid?.toFixed(dp(p))}</span>}
          </button>
        ))}
      </div>

      {/* ── TF + Strategy ── */}
      <div style={{ display: 'flex', gap: 6, marginBottom: 10, flexWrap: 'wrap', alignItems: 'center' }}>
        <span style={tagStyle}>TF</span>
        {TIMEFRAMES.map(t => (
          <button key={t} onClick={() => setTimeframe(t)} style={pillStyle(t === timeframe)}>
            <span className="mono">{t}</span>
          </button>
        ))}
        <div style={{ width: 1, background: 'var(--border)', margin: '0 4px', height: 20 }} />
        <span style={tagStyle}>STRATEGY</span>
        {STRATEGIES.map(st => (
          <button key={st} onClick={() => setActiveStrategy(st)} style={pillStyle(st === activeStrategy)}>{st}</button>
        ))}
      </div>

      {/* ── Stats row ── */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10, marginBottom: 12 }}>
        <StatCard label="BALANCE" value={`$${balance.toFixed(2)}`} />
        <StatCard label="DAILY P&L" value={`${dailyPnL >= 0 ? '+' : ''}$${dailyPnL.toFixed(2)}`} color={dailyPnL >= 0 ? C.green : C.red} />
        <StatCard label="WIN RATE" value={`${winRate}%`} sub={`${winCount}/${tradeCount}`} color={winRate >= 55 ? C.green : winRate >= 45 ? C.amber : C.red} />
        <StatCard label="OPEN TRADES" value={`${openTrades.length}`} sub={`/${RISK_CFG.maxOpenTrades}`} />
      </div>

      {/* ── Layer 1 + 2 ── */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 12 }}>
        <Panel title="LAYER 1 — MARKET DATA" badge={<LayerBadge label="REAL FEED" color={C.blue} />}>
          <div style={{ padding: 14 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 8 }}>
              <span className="mono" style={{ fontSize: 24, fontWeight: 700 }}>
                {currentPrice > 0 ? currentPrice.toFixed(decimals) : '—'}
              </span>
              <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{pair} · {timeframe}</span>
            </div>
            <Sparkline data={priceHistory} color={C.cyan} h={50} />
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6, marginTop: 10, fontSize: 11 }}>
              <Row label="Spread" value={tickData ? `${tickData.spreadPips.toFixed(1)} pips` : '—'} />
              <Row label="ATR"    value={tickData ? `${tickData.atrPips.toFixed(1)} pips`   : '—'} />
              <Row label="Volume" value={tickData ? String(tickData.tickVolume) : '—'} />
              <Row label="Broker" value={tickData?.broker || '—'} />
            </div>
          </div>
        </Panel>

        <Panel title="LAYER 2 — FEATURE EXTRACTION" badge={isFetching && !tickData ? <LayerBadge label="LOADING…" color={C.cyan} /> : <LayerBadge label="INDICATORS" color={C.teal} />}>
          <div style={{ padding: 14 }}>
            <IndRow label="RSI (14)"   value={tickData?.rsi14?.toFixed(1) ?? '—'} color={tickData && tickData.rsi14 < 30 ? C.green : tickData && tickData.rsi14 > 70 ? C.red : 'var(--text-primary)'} />
            <IndRow label="RSI (7)"    value={tickData?.rsi7?.toFixed(1)  ?? '—'} color={tickData && tickData.rsi7  < 25 ? C.green : tickData && tickData.rsi7  > 75 ? C.red : 'var(--text-primary)'} />
            <IndRow label="Stoch RSI"  value={tickData ? `K:${tickData.stochRsiK?.toFixed(0) ?? '—'} D:${tickData.stochRsiD?.toFixed(0) ?? '—'}` : '—'}
              color={tickData && (tickData.stochRsiK ?? 50) < 20 ? C.green : tickData && (tickData.stochRsiK ?? 50) > 80 ? C.red : 'var(--text-primary)'} />
            <IndRow label="MACD Hist"  value={tickData?.macdHistogram?.toFixed(6) ?? '—'} color={tickData && tickData.macdHistogram > 0 ? C.green : C.red} />
            <IndRow label="MACD L/S"   value={tickData ? `${tickData.macdLine.toFixed(5)} / ${tickData.macdSignal.toFixed(5)}` : '—'} color={tickData && tickData.macdLine > tickData.macdSignal ? C.green : C.red} />
            <IndRow label="EMA 9/21"   value={tickData ? `${tickData.ema9.toFixed(decimals)} / ${tickData.ema21.toFixed(decimals)}` : '—'} color={tickData && tickData.ema9 > tickData.ema21 ? C.green : C.red} />
            <IndRow label="EMA 20/50"  value={tickData ? `${tickData.ema20.toFixed(decimals)} / ${tickData.ema50.toFixed(decimals)}` : '—'} color={tickData && tickData.ema20 > tickData.ema50 ? C.green : C.red} />
            <IndRow label="BB Width"   value={tickData ? (tickData.bbWidth * 10000).toFixed(1) : '—'} />
            <IndRow label="ADX"        value={tickData?.adx?.toFixed(0) ?? '—'} color={tickData && tickData.adx > 25 ? C.green : C.amber} />
            <IndRow label="Buy Press." value={tickData ? `${(tickData.buyPressure * 100).toFixed(0)}%` : '—'}
              color={tickData && tickData.buyPressure > 0.55 ? C.green : tickData && tickData.buyPressure < 0.45 ? C.red : C.amber} />
            <div style={{ marginTop: 8 }}>
              <div style={{ fontSize: 10, color: 'var(--text-muted)', marginBottom: 3, letterSpacing: 1 }}>RSI TREND</div>
              <Sparkline data={rsiHistory} color={C.purple} h={28} />
            </div>
          </div>
        </Panel>
      </div>

      {/* ── Layer 3 + 4 ── */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 12 }}>
        <Panel title="LAYER 3 — AI PREDICTION" badge={<LayerBadge label="DUAL ENGINE" color={C.purple} />}>
          <div style={{ padding: 14, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
            <div style={{ padding: 10, borderRadius: 4, border: '1px solid var(--border)' }}>
              <div style={{ fontSize: 10, color: C.amber, fontWeight: 700, letterSpacing: 1, marginBottom: 4 }}>SIGNAL ENGINE</div>
              <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>
                {aiConn === 'live' ? 'Claude Sonnet 4.6' : aiConn === 'fallback' ? 'Rule-based fallback' : 'Awaiting tick'}
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginTop: 2 }}>
                <span style={{ width: 5, height: 5, borderRadius: '50%', background: aiConn === 'live' ? C.green : aiConn === 'error' ? C.red : C.amber, display: 'inline-block', flexShrink: 0 }} />
                <span className="mono" style={{ fontSize: 9, color: aiConn === 'live' ? C.green : C.amber, letterSpacing: 0.5 }}>
                  {aiConn === 'live' ? 'AI ACTIVE' : aiConn === 'fallback' ? 'RULE-BASED' : connLabel[aiConn]}
                </span>
              </div>
              <div className="mono" style={{ fontSize: 22, fontWeight: 700, marginTop: 8, color: dirColor(signal?.direction) }}>
                {signal?.confidence ?? '—'}<span style={{ fontSize: 11 }}>%</span>
              </div>
            </div>
            <div style={{ padding: 10, borderRadius: 4, border: '1px solid var(--border)' }}>
              <div style={{ fontSize: 10, color: C.cyan, fontWeight: 700, letterSpacing: 1, marginBottom: 4 }}>
                {aiConn === 'live' ? 'CLAUDE API' : 'RULE-BASED'}
              </div>
              <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>{aiConn === 'live' ? 'Claude Sonnet 4.6' : 'Fallback engine'}</div>
              <div className="mono" style={{ fontSize: 10, color: connColor[aiConn], marginTop: 2 }}>{connLabel[aiConn]}</div>
              <div style={{ fontSize: 11, fontWeight: 500, marginTop: 8, color: 'var(--text-secondary)', lineHeight: 1.5 }}>
                {signal?.reasons?.[0] || 'Waiting for next signal cycle...'}
              </div>
            </div>
          </div>
        </Panel>

        <Panel title="LAYER 4 — SIGNAL" badge={
          signal?.direction && signal.direction !== 'HOLD' ? (
            <span style={{ fontSize: 10, fontWeight: 800, letterSpacing: 1, padding: '2px 10px', borderRadius: 3,
              color: dirColor(signal.direction), background: dirBg(signal.direction), border: `1px solid ${dirBorder(signal.direction)}` }}>
              {signal.direction}
            </span>
          ) : <span style={{ fontSize: 10, color: 'var(--text-muted)', letterSpacing: 1 }}>IDLE</span>
        }>
          <div style={{ padding: 14 }}>
            <div style={{ textAlign: 'center', padding: '8px 0' }}>
              <div style={{ fontFamily: 'Rajdhani', fontSize: 42, fontWeight: 900, color: dirColor(signal?.direction), letterSpacing: 2 }}>
                {signal?.direction || '—'}
              </div>
              <StrengthBar value={signal?.confidence ?? 0} color={dirColor(signal?.direction)} />
              <div className="mono" style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 8 }}>
                Confidence: {signal?.confidence ?? 0}% · {activeStrategy}
              </div>
            </div>
            <div style={{ marginTop: 10, borderTop: '1px solid var(--border)', paddingTop: 8 }}>
              {signal?.reasons?.map((r, i) => (
                <div key={i} style={{ fontSize: 11, color: 'var(--text-secondary)', padding: '2px 0' }}>
                  <span style={{ color: 'var(--text-muted)', marginRight: 6 }}>•</span>{r}
                </div>
              ))}
              {signal?.risk_note && (
                <div style={{ fontSize: 10, color: C.amber, marginTop: 6, borderTop: '1px solid var(--border)', paddingTop: 6 }}>
                  {signal.risk_note}
                </div>
              )}
              {!signal?.reasons?.length && <div style={{ fontSize: 11, color: 'var(--text-muted)', textAlign: 'center', padding: 8 }}>Start engine — signal every {SIGNAL_EVERY * TICK_INTERVAL / 1000}s</div>}
            </div>
          </div>
        </Panel>
      </div>

      {/* ── Layer 5: Risk ── */}
      <Panel title="LAYER 5 — RISK MANAGEMENT GATE" badge={
        <LayerBadge label={riskResult?.passed ? 'PASS' : riskResult ? 'BLOCKED' : 'IDLE'}
          color={riskResult?.passed ? C.green : riskResult ? C.red : C.muted} />
      }>
        <div style={{ padding: 14, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {riskResult?.checks?.map((c, i) => <ChecklistItem key={i} label={c.label} pass={c.ok} />)}
          {!riskResult && <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>Risk gate idle — start engine to activate</div>}
          <div style={{ width: '100%', borderTop: '1px solid var(--border)', marginTop: 6, paddingTop: 8, fontSize: 10, color: 'var(--text-muted)', letterSpacing: 0.5 }}>
            {RISK_CFG.maxRiskPct}% max risk · {RISK_CFG.maxDailyLossPct}% daily limit · SL {RISK_CFG.slMult}× ATR · TP {RISK_CFG.tpMult}× ATR · Min confidence {RISK_CFG.minConfidence}%
          </div>
        </div>
      </Panel>

      {/* ── Layer 6: Execution ── */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginTop: 12 }}>
        <Panel title={`LAYER 6 — OPEN TRADES`} badge={<LayerBadge label={mode === 'LIVE' ? 'LIVE' : 'PAPER'} color={mode === 'LIVE' ? C.red : C.amber} />}>
          <div style={{ padding: 14 }}>
            {openTrades.length === 0 ? (
              <div style={{ fontSize: 11, color: 'var(--text-muted)', textAlign: 'center', padding: 20 }}>
                {mode === 'LIVE' ? 'No active positions' : 'No paper trades open'}
              </div>
            ) : openTrades.map(t => (
              <div key={t.id} style={{ padding: 10, borderRadius: 4, border: '1px solid var(--border)', marginBottom: 6 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ fontSize: 10, fontWeight: 800, letterSpacing: 1, padding: '2px 8px', borderRadius: 2,
                      color: dirColor(t.direction), background: dirBg(t.direction), border: `1px solid ${dirBorder(t.direction)}` }}>
                      {t.direction}
                    </span>
                    <span className="mono" style={{ fontSize: 12, fontWeight: 600 }}>{t.pair}</span>
                  </div>
                  <span className="mono" style={{ fontSize: 10, color: 'var(--text-muted)' }}>{t.openTime}</span>
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 4, marginTop: 8, fontSize: 10 }}>
                  <div><span style={{ color: 'var(--text-muted)' }}>Entry: </span><span className="mono"><CopyValue value={t.entry.toFixed(decimals)}>{t.entry.toFixed(decimals)}</CopyValue></span></div>
                  <div><span style={{ color: C.red }}>SL: </span><span className="mono">{t.sl ? <CopyValue value={t.sl.toFixed(decimals)}>{t.sl.toFixed(decimals)}</CopyValue> : '—'}</span></div>
                  <div><span style={{ color: C.green }}>TP: </span><span className="mono">{t.tp ? <CopyValue value={t.tp.toFixed(decimals)}>{t.tp.toFixed(decimals)}</CopyValue> : '—'}</span></div>
                </div>
                {t.mode === 'LIVE' && (
                  <div style={{ marginTop: 6, fontSize: 11, fontWeight: 700, color: t.pnl >= 0 ? C.green : C.red }}>
                    P&L: {t.pnl >= 0 ? '+' : ''}${t.pnl.toFixed(2)}
                  </div>
                )}
              </div>
            ))}
          </div>
        </Panel>

        <Panel title="CLOSED TRADES" badge={<span className="mono" style={{ fontSize: 10, color: 'var(--text-muted)' }}>{closedTrades.length} total</span>}>
          <div style={{ padding: 14, maxHeight: 280, overflowY: 'auto' }}>
            {closedTrades.length === 0 ? (
              <div style={{ fontSize: 11, color: 'var(--text-muted)', textAlign: 'center', padding: 20 }}>No closed trades yet</div>
            ) : closedTrades.map(t => (
              <div key={t.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '6px 0', borderBottom: '1px solid var(--border)' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span style={{ fontSize: 9, fontWeight: 800, padding: '1px 6px', borderRadius: 2, color: dirColor(t.direction), background: dirBg(t.direction) }}>{t.direction}</span>
                  <span className="mono" style={{ fontSize: 11 }}>{t.pair}</span>
                  <span style={{ fontSize: 9, fontWeight: 800, padding: '1px 6px', borderRadius: 2,
                    color: t.result === 'TP' ? C.green : C.red,
                    background: t.result === 'TP' ? 'rgba(0,255,135,0.12)' : 'rgba(255,48,86,0.1)' }}>{t.result}</span>
                  <span style={{ fontSize: 9, color: 'var(--text-muted)' }}>{t.mode}</span>
                </div>
                <span className="mono" style={{ fontSize: 12, fontWeight: 700, color: t.pnl >= 0 ? C.green : C.red }}>
                  {t.pnl >= 0 ? '+' : ''}${t.pnl.toFixed(2)}
                </span>
              </div>
            ))}
          </div>
        </Panel>
      </div>

      {/* ── Feedback loop ── */}
      <div style={{ marginTop: 12 }}>
        <Panel title="FEEDBACK LOOP — ENGINE LOG" badge={<LayerBadge label="LIVE" color={C.purple} />}>
          <div style={{ padding: 14, maxHeight: 200, overflowY: 'auto' }}>
            {logs.length === 0 ? (
              <div style={{ fontSize: 11, color: 'var(--text-muted)', textAlign: 'center', padding: 16 }}>Start the engine to see activity</div>
            ) : logs.map((l, i) => (
              <div key={i} style={{ padding: '3px 0', borderBottom: '1px solid rgba(26,41,64,0.5)', fontSize: 11 }}>
                <span className="mono" style={{ color: 'var(--text-muted)', marginRight: 8, fontSize: 10 }}>{l.time}</span>
                <span style={{ color: l.type === 'trade' ? C.cyan : l.type === 'win' ? C.green : l.type === 'loss' ? C.red : l.type === 'system' ? C.amber : l.type === 'risk' ? C.red : 'var(--text-secondary)' }}>
                  {l.msg}
                </span>
              </div>
            ))}
          </div>
        </Panel>
      </div>
    </div>
  )
}

// ─── Sub-components ─────────────────────────────────────────────────────────

function LayerBadge({ label, color }: { label: string; color: string }) {
  return (
    <span style={{ fontSize: 9, fontWeight: 800, letterSpacing: 1, padding: '2px 8px', borderRadius: 3,
      color, background: color + '18', textTransform: 'uppercase' as const }}>{label}</span>
  )
}

function StatusPill({ label, value, color, tag }: { label: string; value: string; color: string; tag: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '4px 10px', borderRadius: 3, border: '1px solid var(--border)', background: 'var(--bg-panel)' }}>
      <span style={{ fontSize: 9, color: 'var(--text-muted)', letterSpacing: 1.5, fontWeight: 700 }}>{label}</span>
      <span style={{ fontSize: 10, color: 'var(--text-secondary)' }}>{value}</span>
      {tag && <span style={{ fontSize: 9, fontWeight: 800, padding: '1px 6px', borderRadius: 2, color, background: color + '20' }}>{tag}</span>}
    </div>
  )
}

function StatCard({ label, value, sub, color = 'var(--text-primary)' }: { label: string; value: string; sub?: string; color?: string }) {
  return (
    <div className="panel" style={{ padding: '10px 14px' }}>
      <div style={{ fontSize: 10, color: 'var(--text-muted)', letterSpacing: 1.5, marginBottom: 4, fontWeight: 700 }}>{label}</div>
      <div className="mono" style={{ fontSize: 20, fontWeight: 700, color }}>
        {value}
        {sub && <span style={{ fontSize: 11, color: 'var(--text-muted)', fontWeight: 400 }}>{sub}</span>}
      </div>
    </div>
  )
}

function IndRow({ label, value, color = 'var(--text-primary)' }: { label: string; value: string; color?: string }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', padding: '5px 0', borderBottom: '1px solid var(--border)' }}>
      <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{label}</span>
      <span className="mono" style={{ fontSize: 12, fontWeight: 600, color }}>{value}</span>
    </div>
  )
}

function Row({ label, value }: { label: string; value: string }) {
  return <div><span style={{ color: 'var(--text-muted)' }}>{label}: </span><span className="mono" style={{ fontWeight: 600 }}>{value}</span></div>
}

function btnStyle(color: string): React.CSSProperties {
  return { padding: '6px 16px', borderRadius: 3, border: `1px solid ${color}40`, cursor: 'pointer', background: `${color}18`, color, fontSize: 11, fontWeight: 700, fontFamily: 'Rajdhani', letterSpacing: 1 }
}

function pillStyle(active: boolean): React.CSSProperties {
  return { padding: '4px 12px', borderRadius: 3, border: `1px solid ${active ? 'var(--cyan, #00c8ff)' : 'var(--border)'}`, background: active ? 'rgba(0,200,255,0.1)' : 'transparent', color: active ? '#00c8ff' : 'var(--text-muted)', fontSize: 11, fontWeight: 600, cursor: 'pointer', transition: 'all 0.15s' }
}

const tagStyle: React.CSSProperties = { fontSize: 10, color: 'var(--text-muted)', letterSpacing: 1.5, fontWeight: 700, alignSelf: 'center' }
