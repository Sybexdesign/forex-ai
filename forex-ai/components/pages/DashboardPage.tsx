'use client'
// components/pages/DashboardPage.tsx

import { useState } from 'react'
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts'
import { Panel, SignalBadge, StrengthBar, LiveDot, StatCard } from '../ui'
import type { PriceData } from '@/hooks/useForex'

const PAIRS = ['EUR/USD', 'GBP/USD', 'USD/JPY', 'AUD/USD', 'XAU/USD']

const PAIR_SIGNALS: Record<string, string> = {
  'EUR/USD': 'BUY', 'GBP/USD': 'WAIT', 'USD/JPY': 'STRONG BUY',
  'AUD/USD': 'SELL', 'XAU/USD': 'WAIT'
}
const PAIR_STRENGTH: Record<string, number> = {
  'EUR/USD': 72, 'GBP/USD': 58, 'USD/JPY': 81, 'AUD/USD': 63, 'XAU/USD': 55
}

const SIGNAL_COLORS: Record<string, string> = {
  'STRONG BUY': '#00ff87', 'BUY': '#4dffb4',
  'WAIT': '#ffb800', 'SELL': '#ff6b6b', 'STRONG SELL': '#ff3056'
}

function formatPrice(pair: string, price: number): string {
  if (pair === 'USD/JPY') return price.toFixed(3)
  if (pair === 'XAU/USD') return price.toFixed(2)
  return price.toFixed(5)
}

function formatSpread(pair: string, spread: number): string {
  if (pair === 'XAU/USD') return spread.toFixed(1)
  if (pair === 'USD/JPY') return (spread * 100).toFixed(1) + 'p'
  return (spread * 10000).toFixed(1) + 'p'
}

// Simulated 30-day equity curve
const equityData = (() => {
  let bal = 10000
  return Array.from({ length: 30 }, (_, i) => {
    bal += (Math.random() - 0.42) * 180
    return { day: `D${i + 1}`, balance: +bal.toFixed(2) }
  })
})()

interface DashboardProps {
  prices: Record<string, PriceData>
  account: any
  news: any
  trades: any[]
  onToast: (msg: string, color?: string) => void
}

export default function DashboardPage({ prices, account, news, trades, onToast }: DashboardProps) {
  const [closingId, setClosingId] = useState<string | null>(null)

  const openPositions = [
    { id: 'pos1', pair: 'EUR/USD', dir: 'BUY',  entry: 1.0831, lots: 0.10, tp: 1.0881, sl: 1.0806 },
    { id: 'pos2', pair: 'GBP/USD', dir: 'SELL', entry: 1.2731, lots: 0.05, tp: 1.2681, sl: 1.2756 },
  ]

  const wins = trades.filter((t: any) => t.result === 'WIN').length
  const winRate = trades.length ? Math.round((wins / trades.length) * 100) : 0
  const todayPL = trades.slice(-3).reduce((s: number, t: any) => s + (t.pl_usd || 0), 0)

  async function handleClose(id: string, pair: string) {
    setClosingId(id)
    await new Promise(r => setTimeout(r, 600))
    setClosingId(null)
    onToast(`Position closed: ${pair}`, '#ffb800')
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>

      {/* News alert */}
      {news.hasHighImpactInWindow && news.events.filter((e: any) => e.isInWindow).map((evt: any, i: number) => (
        <div key={i} style={{
          background: 'rgba(255,48,0,0.08)', border: '1px solid rgba(255,48,0,0.3)',
          borderRadius: 3, padding: '10px 16px',
          display: 'flex', alignItems: 'center', gap: 12, fontSize: 13
        }}>
          <span className="blink" style={{ fontSize: 18, color: '#ff3c00' }}>⚠</span>
          <div>
            <strong style={{ color: '#ff8060' }}>HIGH-IMPACT EVENT: </strong>
            <span style={{ color: '#c0a090' }}>{evt.title}</span>
            {' '}in{' '}
            <span className="mono" style={{ color: '#ffb800', fontWeight: 700 }}>{evt.minutesAway}min</span>
            <span style={{ color: '#806050' }}> — Trading paused per risk rules</span>
          </div>
        </div>
      ))}

      {/* Account stats */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: 10 }}>
        <StatCard label="BALANCE" value={`$${(account?.balance || 10284.50).toLocaleString('en', { minimumFractionDigits: 2 })}`} color="#60c0ff" />
        <StatCard label="TODAY P/L" value={`${todayPL >= 0 ? '+' : ''}$${todayPL.toFixed(2)}`} color={todayPL >= 0 ? '#00ff87' : '#ff3056'} />
        <StatCard label="OPEN POSITIONS" value={account?.openTradeCount ?? 2} color="#ffb800" />
        <StatCard label="WIN RATE" value={`${winRate}%`} color={winRate > 55 ? '#00ff87' : '#ff6060'} />
        <StatCard label="DAILY RISK USED" value="1.2% / 3%" color="#607080" />
      </div>

      {/* Signal cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(215px, 1fr))', gap: 12 }}>
        {PAIRS.map(pair => {
          const d = prices[pair]
          const signal = PAIR_SIGNALS[pair]
          const strength = PAIR_STRENGTH[pair]
          const sigColor = SIGNAL_COLORS[signal] || '#ffb800'
          const isUp = d?.trend === 'up'
          return (
            <div key={pair} className="panel-bright" style={{ padding: 14 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
                <span style={{ fontWeight: 700, fontSize: 14, color: '#90b0d0', letterSpacing: 0.5 }}>{pair}</span>
                <SignalBadge signal={signal} />
              </div>
              <div style={{ marginBottom: 8 }}>
                <span className="mono" style={{
                  fontSize: 24, fontWeight: 700,
                  color: d?.trend === 'up' ? '#00ff87' : d?.trend === 'down' ? '#ff3056' : '#c0d0e0',
                  letterSpacing: -0.5,
                }}>
                  {d ? formatPrice(pair, d.bid) : '—'}
                </span>
                {d && <span style={{ marginLeft: 6, fontSize: 16, color: isUp ? '#00ff87' : '#ff3056' }}>{isUp ? '▲' : '▼'}</span>}
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: 'var(--text-muted)', marginBottom: 4 }}>
                <span>ASK: <span className="mono" style={{ color: '#607080' }}>{d ? formatPrice(pair, d.ask) : '—'}</span></span>
                <span>SPREAD: <span className="mono">{d ? formatSpread(pair, d.spread) : '—'}</span></span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: 'var(--text-muted)' }}>
                <span>STRENGTH</span>
                <span className="mono" style={{ color: sigColor }}>{strength}%</span>
              </div>
              <StrengthBar value={strength} color={sigColor} />
            </div>
          )
        })}
      </div>

      {/* Open positions */}
      <Panel
        title="OPEN POSITIONS"
        badge={
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <LiveDot />
            <span className="mono" style={{ fontSize: 11, color: 'var(--text-muted)' }}>
              {openPositions.length} / 2 MAX
            </span>
          </div>
        }
        bright
      >
        <div style={{ overflowX: 'auto' }}>
          <table>
            <thead>
              <tr>
                <th>PAIR</th><th>DIR</th><th>ENTRY</th><th>CURRENT</th>
                <th>FLOAT P/L</th><th>LOTS</th><th>TP</th><th>SL</th><th>ACTION</th>
              </tr>
            </thead>
            <tbody>
              {openPositions.map(pos => {
                const cur = prices[pos.pair]?.bid || pos.entry
                const pip = pos.pair === 'USD/JPY' ? 0.01 : pos.pair === 'XAU/USD' ? 0.1 : 0.0001
                const diff = pos.dir === 'BUY' ? cur - pos.entry : pos.entry - cur
                const pl = +(diff / pip * pos.lots * 10).toFixed(2)
                const isProfit = pl >= 0
                return (
                  <tr key={pos.id}>
                    <td className="mono" style={{ color: '#90b0d0', fontWeight: 600 }}>{pos.pair}</td>
                    <td>
                      <span style={{
                        color: pos.dir === 'BUY' ? '#00ff87' : '#ff3056',
                        fontWeight: 700, fontSize: 12
                      }}>{pos.dir}</span>
                    </td>
                    <td className="mono" style={{ color: 'var(--text-muted)', fontSize: 12 }}>{pos.entry.toFixed(5)}</td>
                    <td className="mono" style={{ color: isProfit ? '#00ff87' : '#ff3056', fontSize: 12 }}>{cur.toFixed(5)}</td>
                    <td className="mono" style={{ color: isProfit ? '#00ff87' : '#ff3056', fontWeight: 700 }}>
                      {isProfit ? '+' : ''}${pl.toFixed(2)}
                    </td>
                    <td className="mono" style={{ color: 'var(--text-muted)', fontSize: 12 }}>{pos.lots}</td>
                    <td className="mono" style={{ color: '#00c060', fontSize: 12 }}>{pos.tp.toFixed(5)}</td>
                    <td className="mono" style={{ color: '#ff6060', fontSize: 12 }}>{pos.sl.toFixed(5)}</td>
                    <td>
                      <button
                        className="btn btn-danger"
                        onClick={() => handleClose(pos.id, pos.pair)}
                        disabled={closingId === pos.id}
                      >
                        {closingId === pos.id ? '...' : 'CLOSE'}
                      </button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </Panel>

      {/* Equity chart */}
      <Panel title="30-DAY EQUITY CURVE">
        <div style={{ padding: '12px 4px 8px' }}>
          <ResponsiveContainer width="100%" height={140}>
            <LineChart data={equityData} margin={{ top: 4, right: 16, left: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="2 6" stroke="#0d1e30" />
              <XAxis dataKey="day" tick={{ fill: '#405060', fontSize: 9 }} interval={4} />
              <YAxis domain={['auto', 'auto']} tick={{ fill: '#405060', fontSize: 9 }} width={56}
                tickFormatter={(v) => `$${v.toLocaleString()}`} />
              <Tooltip
                contentStyle={{ background: '#0a1628', border: '1px solid #1a2940', borderRadius: 3, fontSize: 12 }}
                labelStyle={{ color: '#607080' }}
                formatter={(v: any) => [`$${Number(v).toFixed(2)}`, 'Balance']}
                itemStyle={{ color: '#00ff87' }}
              />
              <Line type="monotone" dataKey="balance" stroke="#0080ff" strokeWidth={2} dot={false}
                activeDot={{ r: 3, fill: '#0080ff' }} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </Panel>

      {/* Recent trades */}
      {trades.length > 0 && (
        <Panel title="RECENT TRADES">
          <div style={{ overflowX: 'auto' }}>
            <table>
              <thead>
                <tr><th>DATE</th><th>PAIR</th><th>DIR</th><th>PIPS</th><th>P/L</th><th>RESULT</th></tr>
              </thead>
              <tbody>
                {trades.slice(0, 5).map((t: any) => (
                  <tr key={t.id}>
                    <td style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                      {new Date(t.opened_at || t.date).toLocaleDateString()}
                    </td>
                    <td className="mono" style={{ color: '#90b0d0' }}>{t.pair}</td>
                    <td><span style={{ color: t.direction === 'BUY' ? '#00ff87' : '#ff3056', fontWeight: 700, fontSize: 12 }}>{t.direction}</span></td>
                    <td className="mono" style={{ color: (t.pips ?? 0) >= 0 ? '#00ff87' : '#ff6060' }}>
                      {(t.pips ?? 0) >= 0 ? '+' : ''}{t.pips ?? '—'}
                    </td>
                    <td className="mono" style={{ color: (t.pl_usd ?? 0) >= 0 ? '#00ff87' : '#ff6060', fontWeight: 700 }}>
                      {(t.pl_usd ?? 0) >= 0 ? '+' : ''}${(t.pl_usd ?? 0).toFixed(2)}
                    </td>
                    <td>
                      <span style={{
                        fontSize: 11, fontWeight: 700,
                        color: t.result === 'WIN' ? '#00ff87' : t.result === 'LOSS' ? '#ff3056' : '#ffb800'
                      }}>
                        {t.result}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
      )}
    </div>
  )
}
