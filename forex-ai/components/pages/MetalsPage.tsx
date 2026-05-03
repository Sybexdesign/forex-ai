'use client'
// components/pages/MetalsPage.tsx
// Dedicated Gold (XAU/USD) and Silver (XAG/USD) trading page

import { useState, useEffect } from 'react'
import { Panel, LoadingDots, DirectionBadge, StatCard } from '../ui'
import { METAL_CONFIG, goldSilverRatio, goldAIContext, goldPositionSize } from '@/lib/metals'

const METALS = ['XAU/USD', 'XAG/USD']

const DIR_COLOR: Record<string, string> = {
  BUY: '#00ff87', SELL: '#ff3056', WAIT: '#FFD700'
}

interface MetalsPageProps {
  prices: Record<string, any>
  strategy: any
  news: any
  account: any
  onToast: (msg: string, color?: string) => void
}

export default function MetalsPage({ prices, strategy, news, account, onToast }: MetalsPageProps) {
  const [selected, setSelected] = useState<'XAU/USD' | 'XAG/USD'>('XAU/USD')
  const [evalDir, setEvalDir] = useState<'BUY' | 'SELL'>('BUY')
  const [tf, setTf] = useState('1H')
  const [indicators, setIndicators] = useState<any>(null)
  const [loadingInd, setLoadingInd] = useState(false)
  const [rec, setRec] = useState<any>(null)
  const [loadingRec, setLoadingRec] = useState(false)
  const [orderLoading, setOrderLoading] = useState(false)
  const [priceHistory, setPriceHistory] = useState<number[]>([])

  const cfg = METAL_CONFIG[selected]
  const goldPrice = prices['XAU/USD']?.bid || 2318.40
  const silverPrice = prices['XAG/USD']?.bid || 27.42
  const currentPrice = prices[selected]?.bid || (selected === 'XAU/USD' ? 2318.40 : 27.42)
  const ratio = goldSilverRatio(goldPrice, silverPrice)
  const balance = account?.balance || 10000

  // Track price history for mini sparkline
  useEffect(() => {
    setPriceHistory(prev => [...prev.slice(-29), currentPrice])
  }, [currentPrice])

  // Load indicators when pair/tf changes
  useEffect(() => {
    setLoadingInd(true)
    setRec(null)
    fetch(`/api/indicators?pair=${encodeURIComponent(selected)}&timeframe=${tf}`)
      .then(r => r.json())
      .then(d => { setIndicators(d.indicators); setLoadingInd(false) })
      .catch(() => setLoadingInd(false))
  }, [selected, tf])

  async function handleAnalyze() {
    if (!indicators) return
    setLoadingRec(true)
    setRec(null)
    try {
      const res = await fetch('/api/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          pair: selected,
          timeframe: tf,
          direction: evalDir,
          indicators,
          strategy,
          context: {
            newsInWindow: news?.hasHighImpactInWindow || false,
            signalStrength: 70,
            openPositions: account?.openTradeCount || 0,
            accountBalance: balance,
            todayPL: 0,
            metalContext: goldAIContext(selected, currentPrice),
          },
        }),
      })
      const data = await res.json()
      setRec(data)
      onToast(
        `${cfg.name} ${data.direction} — ${data.confidence}% confidence`,
        data.direction === 'BUY' ? '#00ff87' : data.direction === 'SELL' ? '#ff3056' : '#FFD700'
      )
    } catch (e: any) {
      onToast('Analysis failed: ' + e.message, '#ff3056')
    }
    setLoadingRec(false)
  }

  async function handlePlaceOrder() {
    if (!rec || rec.direction === 'WAIT') return
    setOrderLoading(true)
    const lots = goldPositionSize(balance, strategy.riskPct, strategy.slPips, selected)
    try {
      const res = await fetch('/api/orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          pair: selected,
          direction: rec.direction,
          strategy,
          currentPrice,
          newsInWindow: news?.hasHighImpactInWindow || false,
          aiConfidence: rec.confidence,
          checklistScore: rec.checklist_passed,
        }),
      })
      const data = await res.json()
      if (data.blocked) {
        onToast('🚫 ' + data.reasons?.[0], '#ff3056')
      } else if (data.success) {
        onToast(
          `✅ ${rec.direction} ${cfg.name} — ${lots} lots @ $${currentPrice.toFixed(2)}`,
          DIR_COLOR[rec.direction]
        )
      }
    } catch (e: any) {
      onToast('Order failed: ' + e.message, '#ff3056')
    }
    setOrderLoading(false)
  }

  const recColor = rec ? DIR_COLOR[rec.direction] || '#FFD700' : cfg.color
  const lotSize = goldPositionSize(balance, strategy.riskPct, strategy.slPips, selected)
  const riskUSD = (balance * strategy.riskPct / 100).toFixed(2)

  // Sparkline SVG
  function Sparkline({ data, color }: { data: number[]; color: string }) {
    if (data.length < 2) return null
    const min = Math.min(...data)
    const max = Math.max(...data)
    const range = max - min || 1
    const w = 120, h = 32
    const pts = data.map((v, i) => `${(i / (data.length - 1)) * w},${h - ((v - min) / range) * h}`).join(' ')
    return (
      <svg width={w} height={h} style={{ display: 'block' }}>
        <polyline points={pts} fill="none" stroke={color} strokeWidth={1.5} strokeLinejoin="round" />
      </svg>
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>

      {/* Metal selector */}
      <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
        {METALS.map(metal => {
          const mc = METAL_CONFIG[metal as keyof typeof METAL_CONFIG]
          const active = selected === metal
          return (
            <button
              key={metal}
              onClick={() => { setSelected(metal as any); setRec(null) }}
              style={{
                display: 'flex', alignItems: 'center', gap: 10,
                padding: '10px 20px', borderRadius: 4, cursor: 'pointer',
                background: active ? mc.bgColor : 'transparent',
                border: `1px solid ${active ? mc.borderColor : 'var(--border)'}`,
                transition: 'all 0.15s',
                boxShadow: active ? `0 0 16px ${mc.color}20` : 'none',
              }}
            >
              <span style={{ fontSize: 22 }}>{mc.emoji}</span>
              <div style={{ textAlign: 'left' }}>
                <div style={{ fontFamily: 'Rajdhani', fontWeight: 700, fontSize: 16, color: active ? mc.color : 'var(--text-secondary)' }}>
                  {mc.name}
                </div>
                <div className="mono" style={{ fontSize: 11, color: 'var(--text-muted)' }}>{metal}</div>
              </div>
              <div style={{ marginLeft: 12 }}>
                <div className="mono" style={{ fontSize: 18, fontWeight: 700, color: active ? mc.color : 'var(--text-secondary)' }}>
                  ${(prices[metal]?.bid || (metal === 'XAU/USD' ? 2318.40 : 27.42)).toFixed(mc.decimals)}
                </div>
                <div style={{ fontSize: 10, color: prices[metal]?.trend === 'up' ? '#00ff87' : '#ff3056' }}>
                  {prices[metal]?.trend === 'up' ? '▲' : '▼'}{' '}
                  {Math.abs(prices[metal]?.change || 0).toFixed(metal === 'XAU/USD' ? 2 : 3)}
                </div>
              </div>
            </button>
          )
        })}

        {/* Gold/Silver ratio */}
        <div className="panel" style={{
          padding: '10px 16px', marginLeft: 'auto',
          borderColor: ratio.signal === 'BUY_SILVER' ? 'rgba(192,192,192,0.3)' : ratio.signal === 'BUY_GOLD' ? 'rgba(255,215,0,0.3)' : 'var(--border)'
        }}>
          <div style={{ fontSize: 10, color: 'var(--text-muted)', letterSpacing: 1, marginBottom: 4 }}>GOLD/SILVER RATIO</div>
          <div className="mono" style={{ fontSize: 22, fontWeight: 700, color: cfg.color }}>{ratio.ratio}x</div>
          <div style={{ fontSize: 10, color: ratio.signal === 'NEUTRAL' ? 'var(--text-muted)' : '#ffb800', marginTop: 2 }}>
            {ratio.signal === 'BUY_SILVER' ? '↓ Favor Silver' : ratio.signal === 'BUY_GOLD' ? '↑ Favor Gold' : 'Neutral'}
          </div>
        </div>
      </div>

      {/* Main grid */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>

        {/* Left: Price info + Drivers + Position calculator */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>

          {/* Live price card */}
          <div style={{
            background: cfg.bgColor, border: `1px solid ${cfg.borderColor}`,
            borderRadius: 4, padding: 16,
            boxShadow: `0 0 24px ${cfg.color}10`,
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
              <div>
                <div style={{ fontSize: 11, color: cfg.dimColor, letterSpacing: 1, marginBottom: 6 }}>
                  {cfg.emoji} {cfg.name.toUpperCase()} / USD
                </div>
                <div className="mono" style={{ fontSize: 36, fontWeight: 700, color: cfg.color, lineHeight: 1 }}>
                  ${currentPrice.toFixed(cfg.decimals)}
                </div>
                <div style={{ display: 'flex', gap: 16, marginTop: 8, fontSize: 12 }}>
                  <span style={{ color: 'var(--text-muted)' }}>
                    BID: <span className="mono" style={{ color: cfg.dimColor }}>${(prices[selected]?.bid || currentPrice).toFixed(cfg.decimals)}</span>
                  </span>
                  <span style={{ color: 'var(--text-muted)' }}>
                    ASK: <span className="mono" style={{ color: cfg.dimColor }}>${(prices[selected]?.ask || currentPrice + cfg.spread).toFixed(cfg.decimals)}</span>
                  </span>
                  <span style={{ color: 'var(--text-muted)' }}>
                    SPREAD: <span className="mono" style={{ color: cfg.dimColor }}>${cfg.spread}</span>
                  </span>
                </div>
              </div>
              <div style={{ textAlign: 'right' }}>
                <Sparkline data={priceHistory} color={cfg.color} />
                <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 4 }}>30 ticks</div>
              </div>
            </div>
          </div>

          {/* Market drivers */}
          <Panel title={`${cfg.name.toUpperCase()} MARKET DRIVERS`}>
            <div style={{ padding: '12px 16px' }}>
              {cfg.drivers.map((driver, i) => (
                <div key={i} style={{
                  display: 'flex', alignItems: 'center', gap: 10,
                  padding: '6px 0', borderBottom: i < cfg.drivers.length - 1 ? '1px solid rgba(255,255,255,0.04)' : 'none'
                }}>
                  <div style={{
                    width: 6, height: 6, borderRadius: '50%', flexShrink: 0,
                    background: cfg.color, boxShadow: `0 0 4px ${cfg.color}80`,
                  }} />
                  <span style={{ fontSize: 13, color: 'var(--text-secondary)' }}>{driver}</span>
                </div>
              ))}
            </div>
          </Panel>

          {/* Gold/Silver ratio detail */}
          <Panel title="GOLD/SILVER RATIO ANALYSIS">
            <div style={{ padding: '12px 16px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                <div>
                  <div className="mono" style={{ fontSize: 28, fontWeight: 700, color: '#FFD700' }}>{ratio.ratio}x</div>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>Historical range: 65–90x</div>
                </div>
                <div style={{
                  padding: '6px 12px', borderRadius: 3, fontSize: 12, fontWeight: 700,
                  background: ratio.signal === 'BUY_SILVER' ? 'rgba(192,192,192,0.1)' : ratio.signal === 'BUY_GOLD' ? 'rgba(255,215,0,0.1)' : 'rgba(255,255,255,0.05)',
                  color: ratio.signal === 'BUY_SILVER' ? '#C0C0C0' : ratio.signal === 'BUY_GOLD' ? '#FFD700' : 'var(--text-muted)',
                  border: `1px solid ${ratio.signal === 'BUY_SILVER' ? 'rgba(192,192,192,0.3)' : ratio.signal === 'BUY_GOLD' ? 'rgba(255,215,0,0.3)' : 'var(--border)'}`,
                }}>
                  {ratio.signal.replace('_', ' ')}
                </div>
              </div>
              <div style={{ fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.6, padding: '8px 10px', background: 'rgba(255,255,255,0.03)', borderRadius: 3 }}>
                {ratio.interpretation}
              </div>

              {/* Ratio bar */}
              <div style={{ marginTop: 12 }}>
                <div style={{ height: 8, background: 'var(--border)', borderRadius: 4, position: 'relative', overflow: 'hidden' }}>
                  <div style={{ position: 'absolute', left: '36%', width: '33%', height: '100%', background: 'rgba(0,128,255,0.3)' }} />
                  <div style={{
                    position: 'absolute',
                    left: `${Math.min(95, Math.max(5, ((ratio.ratio - 50) / 60) * 100))}%`,
                    top: -2, width: 3, height: 12, background: '#FFD700', borderRadius: 1,
                    transform: 'translateX(-50%)',
                  }} />
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 9, color: 'var(--text-dim)', marginTop: 4 }}>
                  <span>50x Cheap Silver</span><span>Normal</span><span>100x Cheap Gold</span>
                </div>
              </div>
            </div>
          </Panel>

          {/* Position size calculator */}
          <Panel title="POSITION SIZE CALCULATOR">
            <div style={{ padding: '12px 16px' }}>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 12 }}>
                {[
                  ['Account Balance', `$${balance.toLocaleString()}`],
                  ['Risk per Trade', `${strategy.riskPct}% = $${riskUSD}`],
                  ['Stop Loss', `${strategy.slPips} pips`],
                  ['Pip Value/Lot', `$${cfg.pipValuePerLot}`],
                ].map(([label, val]) => (
                  <div key={label} style={{ padding: '8px 10px', background: 'rgba(0,0,0,0.2)', borderRadius: 3 }}>
                    <div style={{ fontSize: 10, color: 'var(--text-muted)', marginBottom: 3 }}>{label}</div>
                    <div className="mono" style={{ fontSize: 13, color: 'var(--text-secondary)' }}>{val}</div>
                  </div>
                ))}
              </div>

              <div style={{
                padding: '12px 14px', borderRadius: 3,
                background: cfg.bgColor, border: `1px solid ${cfg.borderColor}`,
                display: 'flex', justifyContent: 'space-between', alignItems: 'center'
              }}>
                <div>
                  <div style={{ fontSize: 11, color: cfg.dimColor, marginBottom: 4 }}>RECOMMENDED LOT SIZE</div>
                  <div className="mono" style={{ fontSize: 28, fontWeight: 700, color: cfg.color }}>{lotSize}</div>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>
                    = {(lotSize * cfg.lotSize).toFixed(0)} troy oz of {cfg.name}
                  </div>
                </div>
                <div style={{ textAlign: 'right', fontSize: 12, color: 'var(--text-muted)' }}>
                  <div>1 pip = ${(cfg.pipValuePerLot * lotSize).toFixed(2)}</div>
                  <div style={{ marginTop: 4 }}>TP target: ${(cfg.pipValuePerLot * lotSize * strategy.tpPips).toFixed(2)}</div>
                  <div style={{ color: '#ff6060', marginTop: 4 }}>SL risk: ${(cfg.pipValuePerLot * lotSize * strategy.slPips).toFixed(2)}</div>
                </div>
              </div>

              <div style={{
                marginTop: 10, padding: '8px 12px',
                background: 'rgba(255,184,0,0.06)', border: '1px solid rgba(255,184,0,0.2)',
                borderRadius: 3, fontSize: 11, color: '#c0a060',
              }}>
                💡 {cfg.tipNote}
              </div>
            </div>
          </Panel>
        </div>

        {/* Right: Analysis + Recommendation */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>

          {/* TF + Direction selectors */}
          <Panel title="TECHNICAL ANALYSIS">
            <div style={{ padding: '12px 16px 0' }}>
              <div style={{ display: 'flex', gap: 6, marginBottom: 10, flexWrap: 'wrap' }}>
                {['5m', '15m', '1H', '4H', 'Daily'].map(t => (
                  <button key={t} className={`tab-btn ${tf === t ? 'active' : ''}`}
                    onClick={() => setTf(t)} style={{ fontSize: 12 }}>{t}</button>
                ))}
              </div>
              <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
                <button className={`btn ${evalDir === 'BUY' ? 'btn-buy' : 'btn-ghost'}`}
                  onClick={() => setEvalDir('BUY')} style={{ flex: 1, padding: '7px' }}>▲ BUY</button>
                <button className={`btn ${evalDir === 'SELL' ? 'btn-sell' : 'btn-ghost'}`}
                  onClick={() => setEvalDir('SELL')} style={{ flex: 1, padding: '7px' }}>▼ SELL</button>
              </div>
            </div>

            {/* Indicator values */}
            {loadingInd ? (
              <div style={{ padding: '20px 16px', textAlign: 'center' }}><LoadingDots color={cfg.color} /></div>
            ) : indicators ? (
              <div style={{ padding: '0 16px 14px' }}>
                {[
                  ['EMA 20', `$${indicators.ema20?.toFixed(2)}`, indicators.emaCrossed ? cfg.color : '#ff3056'],
                  ['EMA 50', `$${indicators.ema50?.toFixed(2)}`, 'var(--text-secondary)'],
                  ['EMA Cross', indicators.emaCrossSignal, indicators.emaCrossSignal === 'BULLISH' ? '#00ff87' : indicators.emaCrossSignal === 'BEARISH' ? '#ff3056' : 'var(--text-muted)'],
                  ['RSI (14)', indicators.rsi, indicators.rsi > 70 ? '#ff3056' : indicators.rsi < 30 ? '#00ff87' : '#0080ff'],
                  ['MACD', indicators.macdHistogram > 0 ? 'BULLISH' : 'BEARISH', indicators.macdHistogram > 0 ? '#00ff87' : '#ff3056'],
                  ['ADX', `${indicators.adx} (${indicators.adxStrength})`, indicators.adx > 25 ? '#00ff87' : 'var(--text-muted)'],
                  ['BB Position', indicators.priceVsBB, cfg.color],
                ].map(([label, val, color]: any) => (
                  <div key={label} style={{
                    display: 'flex', justifyContent: 'space-between',
                    padding: '5px 0', borderBottom: '1px solid rgba(255,255,255,0.04)', fontSize: 13
                  }}>
                    <span style={{ color: 'var(--text-muted)' }}>{label}</span>
                    <span className="mono" style={{ color }}>{val}</span>
                  </div>
                ))}
              </div>
            ) : null}
          </Panel>

          {/* Analyze button */}
          <button
            className="btn"
            onClick={handleAnalyze}
            disabled={loadingRec || loadingInd || !indicators}
            style={{
              padding: '13px', fontSize: 15, letterSpacing: 2, width: '100%',
              background: `linear-gradient(135deg, ${cfg.dimColor}30, ${cfg.color}15)`,
              border: `1px solid ${cfg.borderColor}`,
              color: cfg.color,
              cursor: 'pointer',
            }}
          >
            {loadingRec ? <LoadingDots color={cfg.color} /> : `${cfg.emoji} ANALYZE ${cfg.name.toUpperCase()} WITH AI`}
          </button>

          {/* AI Recommendation */}
          {rec && (
            <div style={{
              background: `${recColor}0d`, border: `1px solid ${recColor}35`,
              borderRadius: 4, padding: 16
            }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                  <span style={{ fontSize: 28, fontWeight: 900, color: recColor, fontFamily: 'Rajdhani', letterSpacing: 2 }}>
                    {rec.direction}
                  </span>
                  <div>
                    <div className="mono" style={{ fontSize: 20, fontWeight: 700, color: recColor }}>{rec.confidence}%</div>
                    <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>CONFIDENCE</div>
                  </div>
                </div>
                <span className="mono" style={{ fontSize: 11, color: 'var(--text-muted)', background: 'var(--border)', padding: '3px 8px', borderRadius: 2 }}>
                  {rec.checklist_passed}/8 rules
                </span>
              </div>

              {/* Entry zone */}
              {rec.direction !== 'WAIT' && rec.entry_zone && (
                <div style={{ background: 'rgba(0,0,0,0.2)', borderRadius: 3, padding: '8px 12px', marginBottom: 12 }}>
                  <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>ENTRY ZONE </span>
                  <span className="mono" style={{ color: cfg.color }}>
                    ${rec.entry_zone.low?.toFixed(2)} — ${rec.entry_zone.high?.toFixed(2)}
                  </span>
                </div>
              )}

              {/* TP / SL / Lots */}
              {rec.direction !== 'WAIT' && (
                <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
                  {[
                    ['TP', `$${(currentPrice + strategy.tpPips * cfg.pipSize * (rec.direction === 'BUY' ? 1 : -1)).toFixed(2)}`, '#00c060'],
                    ['SL', `$${(currentPrice - strategy.slPips * cfg.pipSize * (rec.direction === 'BUY' ? 1 : -1)).toFixed(2)}`, '#c02040'],
                    ['LOTS', lotSize, cfg.color],
                    ['P/L per pip', `$${(cfg.pipValuePerLot * lotSize).toFixed(2)}`, '#60c0ff'],
                  ].map(([label, val, color]) => (
                    <div key={label} style={{ flex: 1, background: 'rgba(0,0,0,0.2)', borderRadius: 3, padding: '6px 8px' }}>
                      <div style={{ fontSize: 9, color: 'var(--text-muted)', letterSpacing: 1, marginBottom: 3 }}>{label}</div>
                      <div className="mono" style={{ fontSize: 12, color: color as string, fontWeight: 700 }}>{val}</div>
                    </div>
                  ))}
                </div>
              )}

              {/* Reasons */}
              <div style={{ marginBottom: 10 }}>
                {(rec.reasons || []).map((r: string, i: number) => (
                  <div key={i} style={{ display: 'flex', gap: 8, marginBottom: 5, fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.5 }}>
                    <span style={{ color: recColor, flexShrink: 0 }}>→</span><span>{r}</span>
                  </div>
                ))}
              </div>

              {/* Risk note */}
              <div style={{ fontSize: 12, color: '#e0a060', padding: '8px 10px', background: 'rgba(255,184,0,0.07)', borderRadius: 3, marginBottom: 12 }}>
                <strong>⚠ RISK: </strong>{rec.risk_note}
              </div>

              {/* Place order */}
              {rec.direction !== 'WAIT' && rec.checklist_passed >= 6 && (
                <button
                  className={`btn ${rec.direction === 'BUY' ? 'btn-buy' : 'btn-sell'}`}
                  onClick={handlePlaceOrder}
                  disabled={orderLoading}
                  style={{ width: '100%', padding: '12px', fontSize: 14, letterSpacing: 2 }}
                >
                  {orderLoading
                    ? <LoadingDots color={recColor} />
                    : `PLACE ${rec.direction} ${cfg.name.toUpperCase()} ORDER — ${lotSize} lots`}
                </button>
              )}
            </div>
          )}

          {/* Key levels */}
          <Panel title={`${cfg.name.toUpperCase()} KEY PRICE LEVELS`}>
            <div style={{ padding: '12px 16px' }}>
              {(selected === 'XAU/USD' ? [
                { level: '$2500', type: 'RESISTANCE', note: 'All-time high zone — major supply' },
                { level: '$2400', type: 'RESISTANCE', note: 'Recent highs — psychological level' },
                { level: '$2300', type: 'PIVOT', note: 'Current range midpoint' },
                { level: '$2200', type: 'SUPPORT', note: 'Previous breakout level' },
                { level: '$2000', type: 'SUPPORT', note: 'Major psychological — strong demand' },
                { level: '$1900', type: 'SUPPORT', note: 'Long-term bull market floor' },
              ] : [
                { level: '$32.00', type: 'RESISTANCE', note: 'Multi-year high resistance zone' },
                { level: '$30.00', type: 'RESISTANCE', note: 'Psychological round number' },
                { level: '$27.50', type: 'PIVOT', note: 'Current range midpoint' },
                { level: '$26.00', type: 'SUPPORT', note: 'Key demand zone' },
                { level: '$22.00', type: 'SUPPORT', note: 'Strong long-term support' },
              ]).map((lvl, i) => (
                <div key={i} style={{
                  display: 'flex', alignItems: 'center', gap: 10,
                  padding: '6px 0', borderBottom: '1px solid rgba(255,255,255,0.04)',
                }}>
                  <span className="mono" style={{
                    fontSize: 13, fontWeight: 700, width: 70,
                    color: lvl.type === 'RESISTANCE' ? '#ff6060' : lvl.type === 'SUPPORT' ? '#00c060' : cfg.color,
                  }}>{lvl.level}</span>
                  <span style={{
                    fontSize: 9, fontWeight: 700, letterSpacing: 1,
                    color: lvl.type === 'RESISTANCE' ? '#ff3056' : lvl.type === 'SUPPORT' ? '#00c060' : cfg.color,
                    background: lvl.type === 'RESISTANCE' ? 'rgba(255,48,86,0.1)' : lvl.type === 'SUPPORT' ? 'rgba(0,192,96,0.1)' : cfg.bgColor,
                    padding: '2px 6px', borderRadius: 2, flexShrink: 0,
                  }}>{lvl.type}</span>
                  <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{lvl.note}</span>
                </div>
              ))}
            </div>
          </Panel>
        </div>
      </div>
    </div>
  )
}
