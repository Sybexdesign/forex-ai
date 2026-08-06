'use client'
// components/pages/ScalperPage.tsx — ForexAI Scalper Phase 2 (Real Infrastructure)

import { useState, useEffect, useCallback, useRef } from 'react'
import { Panel, ChecklistItem, LiveDot, StrengthBar, CopyValue } from '../ui'
import { authJson } from '@/lib/api'
import type { PriceData } from '@/hooks/useForex'
import type { StrategySettings } from '@/lib/supabase'
import { currencySymbol, currencySigned } from '@/lib/currency'


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
  entry: number; sl: number; tp: number
  tp1?: number; tp2?: number; tp3?: number
  slDist?: number  // price distance used for trailing calc
  risk_note?: string; fallback?: boolean
  strategy: string; timestamp: number; expiresAt?: number
}

interface MlData {
  win_probability: number
  should_trade: boolean
  ml_confidence: number
  feature_contributions: Record<string, { importance: number; value: number }>
}

interface RiskCheck {
  passed: boolean
  checks: { label: string; ok: boolean }[]
}

interface ScalperTrade {
  id: string; pair: string; direction: TradeDirection
  entry: number; sl: number; tp: number
  tp1?: number; tp2?: number; tp3?: number
  slDist?: number  // original SL distance, used for trailing
  partialsClosed?: 0 | 1 | 2  // 0=none, 1=TP1 hit, 2=TP2 hit
  confidence: number; strategy: string; openTime: string
  closeTime?: string; closePrice?: number; pnl: number
  result?: 'TP1' | 'TP2' | 'TP3' | 'SL' | 'REV'; mode: Mode
}

interface LogEntry {
  msg: string; type: 'info' | 'trade' | 'win' | 'loss' | 'system' | 'risk'; time: string
}

interface LayerCheck { name: string; confirmed: boolean; note: string }

interface WorkerStatus {
  worker_status: string; last_trained?: string; model_auc?: number
  model_accuracy?: number; dataset_size?: number; model_version?: number
  data_freshness?: string; rows_added?: number; top_features?: string[]
}

interface DailySignal {
  pair: string; direction: TradeDirection; confidence: number; upProbability: number
  entry: number | null; sl: number | null
  tp1: number | null; tp2: number | null; tp3: number | null
  atr: number | null; atrPips: number | null
  slPips: number | null; tp1Pips: number | null; tp2Pips: number | null; tp3Pips: number | null
  featureDate: string
  featureContributions: Record<string, { importance: number; value: number }>
  layers: LayerCheck[]; confirmedLayers: number; totalLayers: number
  workerStatus: WorkerStatus | null; mlOnline: boolean; timestamp: number
}

interface DailyHistoryItem {
  id: string; pair: string; direction: TradeDirection; confidence: number
  entry: number | null; sl: number | null; tp1: number | null
  timestamp: number
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
const TICK_INTERVAL   = 10_000
const SIGNAL_EVERY    = 3          // signal cadence when a trade is open
const DAILY_INTERVAL  = 60_000
const ATR_HISTORY_LEN = 100        // ATR readings kept for volatility percentile

const TIMEFRAME_MS: Record<string, number> = {
  '1m': 60_000, '3m': 180_000, '5m': 300_000, '15m': 900_000,
}

const REVERSAL_CONF_BONUS = 15     // confidence above dynamic threshold required to reverse

const C = {
  green: '#00ff87', greenDim: 'rgba(0,255,135,0.12)', greenBorder: 'rgba(0,255,135,0.3)',
  red: '#ff3056', redDim: 'rgba(255,48,86,0.1)', redBorder: 'rgba(255,48,86,0.25)',
  amber: '#ffb800', amberDim: 'rgba(255,184,0,0.08)', amberBorder: 'rgba(255,184,0,0.25)',
  blue: '#0080ff', cyan: '#00c8ff', purple: '#a855f7', teal: '#14b8a6',
  muted: 'var(--text-muted)',
}

function dp(pair: string) { return pair.includes('JPY') ? 3 : pair.startsWith('XA') ? 2 : 5 }
function pipSize(pair: string) { return pair.includes('JPY') ? 0.01 : pair.startsWith('XAU') ? 0.1 : pair.startsWith('XAG') ? 0.01 : 0.0001 }

// Max SL price-distance cap to prevent ATR spikes blowing risk limits
function maxSlDist(pair: string): number {
  if (pair.startsWith('XAU')) return 80 * 0.1
  if (pair.startsWith('XAG')) return 60 * 0.01
  if (pair.includes('JPY'))   return 50 * 0.01
  return 40 * 0.0001
}

// Classify ATR percentile rank against rolling history
function calcVolatilityRegime(atr: number, history: number[]): 'LOW' | 'MEDIUM' | 'HIGH' {
  if (history.length < 5) return 'MEDIUM'
  const sorted = [...history].sort((a, b) => a - b)
  const rank   = sorted.filter(v => v <= atr).length / sorted.length
  return rank < 0.33 ? 'LOW' : rank < 0.67 ? 'MEDIUM' : 'HIGH'
}

// SL multiplier driven entirely by current volatility regime
function slMultiplier(regime: 'LOW' | 'MEDIUM' | 'HIGH'): number {
  return regime === 'LOW' ? 1.2 : regime === 'MEDIUM' ? 1.5 : 2.0
}

// Dynamic RR ratios: TP2 scales with confidence, TP3 extends further
function rrRatios(confidence: number): [number, number, number] {
  const rr1 = 1.0
  const rr2 = Math.max(1.2, 1 + (confidence / 100 - 0.5) * 4)
  const rr3 = Math.max(rr2 * 1.5, 3.0)
  return [rr1, rr2, rr3]
}

// Compute all levels from live ATR + volatility regime + confidence
interface DynamicLevels { sl: number; tp: number; tp1: number; tp2: number; tp3: number; slDist: number }
function calcDynamicLevels(
  direction: TradeDirection, entry: number, atr: number,
  confidence: number, pair: string, regime: 'LOW' | 'MEDIUM' | 'HIGH',
): DynamicLevels {
  const slDist  = Math.min(atr * slMultiplier(regime), maxSlDist(pair))
  const [r1, r2, r3] = rrRatios(confidence)
  const sign = direction === 'BUY' ? 1 : -1
  return {
    slDist,
    sl:  entry - sign * slDist,
    tp1: entry + sign * slDist * r1,
    tp2: entry + sign * slDist * r2,
    tp3: entry + sign * slDist * r3,
    tp:  entry + sign * slDist * r3,  // tp = TP3 (full target)
  }
}

// Dynamic min confidence from rolling win rate
function dynamicMinConf(wins: number, total: number): number {
  if (total < 5) return 60
  const wr = wins / total
  if (wr > 0.60) return 55
  if (wr < 0.35) return 80
  if (wr < 0.45) return 70
  return 60
}

// ─── Risk gate ────────────────────────────────────────────────────────────────

const RISK_CFG = { maxRiskPct: 1, maxDailyLossPct: 3, maxOpenTrades: 3 }

function checkRisk(sig: Signal | null, balance: number, dailyPnL: number, openCount: number, minConf: number, currency: string = 'USD'): RiskCheck {
  const checks: { label: string; ok: boolean }[] = []
  let passed = true

  const riskAmt = balance * RISK_CFG.maxRiskPct / 100
  const riskOk  = balance > 0
  if (!riskOk) passed = false
  checks.push({ label: `Risk ≤ ${RISK_CFG.maxRiskPct}% (${currencySymbol(currency)}${riskAmt.toFixed(0)})`, ok: riskOk })


  const limit = balance * RISK_CFG.maxDailyLossPct / 100
  if (dailyPnL < -limit) { checks.push({ label: 'Daily loss limit hit', ok: false }); passed = false }
  else checks.push({ label: `Daily P&L: ${currencySymbol(currency)}${dailyPnL.toFixed(2)}`, ok: true })


  if (openCount >= RISK_CFG.maxOpenTrades) { checks.push({ label: `Max ${RISK_CFG.maxOpenTrades} trades reached`, ok: false }); passed = false }
  else checks.push({ label: `${openCount}/${RISK_CFG.maxOpenTrades} open`, ok: true })

  if (!sig || sig.direction === 'HOLD') { checks.push({ label: 'No signal (HOLD)', ok: false }); passed = false }
  else if (sig.confidence < minConf) {
    checks.push({ label: `Confidence ${sig.confidence}% < ${minConf}% (dynamic)`, ok: false }); passed = false
  } else checks.push({ label: `Confidence ${sig.confidence}% ≥ ${minConf}%`, ok: true })

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
  const [mlData, setMlData]           = useState<MlData | null>(null)
  const [riskResult, setRiskResult]   = useState<RiskCheck | null>(null)
  const [brokerConn, setBrokerConn]   = useState<ConnStatus>('idle')
  const [aiConn, setAiConn]           = useState<ConnStatus>('idle')

  const [dailySignal, setDailySignal]         = useState<DailySignal | null>(null)
  const [dailySignalLoading, setDailyLoading] = useState(false)
  const [dailyHistory, setDailyHistory]       = useState<DailyHistoryItem[]>([])
  const [retraining, setRetraining]           = useState(false)
  const dailyIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const [priceHistory, setPriceHistory]         = useState<number[]>([])
  const [rsiHistory, setRsiHistory]             = useState<number[]>([])
  const [atrHistory, setAtrHistory]             = useState<number[]>([])
  const [volatilityRegime, setVolatilityRegime] = useState<'LOW'|'MEDIUM'|'HIGH'>('MEDIUM')

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
  const signalRef          = useRef<Signal | null>(null)
  const balanceRef         = useRef(balance)
  const dailyPnLRef        = useRef(dailyPnL)
  const openTradesRef      = useRef<ScalperTrade[]>([])
  const modeRef            = useRef<Mode>('PAPER')
  const pairRef            = useRef(pair)
  const strategyRef        = useRef(activeStrategy)
  const decimalsRef        = useRef(dp(pair))
  const atrHistoryRef      = useRef<number[]>([])
  const volatilityRef      = useRef<'LOW'|'MEDIUM'|'HIGH'>('MEDIUM')
  const winCountRef        = useRef(winCount)
  const tradeCountRef      = useRef(tradeCount)

  useEffect(() => { signalRef.current     = signal },      [signal])
  useEffect(() => { balanceRef.current    = balance },     [balance])
  useEffect(() => { dailyPnLRef.current   = dailyPnL },   [dailyPnL])
  useEffect(() => { openTradesRef.current = openTrades },  [openTrades])
  useEffect(() => { modeRef.current       = mode },        [mode])
  useEffect(() => { pairRef.current       = pair; decimalsRef.current = dp(pair) }, [pair])
  useEffect(() => { strategyRef.current   = activeStrategy },            [activeStrategy])
  useEffect(() => { atrHistoryRef.current = atrHistory },  [atrHistory])
  useEffect(() => { volatilityRef.current = volatilityRegime }, [volatilityRegime])
  useEffect(() => { winCountRef.current   = winCount },    [winCount])
  useEffect(() => { tradeCountRef.current = tradeCount },  [tradeCount])
  const timeframeRef = useRef(timeframe)
  useEffect(() => { timeframeRef.current  = timeframe },   [timeframe])

  const decimals = dp(pair)

  const addLog = useCallback((msg: string, type: LogEntry['type'] = 'info') => {
    setLogs(prev => [{ msg, type, time: new Date().toLocaleTimeString('en', { hour12: false }) }, ...prev].slice(0, 80))
  }, [])

  const fetchDailySignal = useCallback(async (currentPair: string) => {
    setDailyLoading(true)
    try {
      const data: DailySignal = await authJson(`/api/scalper/daily-signal?pair=${encodeURIComponent(currentPair)}&timeframe=1H`)
      setDailySignal(data)
      if (data.direction !== 'HOLD' && data.confidence >= 60) {
        setDailyHistory(prev => {
          const existing = prev.find(h => h.id === String(data.timestamp))
          if (existing) return prev
          const item: DailyHistoryItem = {
            id: String(data.timestamp), pair: currentPair,
            direction: data.direction, confidence: data.confidence,
            entry: data.entry, sl: data.sl, tp1: data.tp1,
            timestamp: data.timestamp,
          }
          return [item, ...prev].slice(0, 20)
        })
      }
    } catch { /* non-critical */ }
    finally { setDailyLoading(false) }
  }, [])

  // Poll daily signal every 60s, also on pair change
  useEffect(() => {
    fetchDailySignal(pair)
    if (dailyIntervalRef.current) clearInterval(dailyIntervalRef.current)
    dailyIntervalRef.current = setInterval(() => fetchDailySignal(pair), DAILY_INTERVAL)
    return () => { if (dailyIntervalRef.current) clearInterval(dailyIntervalRef.current) }
  }, [pair, fetchDailySignal])

  const triggerRetrain = useCallback(async () => {
    setRetraining(true)
    try {
      await authJson('/api/scalper/retrain', { method: 'POST' })
      addLog('Daily model retrain triggered', 'system')
    } catch { addLog('Retrain request failed', 'risk') }
    finally { setTimeout(() => setRetraining(false), 3000) }
  }, [addLog])

  useEffect(() => { if (account?.balance)     setBalance(account.balance) },     [account?.balance])
  // In LIVE mode, sync daily P&L from broker's realizedPL (OANDA's session P&L)
  useEffect(() => {
    if (mode === 'LIVE' && account?.realizedPL !== undefined) setDailyPnL(account.realizedPL)
  }, [mode, account?.realizedPL])

  // ── Reset on pair change ──────────────────────────────────────────────────
  useEffect(() => {
    setTickData(null); setSignal(null); setRiskResult(null)
    setPriceHistory([]); setRsiHistory([]); setAtrHistory([]); setVolatilityRegime('MEDIUM')
    atrHistoryRef.current = []; volatilityRef.current = 'MEDIUM'
    setOpenTrades([]); setBrokerConn('idle'); setAiConn('idle')
    tickCountRef.current = 0; setTickCount(0); setIsFetching(false)
    addLog(`Switched to ${pair}`, 'system')
  }, [pair]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Monitor paper trades — multi-TP partial close + trailing stop ─────────
  const monitorTrades = useCallback((price: number) => {
    const pnlPerPriceUnit = pair.startsWith('XAU') ? 100 : pair.includes('JPY') ? 1000 : 100000
    const logTime = () => new Date().toLocaleTimeString('en', { hour12: false })

    setOpenTrades(prev => {
      const stillOpen: ScalperTrade[] = []
      const nowClosed: ScalperTrade[] = []

      prev.forEach(t => {
        const isBuy = t.direction === 'BUY'

        // SL hit (hard close — all remaining units)
        if ((isBuy && price <= t.sl) || (!isBuy && price >= t.sl)) {
          const rawPnl = (isBuy ? price - t.entry : t.entry - price) * pnlPerPriceUnit
          const partial = t.partialsClosed ?? 0
          const portion = partial === 0 ? 1 : partial === 1 ? 0.67 : 0.34
          const pnlUsd  = rawPnl * portion
          const closed  = { ...t, closePrice: price, closeTime: logTime(), pnl: pnlUsd, result: 'SL' as const }
          nowClosed.push(closed)
          addLog(`SL hit ${t.pair} ${t.direction} @ ${price} | P&L: ${currencySymbol(account?.currency)}${pnlUsd.toFixed(2)}`, pnlUsd >= 0 ? 'win' : 'loss')

          setDailyPnL(d => d + pnlUsd); setTradeCount(c => c + 1)
          if (pnlUsd > 0) setWinCount(w => w + 1)
          setBalance(b => b + pnlUsd)
          return
        }

        // TP3 (full close of remaining 34%)
        if (t.tp3 !== undefined && ((isBuy && price >= t.tp3) || (!isBuy && price <= t.tp3))) {
          const rawPnl = (isBuy ? t.tp3 - t.entry : t.entry - t.tp3) * pnlPerPriceUnit * 0.34
          nowClosed.push({ ...t, closePrice: t.tp3, closeTime: logTime(), pnl: rawPnl, result: 'TP3' as const })
          addLog(`TP3 ${t.pair} ${t.direction} | P&L: ${currencySymbol(account?.currency)}${rawPnl.toFixed(2)}`, 'win')

          setDailyPnL(d => d + rawPnl); setTradeCount(c => c + 1); setWinCount(w => w + 1); setBalance(b => b + rawPnl)
          return
        }

        // TP2 hit (partial — close 33%, trail SL to TP1)
        if (t.tp2 !== undefined && (t.partialsClosed ?? 0) < 2 && (t.partialsClosed ?? 0) >= 1
          && ((isBuy && price >= t.tp2) || (!isBuy && price <= t.tp2))) {
          const rawPnl = (isBuy ? t.tp2 - t.entry : t.entry - t.tp2) * pnlPerPriceUnit * 0.33
          addLog(`TP2 partial ${t.pair} | +${currencySymbol(account?.currency)}${rawPnl.toFixed(2)} — trailing SL to TP1`, 'win')

          setDailyPnL(d => d + rawPnl); setBalance(b => b + rawPnl)
          const newSl = t.tp1 ?? t.entry  // trail SL to TP1 level
          stillOpen.push({ ...t, partialsClosed: 2, sl: newSl })
          return
        }

        // TP1 hit (partial — close 33%, move SL to breakeven)
        if (t.tp1 !== undefined && (t.partialsClosed ?? 0) < 1
          && ((isBuy && price >= t.tp1) || (!isBuy && price <= t.tp1))) {
          const rawPnl = (isBuy ? t.tp1 - t.entry : t.entry - t.tp1) * pnlPerPriceUnit * 0.33
          addLog(`TP1 partial ${t.pair} | +${currencySymbol(account?.currency)}${rawPnl.toFixed(2)} — SL moved to breakeven`, 'win')

          setDailyPnL(d => d + rawPnl); setBalance(b => b + rawPnl)
          stillOpen.push({ ...t, partialsClosed: 1, sl: t.entry })
          return
        }

        stillOpen.push(t)
      })

      if (nowClosed.length) setClosedTrades(p => [...nowClosed, ...p].slice(0, 50))
      return stillOpen
    })
  }, [pair, addLog])

  // ── Fetch signal — dynamic levels, expiry, instant reversal ─────────────
  const fetchSignal = useCallback(async (tick: TickData) => {
    const currentPair     = pairRef.current
    const currentStrategy = strategyRef.current
    const currentDecimals = decimalsRef.current
    const currentTF       = timeframeRef.current
    const regime          = volatilityRef.current
    const minConf         = dynamicMinConf(winCountRef.current, tradeCountRef.current)

    try {
      const data = await authJson<any>('/api/scalper/signal', {
        method: 'POST',
        body: JSON.stringify({ ...tick, pair: currentPair, strategy: currentStrategy, userId }),
      })

      if (data.direction === 'HOLD' || !data.entry) {
        const holdSig: Signal = {
          direction: 'HOLD', confidence: data.confidence ?? 0, reasons: data.reasons || [],
          entry: tick.price, sl: 0, tp: 0, risk_note: data.risk_note,
          fallback: data.fallback, strategy: currentStrategy, timestamp: Date.now(),
        }
        setSignal(holdSig); signalRef.current = holdSig
        if (data.ml) setMlData(data.ml)
        setAiConn(data.fallback ? 'fallback' : 'live')
        setRiskResult(checkRisk(holdSig, balanceRef.current, dailyPnLRef.current, openTradesRef.current.length, minConf, account?.currency))

        return
      }

      // Apply dynamic levels on top of API signal (overrides server-computed SL/TP)
      const levels = calcDynamicLevels(data.direction, data.entry, tick.atr, data.confidence, currentPair, regime)
      const expiresAt = Date.now() + (TIMEFRAME_MS[currentTF] ?? TIMEFRAME_MS['5m'])

      const sig: Signal = {
        direction:  data.direction,
        confidence: data.confidence,
        reasons:    data.reasons || [],
        entry:      data.entry,
        ...levels,
        risk_note:  data.risk_note,
        fallback:   data.fallback,
        strategy:   currentStrategy,
        timestamp:  Date.now(),
        expiresAt,
      }
      setSignal(sig)
      signalRef.current = sig
      if (data.ml) setMlData(data.ml)
      setAiConn(data.fallback ? 'fallback' : 'live')

      const freshRisk = checkRisk(sig, balanceRef.current, dailyPnLRef.current, openTradesRef.current.length, minConf, account?.currency)

      setRiskResult(freshRisk)

      // ── Instant reversal: opposite direction with sufficient confidence ───
      const opposites = openTradesRef.current.filter(
        t => t.mode === 'PAPER' && t.direction !== sig.direction && t.pair === currentPair
      )
      if (opposites.length > 0 && sig.confidence >= minConf + REVERSAL_CONF_BONUS) {
        const pnlPerUnit = currentPair.startsWith('XAU') ? 100 : currentPair.includes('JPY') ? 1000 : 100000
        setOpenTrades(prev => {
          const reversed: ScalperTrade[] = []
          prev.forEach(t => {
            if (t.mode === 'PAPER' && t.direction !== sig.direction && t.pair === currentPair) {
              const rawPnl = (t.direction === 'BUY' ? tick.price - t.entry : t.entry - tick.price) * pnlPerUnit
              setDailyPnL(d => d + rawPnl); setBalance(b => b + rawPnl)
              setClosedTrades(p => [{
                ...t, closePrice: tick.price,
                closeTime: new Date().toLocaleTimeString('en', { hour12: false }),
                pnl: rawPnl, result: 'REV' as const,
              }, ...p].slice(0, 50))
              addLog(`[REV] Closed ${t.direction} → reversed to ${sig.direction} @ ${tick.price.toFixed(currentDecimals)} (conf ${sig.confidence}%)`, 'trade')
            } else {
              reversed.push(t)
            }
          })
          return reversed
        })
      }

      // ── Open new trade if risk gate passes (no existing same-direction trade) ─
      const alreadyOpen = openTradesRef.current.some(t => t.direction === sig.direction && t.pair === currentPair)
      if (!alreadyOpen && freshRisk.passed) {
        if (modeRef.current === 'PAPER') {
          const trade: ScalperTrade = {
            id: Date.now().toString(), pair: currentPair, direction: sig.direction,
            entry: sig.entry, sl: sig.sl, tp: sig.tp,
            tp1: sig.tp1, tp2: sig.tp2, tp3: sig.tp3, slDist: sig.slDist,
            partialsClosed: 0,
            confidence: sig.confidence, strategy: currentStrategy,
            openTime: new Date().toLocaleTimeString('en', { hour12: false }),
            pnl: 0, mode: 'PAPER',
          }
          setOpenTrades(prev => {
            if (prev.length < RISK_CFG.maxOpenTrades) {
              addLog(
                `[PAPER] ${sig.direction} ${currentPair} @ ${sig.entry.toFixed(currentDecimals)} | ` +
                `SL ${sig.sl.toFixed(currentDecimals)} TP1 ${sig.tp1?.toFixed(currentDecimals)} | ${sig.confidence}% [${regime}]`,
                'trade',
              )
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
                tp1: sig.tp1, tp2: sig.tp2, tp3: sig.tp3, slDist: sig.slDist,
                partialsClosed: 0,
                confidence: sig.confidence, strategy: currentStrategy,
                openTime: new Date().toLocaleTimeString('en', { hour12: false }),
                pnl: 0, mode: 'LIVE',
              }
              setOpenTrades(prev => prev.length < RISK_CFG.maxOpenTrades ? [...prev, liveTrade] : prev)
              onRefreshAccount?.(); onRefreshTrades?.()
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

      // Update rolling ATR history and derive volatility regime
      const newAtrHistory = [...atrHistoryRef.current, data.atr].slice(-ATR_HISTORY_LEN)
      setAtrHistory(newAtrHistory)
      atrHistoryRef.current = newAtrHistory
      const regime = calcVolatilityRegime(data.atr, newAtrHistory)
      setVolatilityRegime(regime)
      volatilityRef.current = regime

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
                addLog(`[LIVE] Position closed: ${pt.pair} ${pt.direction} | P&L: ${currencySymbol(account?.currency)}${pt.pnl.toFixed(2)}`, pt.pnl >= 0 ? 'win' : 'loss')

                setClosedTrades(p => [{
                  ...pt,
                  closeTime: new Date().toLocaleTimeString('en', { hour12: false }),
                  closePrice: data.price,
                  result: (pt.pnl >= 0 ? 'TP3' : 'SL') as 'TP3' | 'SL',
                }, ...p].slice(0, 50))
                setTradeCount(c => c + 1)
                if (pt.pnl > 0) setWinCount(w => w + 1)
              }
            })
            setOpenTrades(liveTrades)
          }
        } catch { /* non-critical */ }
      }

      // Always-scan: fetch signal every tick when no trades open; every SIGNAL_EVERY ticks otherwise
      // Also re-scan immediately if the current signal has expired
      const sigExpired = signalRef.current?.expiresAt ? Date.now() > signalRef.current.expiresAt : false
      const shouldFetch = openTradesRef.current.length === 0
        || sigExpired
        || tickCountRef.current % SIGNAL_EVERY === 0

      if (shouldFetch) {
        if (sigExpired && signalRef.current?.direction !== 'HOLD') {
          setSignal(null); signalRef.current = null
          addLog('Signal expired — re-scanning', 'system')
        }
        await fetchSignal(data)
      } else {
        const minConf = dynamicMinConf(winCountRef.current, tradeCountRef.current)
        const risk = checkRisk(signalRef.current, balanceRef.current, dailyPnLRef.current, openTradesRef.current.length, minConf, account?.currency)

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
              Trades are executed automatically when signal confidence ≥ dynamic threshold ({dynamicMinConf(winCount, tradeCount)}% now) and all risk checks pass.
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
        {dailySignal?.workerStatus && (
          <StatusPill
            label="DAILY ML"
            value={dailySignal.workerStatus.data_freshness ?? 'unknown'}
            color={dailySignal.mlOnline ? C.purple : C.muted}
            tag={`AUC ${dailySignal.workerStatus.model_auc?.toFixed(3) ?? '—'}`}
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
        <StatCard label="BALANCE" value={`${currencySymbol(account?.currency)}${balance.toFixed(2)}`} />
        <StatCard label="DAILY P&L" value={currencySigned(dailyPnL, account?.currency)} color={dailyPnL >= 0 ? C.green : C.red} />

        <StatCard label="WIN RATE" value={`${winRate}%`} sub={`${winCount}/${tradeCount}`} color={winRate >= 55 ? C.green : winRate >= 45 ? C.amber : C.red} />
        <StatCard label="OPEN TRADES" value={`${openTrades.length}`} sub={`/${RISK_CFG.maxOpenTrades}`} />
      </div>

      {/* ── Layer 1 + 2 ── */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 12 }}>
        <Panel title="LAYER 1 — MARKET DATA" badge={
          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <LayerBadge label="REAL FEED" color={C.blue} />
            <LayerBadge
              label={`${volatilityRegime} VOL`}
              color={volatilityRegime === 'LOW' ? C.teal : volatilityRegime === 'MEDIUM' ? C.amber : C.red}
            />
          </div>
        }>
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
              <Row label="Vol. regime" value={atrHistory.length >= 5 ? `${volatilityRegime} (p${Math.round(atrHistory.filter(v => v <= (tickData?.atr ?? 0)).length / atrHistory.length * 100)}%)` : 'Calibrating…'} />
              <Row label="SL mult" value={`${slMultiplier(volatilityRegime).toFixed(1)}× ATR`} />
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
        <Panel title="LAYER 3 — AI PREDICTION" badge={<LayerBadge label="TRIPLE ENGINE" color={C.purple} />}>
          <div style={{ padding: 14, display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10 }}>
            {/* Signal Engine */}
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
            {/* Scalper ML Model */}
            <div style={{ padding: 10, borderRadius: 4, border: `1px solid ${mlData ? (mlData.should_trade ? 'rgba(0,255,135,0.3)' : 'rgba(255,48,86,0.25)') : 'var(--border)'}` }}>
              <div style={{ fontSize: 10, color: C.cyan, fontWeight: 700, letterSpacing: 1, marginBottom: 4 }}>ML MODEL</div>
              <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>XGBoost · Win Prob</div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginTop: 2 }}>
                <span style={{ width: 5, height: 5, borderRadius: '50%', background: mlData ? C.green : 'var(--text-muted)', display: 'inline-block', flexShrink: 0 }} />
                <span className="mono" style={{ fontSize: 9, color: mlData ? C.green : 'var(--text-muted)', letterSpacing: 0.5 }}>
                  {mlData ? 'ACTIVE' : 'OFFLINE'}
                </span>
              </div>
              {mlData ? (
                <>
                  <div className="mono" style={{ fontSize: 22, fontWeight: 700, marginTop: 8, color: mlData.should_trade ? C.green : C.red }}>
                    {mlData.ml_confidence}<span style={{ fontSize: 11 }}>%</span>
                  </div>
                  <div style={{ fontSize: 10, color: mlData.should_trade ? C.green : C.red, fontWeight: 700, marginTop: 2 }}>
                    {mlData.should_trade ? '▲ TRADE' : '✗ SKIP'}
                  </div>
                  <div style={{ height: 3, background: 'var(--border)', borderRadius: 2, marginTop: 6 }}>
                    <div style={{ width: `${mlData.ml_confidence}%`, height: '100%', background: mlData.should_trade ? C.green : C.red, borderRadius: 2, transition: 'width 0.5s ease' }} />
                  </div>
                </>
              ) : (
                <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 8, lineHeight: 1.5 }}>
                  ML service offline<br />run ml/serve.py
                </div>
              )}
            </div>
            {/* Daily Direction Model */}
            <div style={{ padding: 10, borderRadius: 4, border: `1px solid ${dailySignal ? (dailySignal.confidence >= 60 ? dirBorder(dailySignal.direction) : 'rgba(168,85,247,0.3)') : 'var(--border)'}` }}>
              <div style={{ fontSize: 10, color: C.purple, fontWeight: 700, letterSpacing: 1, marginBottom: 4 }}>DAILY DIRECTION</div>
              <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>XGBoost · 26y OHLCV</div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginTop: 2 }}>
                <span style={{ width: 5, height: 5, borderRadius: '50%', background: dailySignal?.mlOnline ? C.green : 'var(--text-muted)', display: 'inline-block', flexShrink: 0 }} />
                <span className="mono" style={{ fontSize: 9, color: dailySignal?.mlOnline ? C.green : 'var(--text-muted)', letterSpacing: 0.5 }}>
                  {dailySignalLoading ? 'LOADING…' : dailySignal?.mlOnline ? 'ACTIVE' : 'OFFLINE'}
                </span>
              </div>
              {dailySignal ? (
                <>
                  <div className="mono" style={{ fontSize: 22, fontWeight: 700, marginTop: 8, color: dailySignal.confidence >= 60 ? dirColor(dailySignal.direction) : C.amber }}>
                    {dailySignal.confidence}<span style={{ fontSize: 11 }}>%</span>
                  </div>
                  <div style={{ fontSize: 10, fontWeight: 700, marginTop: 2, color: dailySignal.confidence >= 60 ? dirColor(dailySignal.direction) : C.amber }}>
                    {dailySignal.confidence >= 60 ? dailySignal.direction : 'UNCERTAIN'}
                  </div>
                  <div style={{ fontSize: 9, color: 'var(--text-muted)', marginTop: 4 }}>
                    {dailySignal.featureDate}
                  </div>
                  <div style={{ height: 3, background: 'var(--border)', borderRadius: 2, marginTop: 5 }}>
                    <div style={{ width: `${dailySignal.confidence}%`, height: '100%', background: dailySignal.confidence >= 60 ? dirColor(dailySignal.direction) : C.amber, borderRadius: 2, transition: 'width 0.5s ease' }} />
                  </div>
                </>
              ) : (
                <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 8, lineHeight: 1.5 }}>
                  {dailySignalLoading ? 'Fetching…' : 'No data — run worker_daily.py'}
                </div>
              )}
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
            {/* TP1/TP2/TP3 levels */}
            {signal && signal.direction !== 'HOLD' && signal.tp1 && (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 4, margin: '8px 0', fontSize: 10 }}>
                {[
                  { label: 'SL',  val: signal.sl,  color: C.red },
                  { label: 'TP1', val: signal.tp1, color: C.green },
                  { label: 'TP2', val: signal.tp2, color: C.green },
                  { label: 'TP3', val: signal.tp3, color: C.teal },
                ].map(({ label, val, color }) => val !== undefined && (
                  <div key={label} style={{ textAlign: 'center', padding: '4px 2px', borderRadius: 2, background: color + '14', border: `1px solid ${color}30` }}>
                    <div style={{ color, fontWeight: 700 }}>{label}</div>
                    <div className="mono" style={{ color, fontSize: 9 }}>
                      <CopyValue value={val!.toFixed(decimals)}>{val!.toFixed(decimals)}</CopyValue>
                    </div>
                  </div>
                ))}
              </div>
            )}
            {/* Expiry countdown */}
            {signal?.expiresAt && signal.direction !== 'HOLD' && (
              <div style={{ fontSize: 9, color: Date.now() > signal.expiresAt - 15000 ? C.red : C.amber, textAlign: 'center', marginBottom: 4 }}>
                {Date.now() > signal.expiresAt ? '⚡ Expired — re-scanning' : `⏱ Expires in ~${Math.max(0, Math.round((signal.expiresAt - Date.now()) / 1000))}s`}
              </div>
            )}
            <div style={{ marginTop: 6, borderTop: '1px solid var(--border)', paddingTop: 8 }}>
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
              {!signal?.reasons?.length && (
                <div style={{ fontSize: 11, color: 'var(--text-muted)', textAlign: 'center', padding: 8 }}>
                  Always-on — signals every tick (no trade) or every {SIGNAL_EVERY * TICK_INTERVAL / 1000}s
                </div>
              )}
            </div>
          </div>
        </Panel>
      </div>

      {/* ── Daily Signal Card ── */}
      {dailySignal && dailySignal.confidence >= 60 && dailySignal.direction !== 'HOLD' && (
        <div style={{ marginBottom: 12 }}>
          <div style={{ fontSize: 10, color: C.purple, fontWeight: 700, letterSpacing: 2, marginBottom: 6, textTransform: 'uppercase' }}>
            ◆ DAILY ML SIGNAL — {pair}
          </div>
          <div style={{ borderRadius: 6, border: `1px solid ${dirBorder(dailySignal.direction)}`, background: dirBg(dailySignal.direction), padding: 16 }}>
            {/* Header row */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 14 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <div style={{ fontFamily: 'Rajdhani', fontSize: 36, fontWeight: 900, color: dirColor(dailySignal.direction), letterSpacing: 2 }}>
                  {dailySignal.direction}
                </div>
                <div>
                  <div className="mono" style={{ fontSize: 20, fontWeight: 700, color: dirColor(dailySignal.direction) }}>
                    {dailySignal.confidence}%
                  </div>
                  <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>
                    {dailySignal.confirmedLayers}/{dailySignal.totalLayers} layers confirmed
                  </div>
                </div>
              </div>
              <div style={{ textAlign: 'right' }}>
                <div style={{ fontSize: 10, color: 'var(--text-muted)', marginBottom: 2 }}>Feature date</div>
                <div className="mono" style={{ fontSize: 11 }}>{dailySignal.featureDate}</div>
                <div style={{ fontSize: 9, color: C.purple, marginTop: 3 }}>XGBoost · 26y daily OHLCV</div>
              </div>
            </div>

            {/* Price levels */}
            {dailySignal.entry && (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 8, marginBottom: 14 }}>
                <PriceLevel label="ENTRY" value={dailySignal.entry?.toFixed(dp(pair)) ?? '—'} color="var(--text-primary)" pips={null} />
                <PriceLevel label="SL" value={dailySignal.sl?.toFixed(dp(pair)) ?? '—'} color={C.red} pips={dailySignal.slPips} />
                <PriceLevel label="TP1" value={dailySignal.tp1?.toFixed(dp(pair)) ?? '—'} color={C.green} pips={dailySignal.tp1Pips} />
                <PriceLevel label="TP2" value={dailySignal.tp2?.toFixed(dp(pair)) ?? '—'} color={C.green} pips={dailySignal.tp2Pips} />
                <PriceLevel label="TP3" value={dailySignal.tp3?.toFixed(dp(pair)) ?? '—'} color={C.teal} pips={dailySignal.tp3Pips} />
              </div>
            )}

            {/* Layer confirmations */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 6, marginBottom: 14 }}>
              {dailySignal.layers.map((l, i) => (
                <div key={i} style={{ display: 'flex', alignItems: 'flex-start', gap: 6, padding: '6px 8px', borderRadius: 3, background: l.confirmed ? 'rgba(0,255,135,0.06)' : 'rgba(255,48,86,0.06)', border: `1px solid ${l.confirmed ? 'rgba(0,255,135,0.15)' : 'rgba(255,48,86,0.15)'}` }}>
                  <span style={{ fontSize: 12, color: l.confirmed ? C.green : C.red, flexShrink: 0 }}>{l.confirmed ? '✓' : '✗'}</span>
                  <div>
                    <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: 0.5, color: l.confirmed ? C.green : C.red }}>{l.name}</div>
                    <div style={{ fontSize: 9, color: 'var(--text-muted)', marginTop: 1 }}>{l.note}</div>
                  </div>
                </div>
              ))}
            </div>

            {/* Top feature contributions */}
            {Object.keys(dailySignal.featureContributions).length > 0 && (
              <div style={{ marginBottom: 14 }}>
                <div style={{ fontSize: 9, color: 'var(--text-muted)', letterSpacing: 1, marginBottom: 6 }}>TOP FEATURES</div>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  {Object.entries(dailySignal.featureContributions).map(([k, v]) => (
                    <div key={k} style={{ fontSize: 9, padding: '2px 8px', borderRadius: 2, background: 'rgba(168,85,247,0.1)', border: '1px solid rgba(168,85,247,0.2)', color: C.purple }}>
                      {k}: {v.value.toFixed(3)} <span style={{ opacity: 0.6 }}>({(v.importance * 100).toFixed(1)}%)</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Actions */}
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              {dailySignal.entry && (
                <CopyValue value={`${dailySignal.direction} ${pair} | Entry: ${dailySignal.entry?.toFixed(dp(pair))} | SL: ${dailySignal.sl?.toFixed(dp(pair))} | TP1: ${dailySignal.tp1?.toFixed(dp(pair))} | TP2: ${dailySignal.tp2?.toFixed(dp(pair))} | TP3: ${dailySignal.tp3?.toFixed(dp(pair))}`}>
                  <button style={btnStyle(C.purple)}>⎘ COPY LEVELS</button>
                </CopyValue>
              )}
              <button
                onClick={() => { if (!retraining) triggerRetrain() }}
                disabled={retraining}
                style={{ ...btnStyle(C.muted), opacity: retraining ? 0.5 : 1 }}
              >
                {retraining ? '⟳ RETRAINING…' : '↻ RETRAIN MODEL'}
              </button>
              <div style={{ marginLeft: 'auto', fontSize: 9, color: 'var(--text-muted)' }}>
                Updated: {new Date(dailySignal.timestamp).toLocaleTimeString('en', { hour12: false })}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── Layer 5: Risk ── */}
      <Panel title="LAYER 5 — RISK MANAGEMENT GATE" badge={
        <LayerBadge label={riskResult?.passed ? 'PASS' : riskResult ? 'BLOCKED' : 'IDLE'}
          color={riskResult?.passed ? C.green : riskResult ? C.red : C.muted} />
      }>
        <div style={{ padding: 14, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {riskResult?.checks?.map((c, i) => <ChecklistItem key={i} label={c.label} pass={c.ok} />)}
          {!riskResult && <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>Risk gate idle — start engine to activate</div>}
          <div style={{ width: '100%', borderTop: '1px solid var(--border)', marginTop: 6, paddingTop: 8, fontSize: 10, color: 'var(--text-muted)', letterSpacing: 0.5 }}>
            {RISK_CFG.maxRiskPct}% max risk · {RISK_CFG.maxDailyLossPct}% daily limit · SL {slMultiplier(volatilityRegime).toFixed(1)}× ATR ({volatilityRegime} vol) · Min conf {dynamicMinConf(winCount, tradeCount)}% (dynamic, {tradeCount} trades)
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
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 3, marginTop: 8, fontSize: 9 }}>
                  {[
                    { label: 'Entry', val: t.entry, color: 'var(--text-muted)' },
                    { label: 'SL', val: t.sl, color: C.red },
                    { label: 'TP1', val: t.tp1, color: t.partialsClosed! >= 1 ? 'var(--text-muted)' : C.green },
                    { label: 'TP2', val: t.tp2, color: t.partialsClosed! >= 2 ? 'var(--text-muted)' : C.green },
                    { label: 'TP3', val: t.tp3 ?? t.tp, color: C.teal },
                  ].map(({ label, val, color }) => val !== undefined ? (
                    <div key={label} style={{ textAlign: 'center', padding: '3px 2px', borderRadius: 2, background: color + '14', opacity: label.startsWith('TP') && t.partialsClosed !== undefined && t.partialsClosed >= parseInt(label[2]) ? 0.4 : 1 }}>
                      <div style={{ color: 'var(--text-muted)', fontSize: 8 }}>{label}</div>
                      <div className="mono" style={{ color, fontSize: 9 }}><CopyValue value={val.toFixed(decimals)}>{val.toFixed(decimals)}</CopyValue></div>
                    </div>
                  ) : null)}
                </div>
                {(t.partialsClosed ?? 0) > 0 && (
                  <div style={{ fontSize: 9, color: C.green, marginTop: 4 }}>
                    {t.partialsClosed === 1 ? '33% closed at TP1 · SL at breakeven' : '66% closed · trailing SL at TP1'}
                  </div>
                )}
                {t.mode === 'LIVE' && (
                  <div style={{ marginTop: 5, fontSize: 11, fontWeight: 700, color: t.pnl >= 0 ? C.green : C.red }}>
                    P&L: {currencySigned(t.pnl, account?.currency)}
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
                    color: t.result && t.result !== 'SL' ? C.green : C.red,
                    background: t.result && t.result !== 'SL' ? 'rgba(0,255,135,0.12)' : 'rgba(255,48,86,0.1)' }}>{t.result}</span>
                  <span style={{ fontSize: 9, color: 'var(--text-muted)' }}>{t.mode}</span>
                </div>
                <span className="mono" style={{ fontSize: 12, fontWeight: 700, color: t.pnl >= 0 ? C.green : C.red }}>
                  {currencySigned(t.pnl, account?.currency)}
                </span>

              </div>
            ))}
          </div>
        </Panel>
      </div>

      {/* ── Daily signal history + performance ── */}
      {(dailyHistory.length > 0 || dailySignal?.workerStatus) && (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginTop: 12 }}>
          <Panel title="DAILY SIGNAL HISTORY" badge={<span className="mono" style={{ fontSize: 10, color: 'var(--text-muted)' }}>{dailyHistory.length} signals</span>}>
            <div style={{ padding: 14, maxHeight: 220, overflowY: 'auto' }}>
              {dailyHistory.length === 0 ? (
                <div style={{ fontSize: 11, color: 'var(--text-muted)', textAlign: 'center', padding: 16 }}>No signals yet — confidence ≥ 60% required</div>
              ) : dailyHistory.map(h => (
                <div key={h.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '6px 0', borderBottom: '1px solid var(--border)' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <span style={{ fontSize: 9, fontWeight: 800, padding: '1px 6px', borderRadius: 2, color: dirColor(h.direction), background: dirBg(h.direction) }}>{h.direction}</span>
                    <span className="mono" style={{ fontSize: 11 }}>{h.pair}</span>
                    {h.entry && <span className="mono" style={{ fontSize: 10, color: 'var(--text-muted)' }}>@ {h.entry.toFixed(dp(h.pair))}</span>}
                  </div>
                  <div style={{ textAlign: 'right' }}>
                    <span className="mono" style={{ fontSize: 11, color: dirColor(h.direction) }}>{h.confidence}%</span>
                    <div style={{ fontSize: 9, color: 'var(--text-muted)' }}>{new Date(h.timestamp).toLocaleTimeString('en', { hour12: false })}</div>
                  </div>
                </div>
              ))}
            </div>
          </Panel>

          <Panel title="DAILY MODEL PERFORMANCE" badge={<LayerBadge label="WORKER" color={C.purple} />}>
            <div style={{ padding: 14 }}>
              {dailySignal?.workerStatus ? (() => {
                const ws = dailySignal.workerStatus!
                return (
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, fontSize: 11 }}>
                    <Row label="Status"   value={ws.worker_status ?? '—'} />
                    <Row label="Version"  value={ws.model_version ? `v${ws.model_version}` : '—'} />
                    <Row label="AUC"      value={ws.model_auc?.toFixed(4) ?? '—'} />
                    <Row label="Accuracy" value={ws.model_accuracy ? `${(ws.model_accuracy * 100).toFixed(1)}%` : '—'} />
                    <Row label="Dataset"  value={ws.dataset_size ? `${ws.dataset_size.toLocaleString()} rows` : '—'} />
                    <Row label="Freshness" value={ws.data_freshness ?? '—'} />
                    {ws.rows_added !== undefined && <Row label="New rows" value={`+${ws.rows_added}`} />}
                    {ws.last_trained && <Row label="Last trained" value={new Date(ws.last_trained).toLocaleDateString('en')} />}
                    {ws.top_features && ws.top_features.length > 0 && (
                      <div style={{ gridColumn: '1 / -1', marginTop: 6 }}>
                        <div style={{ fontSize: 9, color: 'var(--text-muted)', letterSpacing: 1, marginBottom: 4 }}>TOP FEATURES</div>
                        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                          {ws.top_features.slice(0, 5).map(f => (
                            <span key={f} style={{ fontSize: 9, padding: '1px 6px', borderRadius: 2, background: 'rgba(168,85,247,0.1)', border: '1px solid rgba(168,85,247,0.2)', color: C.purple }}>{f}</span>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                )
              })() : (
                <div style={{ fontSize: 11, color: 'var(--text-muted)', padding: 8 }}>
                  Run worker_daily.py to populate model status
                </div>
              )}
            </div>
          </Panel>
        </div>
      )}

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

function PriceLevel({ label, value, color, pips }: { label: string; value: string; color: string; pips: number | null }) {
  return (
    <div style={{ padding: '8px 10px', borderRadius: 3, background: 'rgba(0,0,0,0.2)', border: '1px solid var(--border)', textAlign: 'center' }}>
      <div style={{ fontSize: 9, color, fontWeight: 700, letterSpacing: 1, marginBottom: 3 }}>{label}</div>
      <div className="mono" style={{ fontSize: 13, fontWeight: 700, color }}>
        <CopyValue value={value}>{value}</CopyValue>
      </div>
      {pips !== null && <div style={{ fontSize: 9, color: 'var(--text-muted)', marginTop: 2 }}>{pips} pips</div>}
    </div>
  )
}
