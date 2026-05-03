'use client'
// components/pages/AnalysisPage.tsx

import { useState, useEffect } from 'react'
import { Panel, ChecklistItem, RsiGauge, LoadingDots, DirectionBadge } from '../ui'
import { useIndicators } from '@/hooks/useForex'
import type { StrategySettings } from '@/lib/supabase'

const PAIRS = ['EUR/USD', 'GBP/USD', 'USD/JPY', 'AUD/USD', 'XAU/USD']
const TIMEFRAMES = ['5m', '15m', '1H', '4H', 'Daily']

const DIR_COLOR: Record<string, string> = {
  BUY: '#00ff87', SELL: '#ff3056', WAIT: '#ffb800'
}

interface AnalysisProps {
  prices: Record<string, any>
  strategy: StrategySettings
  news: any
  account: any
  openPositions: number
  todayPL: number
  onToast: (msg: string, color?: string) => void
}

export default function AnalysisPage({
  prices, strategy, news, account, openPositions, todayPL, onToast
}: AnalysisProps) {
  const [pair, setPair] = useState('EUR/USD')
  const [tf, setTf] = useState('1H')
  const [evalDir, setEvalDir] = useState<'BUY' | 'SELL'>('BUY')
  const [loading, setLoading] = useState(false)
  const [rec, setRec] = useState<any>(null)
  const [orderLoading, setOrderLoading] = useState(false)
  const [lastSignalId, setLastSignalId] = useState<string | null>(null)

  const { indicators, loading: indLoading, error: indError } = useIndicators(pair, tf)

  // Reset recommendation when pair/tf changes
  useEffect(() => { setRec(null) }, [pair, tf])

  const balance = account?.balance || 10284.50
  const signalStrength = prices[pair]?.strength || 65

  // Build checklist from indicators if available
  const checklist = indicators ? [
    {
      label: `EMA 20 ${evalDir === 'BUY' ? 'above' : 'below'} EMA 50 (${evalDir} direction)`,
      pass: evalDir === 'BUY' ? indicators.emaCrossed : !indicators.emaCrossed
    },
    {
      label: 'RSI between 40–60 (not overextended)',
      pass: indicators.rsi >= 40 && indicators.rsi <= 60
    },
    {
      label: `MACD crossover confirmed in ${evalDir} direction`,
      pass: evalDir === 'BUY'
        ? indicators.macdLine > indicators.macdSignal
        : indicators.macdLine < indicators.macdSignal
    },
    {
      label: 'Price at key Bollinger Band level',
      pass: indicators.priceVsBB === 'MIDDLE' ||
        (evalDir === 'BUY' && indicators.priceVsBB === 'NEAR_LOWER') ||
        (evalDir === 'SELL' && indicators.priceVsBB === 'NEAR_UPPER')
    },
    { label: 'No high-impact news within 30 minutes', pass: !news.hasHighImpactInWindow },
    {
      label: `Signal strength ≥ ${strategy.minStrength}% (current: ${signalStrength}%)`,
      pass: signalStrength >= strategy.minStrength
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
      const res = await fetch('/api/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          pair, timeframe: tf, direction: evalDir,
          indicators,
          strategy,
          context: {
            newsInWindow: news.hasHighImpactInWindow,
            newsEvent: news.events.find((e: any) => e.isInWindow)?.title,
            signalStrength,
            openPositions,
            accountBalance: balance,
            todayPL,
          },
        }),
      })
      const data = await res.json()
      setRec(data)
      if (data.id) setLastSignalId(data.id)
      const color = DIR_COLOR[data.direction] || '#ffb800'
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
      const res = await fetch('/api/orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          pair,
          direction: rec.direction,
          strategy,
          currentPrice: indicators?.currentPrice || prices[pair]?.bid,
          newsInWindow: news.hasHighImpactInWindow,
          newsEvent: news.events.find((e: any) => e.isInWindow)?.title,
          signalId: lastSignalId,
          aiConfidence: rec.confidence,
          checklistScore: passCount,
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
          setTimeout(() => onToast('⚠ ' + data.riskWarnings[0], '#ffb800'), 500)
        }
      } else {
        onToast('Order failed: ' + (data.error || 'Unknown error'), '#ff3056')
      }
    } catch (e: any) {
      onToast('Order error: ' + e.message, '#ff3056')
    } finally {
      setOrderLoading(false)
    }
  }

  const recColor = rec ? DIR_COLOR[rec.direction] || '#ffb800' : '#0080ff'

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {/* Pair + Timeframe + Direction selectors */}
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {PAIRS.map(p => (
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
        {indicators && (
          <span className="mono" style={{ marginLeft: 8, fontSize: 12, color: 'var(--text-muted)' }}>
            Price: <span style={{ color: '#90b0d0' }}>{indicators.currentPrice.toFixed(5)}</span>
          </span>
        )}
      </div>

      {/* Main grid */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>

        {/* Left column: Indicators */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <Panel title={`INDICATORS — ${pair} ${tf}`}>
            <div style={{ padding: '0 16px 12px' }}>
              {indLoading && (
                <div style={{ padding: 20, textAlign: 'center' }}><LoadingDots /></div>
              )}
              {indError && (
                <div style={{ padding: 12, color: '#ff6060', fontSize: 12 }}>⚠ {indError}</div>
              )}
              {indicators && !indLoading && (
                <>
                  {/* EMA */}
                  <div style={{ padding: '10px 0 6px', borderBottom: '1px solid var(--border)' }}>
                    <div style={{ fontSize: 10, color: 'var(--text-muted)', letterSpacing: 1, marginBottom: 6, fontWeight: 700 }}>
                      TREND — EMA
                    </div>
                    <div className="ind-row">
                      <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>EMA 20</span>
                      <span className="mono" style={{ fontSize: 13, color: indicators.emaCrossed ? '#00ff87' : '#ff6060' }}>
                        {indicators.ema20}
                      </span>
                    </div>
                    <div className="ind-row">
                      <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>EMA 50</span>
                      <span className="mono" style={{ fontSize: 13, color: 'var(--text-secondary)' }}>
                        {indicators.ema50}
                      </span>
                    </div>
                    <div className="ind-row">
                      <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>Cross Signal</span>
                      <span className="mono" style={{ fontSize: 12, color: indicators.emaCrossed ? '#00ff87' : '#ff3056' }}>
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
                        <span className="mono" style={{ fontSize: 13, color: indicators.rsi > 70 ? '#ff3056' : indicators.rsi < 30 ? '#00ff87' : '#0080ff' }}>
                          {indicators.rsi} — {indicators.rsiZone}
                        </span>
                      </div>
                      <RsiGauge rsi={indicators.rsi} />
                    </div>
                    {[
                      ['MACD Line', indicators.macdLine, indicators.macdLine > 0 ? '#00ff87' : '#ff3056'],
                      ['MACD Signal', indicators.macdSignal, 'var(--text-secondary)'],
                      ['MACD Hist', indicators.macdHistogram, indicators.macdHistogram > 0 ? '#00c060' : '#c02040'],
                      ['MACD Cross', indicators.macdCrossover, indicators.macdCrossover === 'BULLISH' ? '#00ff87' : indicators.macdCrossover === 'BEARISH' ? '#ff3056' : 'var(--text-muted)'],
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
                      ['ADX (14)', `${indicators.adx} — ${indicators.adxStrength}`, indicators.adx > 25 ? '#00ff87' : 'var(--text-secondary)'],
                      ['BB Upper', indicators.bbUpper, 'var(--text-secondary)'],
                      ['BB Middle', indicators.bbMiddle, '#0080ff'],
                      ['BB Lower', indicators.bbLower, 'var(--text-secondary)'],
                      ['Price vs BB', indicators.priceVsBB, 'var(--amber)'],
                    ].map(([label, val, color]: any) => (
                      <div key={label} className="ind-row">
                        <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>{label}</span>
                        <span className="mono" style={{ fontSize: 12, color }}>
                          {typeof val === 'number' ? val.toFixed(6) : val}
                        </span>
                      </div>
                    ))}
                  </div>
                </>
              )}
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
                color: canTrade ? '#00ff87' : passCount >= 4 ? '#ffb800' : '#ff3056'
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
            <div className="fade-in" style={{
              background: `${recColor}0d`,
              border: `1px solid ${recColor}35`,
              borderRadius: 4, padding: 16
            }}>
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
                  background: 'rgba(0,0,0,0.2)', borderRadius: 3, padding: '8px 12px',
                  marginBottom: 12, display: 'flex', justifyContent: 'space-between', alignItems: 'center'
                }}>
                  <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>ENTRY ZONE</span>
                  <span className="mono" style={{ fontSize: 13, color: '#90b0d0' }}>
                    {rec.entry_zone.low?.toFixed?.(5)} — {rec.entry_zone.high?.toFixed?.(5)}
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
                fontSize: 12, color: '#e0a060', lineHeight: 1.5,
                padding: '8px 12px', borderRadius: 3,
                background: 'rgba(255,184,0,0.07)', border: '1px solid rgba(255,184,0,0.2)',
                marginBottom: 14
              }}>
                <span style={{ fontWeight: 700 }}>⚠ RISK NOTE: </span>{rec.risk_note}
              </div>

              {/* TP/SL preview */}
              {rec.direction !== 'WAIT' && indicators && (
                <div style={{ display: 'flex', gap: 10, marginBottom: 14 }}>
                  {[
                    ['TP', (indicators.currentPrice + strategy.tpPips * 0.0001 * (rec.direction === 'BUY' ? 1 : -1)).toFixed(5), '#00c060'],
                    ['SL', (indicators.currentPrice - strategy.slPips * 0.0001 * (rec.direction === 'BUY' ? 1 : -1)).toFixed(5), '#c02040'],
                    ['LOTS', (balance * strategy.riskPct / 100 / (strategy.slPips * 10)).toFixed(2), '#6090c0'],
                  ].map(([label, val, color]) => (
                    <div key={label} style={{ flex: 1, background: 'rgba(0,0,0,0.2)', borderRadius: 3, padding: '6px 10px' }}>
                      <div style={{ fontSize: 9, color: 'var(--text-muted)', letterSpacing: 1, marginBottom: 3 }}>{label}</div>
                      <div className="mono" style={{ fontSize: 13, color, fontWeight: 700 }}>{val}</div>
                    </div>
                  ))}
                </div>
              )}

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
                <div style={{ textAlign: 'center', fontSize: 12, color: '#ff6060', padding: '8px' }}>
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
