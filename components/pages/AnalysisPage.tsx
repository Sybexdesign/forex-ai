'use client'
// components/pages/AnalysisPage.tsx

import { useState, useEffect } from 'react'
import { Panel, ChecklistItem, RsiGauge, LoadingDots, DirectionBadge, CopyValue } from '../ui'
import { useIndicators } from '@/hooks/useForex'
import { calcStandardPositionSize, getPipValue, getPipValuePerLot } from '@/lib/brokers/interface'
import { authFetch } from '@/lib/api'
import type { StrategySettings } from '@/lib/supabase'

const DEFAULT_PAIRS = ['XAU/USD', 'XAG/USD']
const TIMEFRAMES = ['1m', '3m', '5m', '15m', '1H', '4H', 'Daily']

const DIR_COLOR: Record<string, string> = {
  BUY: 'var(--color-buy)', SELL: 'var(--color-sell)', WAIT: 'var(--color-wait)'
}

interface AnalysisProps {
  prices: Record<string, any>
  strategy: StrategySettings
  news: any
  account: any
  openPositions: number
  todayPL: number
  onToast: (msg: string, color?: string) => void
  userId?: string
  onRefreshAccount?: () => void
  onRefreshTrades?: () => void
}

export default function AnalysisPage({
  prices, strategy, news, account, openPositions, todayPL, onToast, userId, onRefreshAccount, onRefreshTrades
}: AnalysisProps) {
  const rawWatchlist = strategy.watchlist?.length ? strategy.watchlist : DEFAULT_PAIRS
  // Restrict to metals only
  const watchlist = rawWatchlist.filter(p => p === 'XAU/USD' || p === 'XAG/USD').length > 0
    ? rawWatchlist.filter(p => p === 'XAU/USD' || p === 'XAG/USD')
    : DEFAULT_PAIRS
  const [pair, setPair] = useState(() => watchlist[0] || 'XAU/USD')
  const [tf, setTf] = useState('5m')
  const [evalDir, setEvalDir] = useState<'BUY' | 'SELL'>('BUY')
  const [loading, setLoading] = useState(false)
  const [rec, setRec] = useState<any>(null)
  const [orderLoading, setOrderLoading] = useState(false)
  const [lastSignalId, setLastSignalId] = useState<string | null>(null)
  const [accountSize, setAccountSize] = useState<number>(10000)
  const [accountSizeInput, setAccountSizeInput] = useState<string>('10000')

  const { indicators, loading: indLoading, error: indError } = useIndicators(pair, tf)

  // Reset recommendation when pair/tf changes
  useEffect(() => { setRec(null) }, [pair, tf])

  // If the selected pair was removed from the watchlist, switch to the first available
  useEffect(() => {
    if (!watchlist.includes(pair)) setPair(watchlist[0] || 'XAU/USD')
  }, [watchlist.join(',')]) // eslint-disable-line react-hooks/exhaustive-deps

  // Load persisted account size from localStorage
  useEffect(() => {
    const saved = localStorage.getItem('forexai_account_size')
    const initial = saved ? parseFloat(saved) : (account?.balance || 10000)
    setAccountSize(initial)
    setAccountSizeInput(initial.toFixed(0))
  }, [account?.balance])

  function handleAccountSizeChange(val: string) {
    setAccountSizeInput(val)
    const n = parseFloat(val.replace(/,/g, ''))
    if (!isNaN(n) && n > 0) {
      setAccountSize(n)
      localStorage.setItem('forexai_account_size', String(n))
    }
  }

  const balance = accountSize

  // Build checklist from indicators — mirrors server-side evaluateChecklist logic
  const checklist = indicators ? [
    {
      label: `EMA 20 ${evalDir === 'BUY' ? 'above' : 'below'} EMA 50 (trend direction)`,
      pass: evalDir === 'BUY' ? indicators.emaCrossed : !indicators.emaCrossed
    },
    {
      label: evalDir === 'BUY'
        ? `RSI confirms BUY momentum (45–70, current: ${indicators.rsi})`
        : `RSI confirms SELL momentum (30–55, current: ${indicators.rsi})`,
      pass: evalDir === 'BUY'
        ? indicators.rsi > 45 && indicators.rsi < 70
        : indicators.rsi < 55 && indicators.rsi > 30
    },
    {
      label: `MACD line + histogram confirm ${evalDir} direction`,
      pass: evalDir === 'BUY'
        ? indicators.macdLine > indicators.macdSignal && indicators.macdHistogram > 0
        : indicators.macdLine < indicators.macdSignal && indicators.macdHistogram < 0
    },
    {
      label: 'Price at favourable Bollinger Band zone',
      pass: indicators.priceVsBB === 'MIDDLE' ||
        (evalDir === 'BUY'  && (indicators.priceVsBB === 'NEAR_LOWER' || indicators.priceVsBB === 'BELOW_LOWER')) ||
        (evalDir === 'SELL' && (indicators.priceVsBB === 'NEAR_UPPER' || indicators.priceVsBB === 'ABOVE_UPPER'))
    },
    { label: 'No high-impact news within 30 minutes', pass: !news.hasHighImpactInWindow },
    {
      label: `ADX ≥ 20 — real trend exists (current: ${indicators.adx})`,
      pass: indicators.adx >= 20
    },
    {
      label: `Open positions below max (${openPositions}/${strategy.maxPositions})`,
      pass: openPositions < strategy.maxPositions
    },
    {
      label: 'Daily loss limit not reached',
      pass: todayPL > -(balance * strategy.maxLoss / 100)
    },
  ] : []

  const passCount = checklist.filter(c => c.pass).length
  const canTrade = passCount >= 6

  async function handleAnalyze() {
    if (!indicators) return
    setLoading(true)
    setRec(null)
    try {
      const res = await authFetch('/api/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          pair, timeframe: tf, direction: evalDir,
          indicators,
          strategy,
          context: {
            newsInWindow: news.hasHighImpactInWindow,
            newsEvent: news.events.find((e: any) => e.isInWindow)?.title,
            signalStrength: indicators?.adx ?? 70,
            openPositions,
            accountBalance: balance,
            todayPL,
          },
        }),
      })
      const data = await res.json()
      // Downgrade low-confidence results to WAIT — don't show tradable signal below 55%
      if (data.direction !== 'WAIT' && (data.confidence ?? 0) < 55) {
        data.direction = 'WAIT'
        data.risk_note = `Confidence too low (${data.confidence}%) — minimum 55% required. ${data.risk_note ?? ''}`
      }
      setRec(data)
      if (data.id) setLastSignalId(data.id)
      const color = DIR_COLOR[data.direction] || 'var(--color-wait)'
      onToast(`${pair} ${data.direction} — ${data.confidence}% confidence`, color)
    } catch (e: any) {
      onToast('Analysis failed: ' + e.message, '#ff3056')
    } finally {
      setLoading(false)
    }
  }

  async function handlePlaceOrder() {
    if (!rec || rec.direction === 'WAIT') return
    setOrderLoading(true)
    try {
      const res = await authFetch('/api/orders', {
        method: 'POST',
        body: JSON.stringify({
          pair,
          direction: rec.direction,
          strategy,
          currentPrice: prices[pair]?.bid || indicators?.currentPrice,
          newsInWindow: news.hasHighImpactInWindow,
          newsEvent: news.events.find((e: any) => e.isInWindow)?.title,
          signalId: lastSignalId,
          aiConfidence: rec.confidence,
          checklistScore: passCount,
          userId,
        }),
      })
      const data = await res.json()
      if (data.blocked) {
        onToast('🚫 Trade blocked: ' + data.reasons?.[0], '#ff3056')
      } else if (data.success) {
        onToast(
          `✅ ${rec.direction} order placed on ${pair} — ${data.lots} lots @ ${data.filledPrice?.toFixed?.(5) || 'market'}`,
          DIR_COLOR[rec.direction]
        )
        if (data.riskWarnings?.length) {
          setTimeout(() => onToast('⚠ Warning (order still placed): ' + data.riskWarnings[0], '#ffb800'), 500)
        }
        onRefreshTrades?.()
        setTimeout(() => onRefreshAccount?.(), 1500)
      } else {
        onToast('Order failed: ' + (data.error || 'Unknown error'), '#ff3056')
      }
    } catch (e: any) {
      onToast('Order error: ' + e.message, '#ff3056')
    } finally {
      setOrderLoading(false)
    }
  }

  const recColor = rec ? DIR_COLOR[rec.direction] || 'var(--color-wait)' : 'var(--blue)'

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {/* Pair + Timeframe + Direction selectors */}
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {watchlist.map(p => (
            <button key={p} className={`tab-btn ${pair === p ? 'active' : ''}`} onClick={() => setPair(p)}>
              {p}
            </button>
          ))}
        </div>
        <div style={{ display: 'flex', gap: 6, marginLeft: 'auto' }}>
          {TIMEFRAMES.map(t => (
            <button key={t} className={`tab-btn ${tf === t ? 'active' : ''}`} onClick={() => setTf(t)}>
              {t}
            </button>
          ))}
        </div>
      </div>

      {/* Account size + direction row */}
      <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
        {/* Account size input */}
        <div style={{
          display: 'flex', alignItems: 'center', gap: 8,
          background: 'var(--bg-panel)', border: '1px solid var(--border)',
          borderRadius: 4, padding: '6px 12px',
        }}>
          <span style={{ fontSize: 10, color: 'var(--text-muted)', letterSpacing: 1, whiteSpace: 'nowrap' }}>ACCOUNT SIZE</span>
          <span style={{ color: 'var(--text-muted)', fontSize: 13 }}>$</span>
          <input
            type="number"
            value={accountSizeInput}
            onChange={e => handleAccountSizeChange(e.target.value)}
            onBlur={() => setAccountSizeInput(accountSize.toFixed(0))}
            style={{
              background: 'transparent', border: 'none', outline: 'none',
              color: 'var(--color-accent)', fontFamily: 'JetBrains Mono', fontSize: 14,
              fontWeight: 700, width: 90, textAlign: 'right',
            }}
            min={100}
            step={100}
          />
        </div>

        {/* Lot preview */}
        {indicators && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--text-muted)' }}>
            <span>→</span>
            <span style={{ color: 'var(--color-wait)', fontFamily: 'JetBrains Mono', fontWeight: 700, fontSize: 14 }}>
              {calcStandardPositionSize(accountSize, strategy.riskPct, strategy.slPips, pair).toFixed(2)} lots
            </span>
            <span style={{ fontSize: 10 }}>
              ({strategy.riskPct}% risk, {strategy.slPips}p SL)
            </span>
          </div>
        )}
      </div>

      {/* Direction toggle */}
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>EVALUATE:</span>
        <button
          className={`btn ${evalDir === 'BUY' ? 'btn-buy' : 'btn-ghost'}`}
          onClick={() => setEvalDir('BUY')}
          style={{ padding: '5px 20px' }}
        >▲ BUY</button>
        <button
          className={`btn ${evalDir === 'SELL' ? 'btn-sell' : 'btn-ghost'}`}
          onClick={() => setEvalDir('SELL')}
          style={{ padding: '5px 20px' }}
        >▼ SELL</button>
        {indicators && (() => {
          const liveBid = prices[pair]?.bid
          const liveAsk = prices[pair]?.ask
          const dp = pair.startsWith('XA') ? 2 : pair.includes('JPY') ? 3 : 5
          // Only trust the price feed if it's within 2% of the candle-based price —
          // Capital.com GOLD can diverge significantly from the MT5 spot price.
          const base = indicators.currentPrice
          const isTrusted = liveBid && Math.abs(liveBid - base) / base < 0.02
          const displayBid = isTrusted ? liveBid! : base
          const displayAsk = isTrusted ? (liveAsk || liveBid!) : base
          return (
            <span className="mono" style={{ marginLeft: 8, fontSize: 12, color: 'var(--text-muted)' }}>
              {isTrusted ? 'Bid' : 'Price'}:
              {' '}<span style={{ color: isTrusted ? 'var(--color-sell)' : 'var(--color-accent-dim)' }}>{displayBid.toFixed(dp)}</span>
              {isTrusted && <>{' / '}Ask: <span style={{ color: 'var(--color-buy)' }}>{displayAsk.toFixed(dp)}</span></>}
            </span>
          )
        })()}
      </div>

      {/* Main grid */}
      <div className="grid-2col">

        {/* Left column: Indicators */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <Panel title={`INDICATORS — ${pair} ${tf}`}>
            <div style={{ padding: '0 16px 12px' }}>
              {indLoading && (
                <div style={{ padding: 20, textAlign: 'center' }}><LoadingDots /></div>
              )}
              {indError && (
                <div style={{ padding: 12, color: 'var(--color-sell)', fontSize: 12 }}>⚠ {indError}</div>
              )}
              {indicators && !indLoading && (() => {
                const priceDp = pair.startsWith('XA') ? 2 : pair.includes('JPY') ? 3 : 5
                const fmt = (v: number) => typeof v === 'number' ? v.toFixed(priceDp) : v
                return (
                <>
                  {/* EMA */}
                  <div style={{ padding: '10px 0 6px', borderBottom: '1px solid var(--border)' }}>
                    <div style={{ fontSize: 10, color: 'var(--text-muted)', letterSpacing: 1, marginBottom: 6, fontWeight: 700 }}>
                      TREND — EMA
                    </div>
                    <div className="ind-row">
                      <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>EMA 20</span>
                      <span className="mono" style={{ fontSize: 13, color: indicators.emaCrossed ? 'var(--color-buy)' : 'var(--color-sell)' }}>
                        {fmt(indicators.ema20)}
                      </span>
                    </div>
                    <div className="ind-row">
                      <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>EMA 50</span>
                      <span className="mono" style={{ fontSize: 13, color: 'var(--text-secondary)' }}>
                        {fmt(indicators.ema50)}
                      </span>
                    </div>
                    <div className="ind-row">
                      <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>Cross Signal</span>
                      <span className="mono" style={{ fontSize: 12, color: indicators.emaCrossed ? 'var(--color-buy)' : 'var(--color-sell)' }}>
                        {indicators.emaCrossSignal}
                      </span>
                    </div>
                  </div>

                  {/* Momentum */}
                  <div style={{ padding: '10px 0 6px', borderBottom: '1px solid var(--border)' }}>
                    <div style={{ fontSize: 10, color: 'var(--text-muted)', letterSpacing: 1, marginBottom: 6, fontWeight: 700 }}>
                      MOMENTUM — RSI / MACD
                    </div>
                    <div style={{ marginBottom: 10 }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
                        <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>RSI (14)</span>
                        <span className="mono" style={{ fontSize: 13, color: indicators.rsi > 70 ? 'var(--color-sell)' : indicators.rsi < 30 ? 'var(--color-buy)' : 'var(--blue)' }}>
                          {indicators.rsi} — {indicators.rsiZone}
                        </span>
                      </div>
                      <RsiGauge rsi={indicators.rsi} />
                    </div>
                    {[
                      ['MACD Line', indicators.macdLine, indicators.macdLine > 0 ? 'var(--color-buy)' : 'var(--color-sell)'],
                      ['MACD Signal', indicators.macdSignal, 'var(--text-secondary)'],
                      ['MACD Hist', indicators.macdHistogram, indicators.macdHistogram > 0 ? 'var(--color-profit)' : 'var(--color-loss)'],
                      ['MACD Cross', indicators.macdCrossover, indicators.macdCrossover === 'BULLISH' ? 'var(--color-buy)' : indicators.macdCrossover === 'BEARISH' ? 'var(--color-sell)' : 'var(--text-muted)'],
                    ].map(([label, val, color]: any) => (
                      <div key={label} className="ind-row">
                        <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>{label}</span>
                        <span className="mono" style={{ fontSize: 12, color }}>{typeof val === 'number' ? val.toFixed(6) : val}</span>
                      </div>
                    ))}
                  </div>

                  {/* ADX + BB */}
                  <div style={{ padding: '10px 0 0' }}>
                    <div style={{ fontSize: 10, color: 'var(--text-muted)', letterSpacing: 1, marginBottom: 6, fontWeight: 700 }}>
                      STRENGTH + VOLATILITY
                    </div>
                    {[
                      ['ADX (14)', `${indicators.adx} — ${indicators.adxStrength}`, indicators.adx > 25 ? 'var(--color-buy)' : 'var(--text-secondary)'],
                      ['BB Upper', indicators.bbUpper, 'var(--text-secondary)'],
                      ['BB Middle', indicators.bbMiddle, 'var(--blue)'],
                      ['BB Lower', indicators.bbLower, 'var(--text-secondary)'],
                      ['Price vs BB', indicators.priceVsBB, 'var(--amber)'],
                    ].map(([label, val, color]: any) => (
                      <div key={label} className="ind-row">
                        <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>{label}</span>
                        <span className="mono" style={{ fontSize: 12, color }}>
                          {typeof val === 'number' ? fmt(val) : val}
                        </span>
                      </div>
                    ))}
                  </div>
                </>
                )
              })()}
            </div>
          </Panel>
        </div>

        {/* Right column: Checklist + Recommendation */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {/* Checklist */}
          <Panel
            title="ENTRY CHECKLIST"
            badge={
              <span className="mono" style={{
                fontSize: 13, fontWeight: 700,
                color: canTrade ? 'var(--color-buy)' : passCount >= 4 ? 'var(--color-wait)' : 'var(--color-sell)'
              }}>
                {passCount}/8 {canTrade ? '✓ READY' : '✗ WAIT'}
              </span>
            }
          >
            <div style={{ padding: '8px 8px 12px' }}>
              {checklist.length === 0
                ? <div style={{ padding: 12, color: 'var(--text-muted)', fontSize: 12 }}>Loading indicators…</div>
                : checklist.map((item, i) => <ChecklistItem key={i} label={item.label} pass={item.pass} />)
              }
            </div>
          </Panel>

          {/* Analyze button */}
          <button
            className="btn btn-primary"
            onClick={handleAnalyze}
            disabled={loading || indLoading || !indicators}
            style={{ padding: '13px', fontSize: 15, letterSpacing: 2, width: '100%' }}
          >
            {loading ? <LoadingDots /> : '⚡ ANALYZE WITH AI'}
          </button>

          {/* Recommendation card */}
          {rec && (
            <div className="fade-in dir-card" data-dir={rec.direction} style={{ padding: 16 }}>
              {/* Header */}
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                  <span style={{
                    fontSize: 28, fontWeight: 900, color: recColor,
                    fontFamily: 'Rajdhani', letterSpacing: 2, lineHeight: 1
                  }}>
                    {rec.direction}
                  </span>
                  <div>
                    <div style={{
                      fontSize: 20, fontWeight: 700, color: recColor,
                      fontFamily: 'JetBrains Mono', lineHeight: 1
                    }}>
                      {rec.confidence}%
                    </div>
                    <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>CONFIDENCE</div>
                  </div>
                </div>
                <span className="mono" style={{
                  fontSize: 11, color: 'var(--text-muted)',
                  background: 'var(--border)', padding: '3px 8px', borderRadius: 2
                }}>
                  {rec.checklist_passed ?? passCount}/8 rules
                </span>
              </div>

              {/* Entry zone */}
              {rec.direction !== 'WAIT' && rec.entry_zone && (
                <div style={{
                  background: 'rgba(0,0,0,0.1)', borderRadius: 3, padding: '8px 12px',
                  marginBottom: 12, display: 'flex', justifyContent: 'space-between', alignItems: 'center'
                }}>
                  <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>ENTRY ZONE</span>
                  <span className="mono" style={{ fontSize: 13, color: 'var(--color-accent-dim)' }}>
                    <CopyValue value={rec.entry_zone.low?.toFixed?.(5) ?? ''}>{rec.entry_zone.low?.toFixed?.(5)}</CopyValue>
                    {' — '}
                    <CopyValue value={rec.entry_zone.high?.toFixed?.(5) ?? ''}>{rec.entry_zone.high?.toFixed?.(5)}</CopyValue>
                  </span>
                </div>
              )}

              {/* Reasons */}
              <div style={{ marginBottom: 12 }}>
                {(rec.reasons || []).map((r: string, i: number) => (
                  <div key={i} style={{
                    display: 'flex', gap: 8, marginBottom: 6,
                    fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.5
                  }}>
                    <span style={{ color: recColor, flexShrink: 0, marginTop: 1 }}>→</span>
                    <span>{r}</span>
                  </div>
                ))}
              </div>

              {/* Risk note */}
              <div style={{
                fontSize: 12, color: 'var(--color-warn-text)', lineHeight: 1.5,
                padding: '8px 12px', borderRadius: 3,
                background: 'rgba(138,98,0,0.07)', border: '1px solid rgba(138,98,0,0.22)',
                marginBottom: 14
              }}>
                <span style={{ fontWeight: 700 }}>⚠ RISK NOTE: </span>{rec.risk_note}
              </div>

              {/* TP/SL + Position size */}
              {rec.direction !== 'WAIT' && indicators && (() => {
                const pip = getPipValue(pair)
                const pipPerLot = getPipValuePerLot(pair)
                const lots = calcStandardPositionSize(accountSize, strategy.riskPct, strategy.slPips, pair)
                const riskAmt = (accountSize * strategy.riskPct / 100).toFixed(2)
                const sign = rec.direction === 'BUY' ? 1 : -1
                const dp = pair.includes('JPY') ? 3 : pair.startsWith('XA') ? 2 : 5
                const feedBid = prices[pair]?.bid
                const feedAsk = prices[pair]?.ask
                const feedTrusted = feedBid && Math.abs(feedBid - indicators.currentPrice) / indicators.currentPrice < 0.02
                const entryPrice = feedTrusted
                  ? (rec.direction === 'BUY' ? (feedAsk || feedBid!) : feedBid!)
                  : indicators.currentPrice
                const tpPrice = (entryPrice + strategy.tpPips * pip * sign).toFixed(dp)
                const slPrice = (entryPrice - strategy.slPips * pip * sign).toFixed(dp)
                return (
                  <>
                    <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
                      {[
                        ['TAKE PROFIT', tpPrice, 'var(--color-profit)'],
                        ['STOP LOSS',   slPrice, 'var(--color-loss)'],
                      ].map(([label, val, color]) => (
                        <div key={label} style={{ flex: 1, background: 'rgba(0,0,0,0.1)', borderRadius: 3, padding: '6px 10px' }}>
                          <div style={{ fontSize: 9, color: 'var(--text-muted)', letterSpacing: 1, marginBottom: 3 }}>{label}</div>
                          <div className="mono" style={{ fontSize: 13, color, fontWeight: 700 }}>
                            <CopyValue value={val as string}>{val}</CopyValue>
                          </div>
                        </div>
                      ))}
                    </div>

                    {/* Position size breakdown */}
                    <div style={{
                      background: 'rgba(0,85,176,0.07)', border: '1px solid rgba(0,85,176,0.2)',
                      borderRadius: 3, padding: '10px 12px', marginBottom: 14,
                    }}>
                      <div style={{ fontSize: 10, color: 'var(--color-accent)', letterSpacing: 1, marginBottom: 8, fontWeight: 700 }}>
                        POSITION SIZE
                      </div>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end' }}>
                        <div>
                          <div className="mono" style={{ fontSize: 30, fontWeight: 900, color: 'var(--color-accent)', lineHeight: 1 }}>
                            {lots.toFixed(2)}
                            <span style={{ fontSize: 14, color: 'var(--text-muted)', fontWeight: 400, marginLeft: 6 }}>lots</span>
                          </div>
                          <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>
                            ${riskAmt} risk ({strategy.riskPct}% of ${accountSize.toLocaleString()})
                          </div>
                        </div>
                        <div style={{ textAlign: 'right', fontSize: 11, color: 'var(--text-muted)' }}>
                          <div>${(pipPerLot * lots).toFixed(2)} / pip</div>
                          <div style={{ color: 'var(--color-profit)', marginTop: 3 }}>
                            TP +${(pipPerLot * lots * strategy.tpPips).toFixed(2)}
                          </div>
                          <div style={{ color: 'var(--color-loss)', marginTop: 2 }}>
                            SL −${(pipPerLot * lots * strategy.slPips).toFixed(2)}
                          </div>
                        </div>
                      </div>
                    </div>
                  </>
                )
              })()}

              {/* Trade button */}
              {rec.direction !== 'WAIT' && canTrade && (
                <button
                  className={`btn ${rec.direction === 'BUY' ? 'btn-buy' : 'btn-sell'}`}
                  onClick={handlePlaceOrder}
                  disabled={orderLoading}
                  style={{ width: '100%', padding: '12px', fontSize: 15, letterSpacing: 2 }}
                >
                  {orderLoading
                    ? <LoadingDots color={recColor} />
                    : `PLACE ${rec.direction} ORDER — ${pair}`
                  }
                </button>
              )}
              {!canTrade && (
                <div style={{ textAlign: 'center', fontSize: 12, color: 'var(--color-sell)', padding: '8px' }}>
                  ✗ Minimum 6/8 checklist rules required to trade
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
