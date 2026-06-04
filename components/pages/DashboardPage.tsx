'use client'
// components/pages/DashboardPage.tsx

import { useState } from 'react'
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts'
import { Panel, LiveDot, StatCard, LoadingDots } from '../ui'
import { authFetch } from '@/lib/api'
import type { PriceData } from '@/hooks/useForex'

const DIR_COLOR: Record<string, string> = { BUY: '#00ff87', SELL: '#ff3056' }

function formatPrice(pair: string, price: number): string {
  if (pair?.includes('JPY')) return price.toFixed(3)
  if (pair === 'XAU/USD') return price.toFixed(2)
  return price.toFixed(5)
}

interface DashboardProps {
  prices: Record<string, PriceData>
  account: any
  news: any
  trades: any[]
  onToast: (msg: string, color?: string) => void
  userId?: string
  onRefreshAccount?: () => void
  onRefreshTrades?: () => void
}

const PAGE_SIZE = 5

function Pager({ page, total, onPage }: { page: number; total: number; onPage: (p: number) => void }) {
  const pages = Math.ceil(total / PAGE_SIZE)
  if (pages <= 1) return null
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 10, padding: '8px 16px', borderTop: '1px solid var(--border)' }}>
      <button onClick={() => onPage(page - 1)} disabled={page === 0} className="btn btn-ghost" style={{ fontSize: 11, padding: '4px 12px' }}>← Prev</button>
      <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{page + 1} / {pages}</span>
      <button onClick={() => onPage(page + 1)} disabled={page >= pages - 1} className="btn btn-ghost" style={{ fontSize: 11, padding: '4px 12px' }}>Next →</button>
    </div>
  )
}

export default function DashboardPage({ prices, account, news, trades, onToast, userId, onRefreshAccount, onRefreshTrades }: DashboardProps) {
  const [closingId, setClosingId] = useState<string | null>(null)
  const [openPage, setOpenPage] = useState(0)
  const [closedPage, setClosedPage] = useState(0)

  // Real stats from actual trade records
  const today = new Date().toDateString()
  const closedTrades = trades.filter((t: any) => t.result && t.result !== 'OPEN')
  const openTrades = trades.filter((t: any) => t.result === 'OPEN')
  const todayClosedTrades = closedTrades.filter((t: any) => t.closed_at && new Date(t.closed_at).toDateString() === today)
  const todayPL = todayClosedTrades.reduce((s: number, t: any) => s + (t.pl_usd || 0), 0)
  const wins = closedTrades.filter((t: any) => t.result === 'WIN').length
  const winRate = closedTrades.length ? Math.round((wins / closedTrades.length) * 100) : 0

  // Equity curve from actual closed trades (last 30)
  const equityData = (() => {
    const initial = account?.balance || 0
    if (!initial || closedTrades.length === 0) return []
    const sorted = [...closedTrades].sort((a, b) => new Date(a.closed_at).getTime() - new Date(b.closed_at).getTime())
    let bal = initial
    // Subtract all closed P/L to get starting point
    const totalPL = sorted.reduce((s: number, t: any) => s + (t.pl_usd || 0), 0)
    bal = initial - totalPL
    return sorted.map((t, i) => {
      bal += t.pl_usd || 0
      return {
        day: new Date(t.closed_at).toLocaleDateString('en', { month: 'short', day: 'numeric' }),
        balance: +bal.toFixed(2),
        i,
      }
    })
  })()

  async function handleClose(tradeId: string, pair: string, direction: string) {
    setClosingId(tradeId)
    try {
      const res = await authFetch('/api/close-trade', {
        method: 'POST',
        body: JSON.stringify({ tradeId, userId, pair, direction }),
      })
      const data = await res.json()
      if (data.success) {
        onToast(`Closed: ${pair} ${direction}`, '#00ff87')
        // Immediately refresh both balance and trades so dashboard reflects the close
        onRefreshTrades?.()
        setTimeout(() => onRefreshAccount?.(), 1500) // slight delay — broker needs a moment to settle
      } else {
        onToast('Close failed: ' + (data.error || 'Unknown'), '#ff3056')
      }
    } catch (e: any) {
      onToast('Close error: ' + e.message, '#ff3056')
    } finally {
      setClosingId(null)
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>

      {/* News alert */}
      {news?.hasHighImpactInWindow && news.events.filter((e: any) => e.isInWindow).map((evt: any, i: number) => (
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
      <div className="stat-card-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))', gap: 10 }}>
        <StatCard
          label="BALANCE"
          value={account?.balance ? `$${account.balance.toLocaleString('en', { minimumFractionDigits: 2 })}` : account === null ? '…' : 'Not synced'}
          color={account?.balance ? '#60c0ff' : '#ffb800'}
        />
        <StatCard
          label="TODAY P/L"
          value={`${todayPL >= 0 ? '+' : ''}$${todayPL.toFixed(2)}`}
          color={todayPL > 0 ? '#00ff87' : todayPL < 0 ? '#ff3056' : '#607080'}
        />
        <StatCard
          label="OPEN TRADES"
          value={openTrades.length}
          color={openTrades.length > 0 ? '#ffb800' : '#607080'}
        />
        <StatCard
          label="WIN RATE"
          value={closedTrades.length ? `${winRate}%` : '—'}
          color={winRate > 55 ? '#00ff87' : winRate > 0 ? '#ff6060' : '#607080'}
        />
        <StatCard
          label="TOTAL TRADES"
          value={closedTrades.length || '—'}
          color="#607080"
        />
      </div>

      {/* Live prices */}
      {Object.keys(prices).length > 0 && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))', gap: 10 }}>
          {Object.entries(prices).slice(0, 6).map(([pair, d]) => (
            <div key={pair} className="panel-bright" style={{ padding: '10px 14px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                <span style={{ fontWeight: 700, fontSize: 12, color: '#90b0d0' }}>{pair}</span>
                <span style={{ fontSize: 10, color: d.trend === 'up' ? '#00ff87' : '#ff3056' }}>
                  {d.trend === 'up' ? '▲' : '▼'}
                </span>
              </div>
              <div className="mono" style={{
                fontSize: 18, fontWeight: 700,
                color: d.trend === 'up' ? '#00ff87' : d.trend === 'down' ? '#ff3056' : '#c0d0e0',
              }}>
                {formatPrice(pair, d.bid)}
              </div>
              <div style={{ fontSize: 10, color: 'var(--text-dim)', marginTop: 3 }}>
                ASK {formatPrice(pair, d.ask)}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Open positions from trades table */}
      <Panel
        title={`OPEN POSITIONS${openTrades.length ? ` (${openTrades.length})` : ''}`}
        badge={<LiveDot />}
        bright
      >
        {openTrades.length === 0 ? (
          <div style={{ padding: '16px 20px', fontSize: 13, color: 'var(--text-muted)', textAlign: 'center' }}>
            No open positions — trades you place will appear here
          </div>
        ) : (
          <>
            <div style={{ overflowX: 'auto' }}>
              <table>
                <thead>
                  <tr><th>PAIR</th><th>DIR</th><th>LOTS</th><th className="hide-mobile">ENTRY</th><th className="hide-mobile">TP</th><th className="hide-mobile">SL</th><th>ACTION</th></tr>
                </thead>
                <tbody>
                  {openTrades.slice(openPage * PAGE_SIZE, (openPage + 1) * PAGE_SIZE).map((pos: any) => {
                    const dp = pos.pair?.includes('JPY') ? 3 : pos.pair === 'XAU/USD' ? 2 : 5
                    return (
                      <tr key={pos.id}>
                        <td className="mono" style={{ color: '#90b0d0', fontWeight: 600 }}>{pos.pair}</td>
                        <td>
                          <span style={{ color: DIR_COLOR[pos.direction] || '#ffb800', fontWeight: 700, fontSize: 12 }}>
                            {pos.direction}
                          </span>
                        </td>
                        <td className="mono" style={{ fontSize: 12 }}>{pos.lots?.toFixed(2) ?? '—'}</td>
                        <td className="mono hide-mobile" style={{ color: 'var(--text-muted)', fontSize: 12 }}>
                          {pos.entry_price ? pos.entry_price.toFixed(dp) : '—'}
                        </td>
                        <td className="mono hide-mobile" style={{ color: '#00c060', fontSize: 12 }}>
                          {pos.tp_price ? pos.tp_price.toFixed(dp) : '—'}
                        </td>
                        <td className="mono hide-mobile" style={{ color: '#ff6060', fontSize: 12 }}>
                          {pos.sl_price ? pos.sl_price.toFixed(dp) : '—'}
                        </td>
                        <td>
                          <button
                            className="btn btn-danger"
                            onClick={() => handleClose(pos.oanda_trade_id || pos.id, pos.pair, pos.direction)}
                            disabled={closingId === (pos.oanda_trade_id || pos.id)}
                            style={{ fontSize: 11, padding: '4px 10px' }}
                          >
                            {closingId === (pos.oanda_trade_id || pos.id) ? <LoadingDots /> : 'CLOSE'}
                          </button>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
            <Pager page={openPage} total={openTrades.length} onPage={setOpenPage} />
          </>
        )}
      </Panel>

      {/* Equity curve — only when we have data */}
      {equityData.length >= 2 && (
        <Panel title="EQUITY CURVE">
          <div style={{ padding: '12px 4px 8px' }}>
            <ResponsiveContainer width="100%" height={140}>
              <LineChart data={equityData} margin={{ top: 4, right: 16, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="2 6" stroke="#0d1e30" />
                <XAxis dataKey="day" tick={{ fill: '#405060', fontSize: 9 }} interval="preserveStartEnd" />
                <YAxis domain={['auto', 'auto']} tick={{ fill: '#405060', fontSize: 9 }} width={64}
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
      )}

      {/* Recent trades */}
      {closedTrades.length > 0 ? (
        <Panel title={`RECENT TRADES${closedTrades.length ? ` (${closedTrades.length})` : ''}`}>
          {(() => {
            const sorted = [...closedTrades].sort((a, b) => new Date(b.closed_at || b.opened_at).getTime() - new Date(a.closed_at || a.opened_at).getTime())
            const page = sorted.slice(closedPage * PAGE_SIZE, (closedPage + 1) * PAGE_SIZE)
            return (
              <>
                <div style={{ overflowX: 'auto' }}>
                  <table>
                    <thead>
                      <tr><th>DATE</th><th>PAIR</th><th>DIR</th><th>LOTS</th><th>P/L</th><th>RESULT</th></tr>
                    </thead>
                    <tbody>
                      {page.map((t: any) => (
                        <tr key={t.id}>
                          <td style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                            {t.closed_at ? new Date(t.closed_at).toLocaleDateString('en', { day: 'numeric', month: 'short' }) : '—'}
                          </td>
                          <td className="mono" style={{ color: '#90b0d0' }}>{t.pair}</td>
                          <td>
                            <span style={{ color: DIR_COLOR[t.direction] || '#ffb800', fontWeight: 700, fontSize: 12 }}>
                              {t.direction}
                            </span>
                          </td>
                          <td className="mono" style={{ fontSize: 12, color: 'var(--text-muted)' }}>{t.lots?.toFixed(2) ?? '—'}</td>
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
                <Pager page={closedPage} total={closedTrades.length} onPage={setClosedPage} />
              </>
            )
          })()}
        </Panel>
      ) : (
        <Panel title="RECENT TRADES">
          <div style={{ padding: '24px 20px', textAlign: 'center', color: 'var(--text-muted)', fontSize: 13 }}>
            No closed trades yet — trades placed through the app will appear here
          </div>
        </Panel>
      )}

    </div>
  )
}
