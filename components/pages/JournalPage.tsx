'use client'
// components/pages/JournalPage.tsx

import { useState, useMemo } from 'react'
import {
  LineChart, Line, BarChart, Bar, XAxis, YAxis,
  CartesianGrid, Tooltip, ResponsiveContainer, Cell
} from 'recharts'
import { Panel, StatCard, DirectionBadge } from '../ui'
import { authFetch } from '@/lib/api'
import { currencySymbol } from '@/lib/currency'


interface JournalPageProps { trades: any[]; userId?: string; onTradeAdded?: () => void; account?: any }

const CUSTOM_TOOLTIP = {
  contentStyle: { background: '#0a1628', border: '1px solid #1a2940', borderRadius: 3, fontSize: 12 },
  labelStyle: { color: '#607080' },
}

export default function JournalPage({ trades, userId, onTradeAdded, account }: JournalPageProps) {
  const [filter, setFilter] = useState<'ALL' | 'WIN' | 'LOSS'>('ALL')
  const [pairFilter, setPairFilter] = useState('ALL')
  const [showAddModal, setShowAddModal] = useState(false)
  const [note, setNote] = useState<Record<string, string>>({})

  // ─── Stats ───────────────────────────────────────────────────────────────

  const closedTrades = trades.filter(t => t.result && t.result !== 'OPEN')
  const wins = closedTrades.filter(t => t.result === 'WIN')
  const losses = closedTrades.filter(t => t.result === 'LOSS')
  const winRate = closedTrades.length ? (wins.length / closedTrades.length * 100).toFixed(1) : '0'
  const grossProfit = wins.reduce((s: number, t: any) => s + Math.max(0, t.pl_usd || 0), 0)
  const grossLoss = Math.abs(losses.reduce((s: number, t: any) => s + Math.min(0, t.pl_usd || 0), 0))
  const profitFactor = grossLoss > 0 ? (grossProfit / grossLoss).toFixed(2) : '∞'
  const avgWinPips = wins.length ? (wins.reduce((s: number, t: any) => s + (t.pips || 0), 0) / wins.length).toFixed(1) : '0'
  const avgLossPips = losses.length ? (Math.abs(losses.reduce((s: number, t: any) => s + (t.pips || 0), 0)) / losses.length).toFixed(1) : '0'

  // Rules-followed analysis
  const rulesFollowed = closedTrades.filter(t => t.rules_followed)
  const rulesBroken = closedTrades.filter(t => !t.rules_followed)
  const rulesWinRate = rulesFollowed.length
    ? (rulesFollowed.filter(t => t.result === 'WIN').length / rulesFollowed.length * 100).toFixed(0)
    : '0'
  const brokenWinRate = rulesBroken.length
    ? (rulesBroken.filter(t => t.result === 'WIN').length / rulesBroken.length * 100).toFixed(0)
    : '0'

  // Pair stats
  const pairStats = useMemo(() => {
    const map: Record<string, { wins: number; losses: number; pl: number }> = {}
    closedTrades.forEach((t: any) => {
      if (!map[t.pair]) map[t.pair] = { wins: 0, losses: 0, pl: 0 }
      if (t.result === 'WIN') map[t.pair].wins++
      if (t.result === 'LOSS') map[t.pair].losses++
      map[t.pair].pl += t.pl_usd || 0
    })
    return Object.entries(map).map(([pair, s]) => ({ pair: pair.replace('/', ''), ...s }))
  }, [closedTrades])

  const bestPair = pairStats.sort((a, b) => b.pl - a.pl)[0]?.pair || '—'
  const worstPair = [...pairStats].sort((a, b) => a.pl - b.pl)[0]?.pair || '—'

  // Win/loss by day of week
  const dayStats = useMemo(() => {
    const days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri']
    const map: Record<string, { wins: number; losses: number }> = {}
    days.forEach(d => { map[d] = { wins: 0, losses: 0 } })
    closedTrades.forEach((t: any) => {
      const d = new Date(t.opened_at || Date.now()).toLocaleDateString('en', { weekday: 'short' })
      if (map[d]) {
        if (t.result === 'WIN') map[d].wins++
        else if (t.result === 'LOSS') map[d].losses++
      }
    })
    return days.map(d => ({ day: d, ...map[d] }))
  }, [closedTrades])

  // Equity curve
  const equityCurve = useMemo(() => {
    const totalPL = closedTrades.reduce((s: number, t: any) => s + (t.pl_usd || 0), 0)
    let bal = (account?.balance ?? 10000) - totalPL
    return [...closedTrades]
      .sort((a, b) => new Date(a.opened_at || 0).getTime() - new Date(b.opened_at || 0).getTime())
      .map((t: any, i) => {
        bal += t.pl_usd || 0
        return { trade: i + 1, balance: +bal.toFixed(2), pl: t.pl_usd }
      })
  }, [closedTrades])

  // Consecutive streaks
  const streaks = useMemo(() => {
    let maxWin = 0, maxLoss = 0, curWin = 0, curLoss = 0
    closedTrades.forEach((t: any) => {
      if (t.result === 'WIN') { curWin++; curLoss = 0; maxWin = Math.max(maxWin, curWin) }
      else { curLoss++; curWin = 0; maxLoss = Math.max(maxLoss, curLoss) }
    })
    return { maxWin, maxLoss }
  }, [closedTrades])

  // Filtered trades for table
  const availablePairs = ['ALL', ...Array.from(new Set(trades.map((t: any) => t.pair)))]
  const filteredTrades = trades
    .filter(t => filter === 'ALL' || t.result === filter)
    .filter(t => pairFilter === 'ALL' || t.pair === pairFilter)

  // CSV Export
  function exportCSV() {
    const headers = 'ID,Date,Pair,Direction,Entry,Exit,Pips,P/L($),Result,Rules,AI Confidence,Notes\n'
    const rows = trades.map((t: any) =>
      `${t.id},${new Date(t.opened_at || '').toLocaleDateString()},${t.pair},${t.direction},${t.entry_price || t.entry},${t.exit_price || t.exit || ''},${t.pips || ''},${t.pl_usd || ''},${t.result || ''},${t.rules_followed ? 'YES' : 'NO'},${t.ai_confidence || ''},"${t.notes || ''}"`
    ).join('\n')
    const blob = new Blob([headers + rows], { type: 'text/csv' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url; a.download = `forex-journal-${new Date().toISOString().split('T')[0]}.csv`
    a.click(); URL.revokeObjectURL(url)
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>

      {/* Stats grid */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))', gap: 10 }}>
        <StatCard label="TOTAL TRADES"   value={closedTrades.length}                color="#60c0ff" />
        <StatCard label="WIN RATE"        value={`${winRate}%`}                      color={+winRate > 55 ? '#00ff87' : '#ff6060'} />
        <StatCard label="PROFIT FACTOR"  value={profitFactor}                        color={+profitFactor > 1.5 ? '#00ff87' : '#ffb800'} />
        <StatCard label="AVG WIN PIPS"   value={`+${avgWinPips}p`}                  color="#00ff87" />
        <StatCard label="AVG LOSS PIPS"  value={`-${avgLossPips}p`}                 color="#ff6060" />
        <StatCard label="BEST PAIR"      value={bestPair}                            color="#00ff87" />
        <StatCard label="WORST PAIR"     value={worstPair}                           color="#ff6060" />
        <StatCard label="WIN STREAK"     value={`${streaks.maxWin}×`}               color="#00ff87" />
        <StatCard label="LOSS STREAK"    value={`${streaks.maxLoss}×`}              color="#ff6060" />
      </div>

      {/* Rules insight */}
      <Panel title="DISCIPLINE INSIGHT — RULES FOLLOWED VS BROKEN">
        <div style={{ padding: '14px 16px', display: 'flex', gap: 16, flexWrap: 'wrap' }}>
          <div style={{ flex: 1, minWidth: 200 }}>
            <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 8 }}>
              When rules are followed ({rulesFollowed.length} trades)
            </div>
            <div style={{ height: 8, background: 'var(--border)', borderRadius: 4, marginBottom: 6 }}>
              <div style={{
                width: rulesWinRate + '%', height: '100%',
                background: '#00ff87', borderRadius: 4,
                boxShadow: '0 0 8px rgba(0,255,135,0.4)',
              }} />
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>Win rate</span>
              <span className="mono" style={{ fontSize: 18, color: '#00ff87', fontWeight: 700 }}>{rulesWinRate}%</span>
            </div>
          </div>
          <div style={{ width: 1, background: 'var(--border)', flexShrink: 0 }} />
          <div style={{ flex: 1, minWidth: 200 }}>
            <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 8 }}>
              When rules are broken ({rulesBroken.length} trades)
            </div>
            <div style={{ height: 8, background: 'var(--border)', borderRadius: 4, marginBottom: 6 }}>
              <div style={{
                width: brokenWinRate + '%', height: '100%',
                background: '#ff3056', borderRadius: 4,
              }} />
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>Win rate</span>
              <span className="mono" style={{ fontSize: 18, color: '#ff3056', fontWeight: 700 }}>{brokenWinRate}%</span>
            </div>
          </div>
          <div style={{
            flex: 1, minWidth: 200, padding: '10px 14px',
            background: 'rgba(0,128,255,0.06)', border: '1px solid rgba(0,128,255,0.15)', borderRadius: 3
          }}>
            <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 6 }}>KEY INSIGHT</div>
            <div style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.6 }}>
              Following the rules gives you a{' '}
              <span style={{ color: '#00ff87', fontWeight: 700 }}>
                +{Math.max(0, +rulesWinRate - +brokenWinRate)}%
              </span>{' '}
              higher win rate. Discipline is your edge.
            </div>
          </div>
        </div>
      </Panel>

      {/* Charts */}
      <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr', gap: 12 }}>
        {/* Equity curve */}
        <Panel title="EQUITY CURVE (ALL TRADES)">
          <div style={{ padding: '8px 4px 12px' }}>
            <ResponsiveContainer width="100%" height={160}>
              <LineChart data={equityCurve} margin={{ top: 4, right: 16, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="2 6" stroke="#0d1e30" />
                <XAxis dataKey="trade" tick={{ fill: '#405060', fontSize: 9 }}
                  label={{ value: 'Trade #', position: 'insideBottom', fill: '#405060', fontSize: 9 }} />
                <YAxis domain={['auto', 'auto']} tick={{ fill: '#405060', fontSize: 9 }} width={60}
                  tickFormatter={(v) => `${currencySymbol(account?.currency)}${v.toLocaleString()}`} />
                <Tooltip {...CUSTOM_TOOLTIP}
                  formatter={(v: any, n?: any) => [`${currencySymbol(account?.currency)}${Number(v).toFixed(2)}`, n === 'balance' ? 'Balance' : n]}
                  itemStyle={{ color: '#0080ff' }}
                />

                <Line type="monotone" dataKey="balance" stroke="#0080ff" strokeWidth={2} dot={false}
                  activeDot={{ r: 4, fill: '#0080ff', stroke: '#002040', strokeWidth: 2 }} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </Panel>

        {/* Win/loss by day */}
        <Panel title="BY DAY OF WEEK">
          <div style={{ padding: '8px 4px 12px' }}>
            <ResponsiveContainer width="100%" height={160}>
              <BarChart data={dayStats} barGap={2} margin={{ top: 4, right: 8, left: -20, bottom: 0 }}>
                <CartesianGrid strokeDasharray="2 6" stroke="#0d1e30" />
                <XAxis dataKey="day" tick={{ fill: '#405060', fontSize: 9 }} />
                <YAxis tick={{ fill: '#405060', fontSize: 9 }} />
                <Tooltip {...CUSTOM_TOOLTIP} />
                <Bar dataKey="wins" name="Wins" fill="#00ff87" opacity={0.8} radius={[2, 2, 0, 0]} />
                <Bar dataKey="losses" name="Losses" fill="#ff3056" opacity={0.7} radius={[2, 2, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Panel>

        {/* Win/loss by pair */}
        <Panel title="BY PAIR">
          <div style={{ padding: '8px 4px 12px' }}>
            <ResponsiveContainer width="100%" height={160}>
              <BarChart data={pairStats} barGap={2} margin={{ top: 4, right: 8, left: -20, bottom: 0 }}>
                <CartesianGrid strokeDasharray="2 6" stroke="#0d1e30" />
                <XAxis dataKey="pair" tick={{ fill: '#405060', fontSize: 8 }} />
                <YAxis tick={{ fill: '#405060', fontSize: 9 }} />
                <Tooltip {...CUSTOM_TOOLTIP} />
                <Bar dataKey="wins" name="Wins" fill="#0080ff" opacity={0.85} radius={[2, 2, 0, 0]} />
                <Bar dataKey="losses" name="Losses" fill="#ff6b6b" opacity={0.7} radius={[2, 2, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Panel>
      </div>

      {/* Trade table */}
      <Panel
        title={`TRADE HISTORY (${filteredTrades.length} shown)`}
        badge={
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            {/* Filters */}
            <select
              value={pairFilter}
              onChange={e => setPairFilter(e.target.value)}
              style={{
                background: '#060e1c', border: '1px solid var(--border)', color: 'var(--text-secondary)',
                padding: '3px 8px', borderRadius: 3, fontSize: 12, fontFamily: 'JetBrains Mono', cursor: 'pointer'
              }}
            >
              {availablePairs.map(p => <option key={p} value={p}>{p}</option>)}
            </select>
            {(['ALL', 'WIN', 'LOSS'] as const).map(f => (
              <button key={f} className={`tab-btn ${filter === f ? 'active' : ''}`}
                onClick={() => setFilter(f)} style={{ fontSize: 11, padding: '3px 10px' }}>{f}</button>
            ))}
            <button className="btn btn-ghost" onClick={exportCSV} style={{ fontSize: 11, padding: '4px 12px' }}>
              ↓ CSV
            </button>
            <button className="btn btn-primary" onClick={() => setShowAddModal(true)} style={{ fontSize: 11, padding: '4px 12px' }}>
              + ADD TRADE
            </button>
          </div>
        }
      >
        <div style={{ overflowX: 'auto', maxHeight: 400, overflowY: 'auto' }}>
          <table>
            <thead>
              <tr>
                <th>#</th><th>DATE</th><th>PAIR</th><th>DIR</th>
                <th>ENTRY</th><th>EXIT</th><th>PIPS</th><th>P/L $</th>
                <th>RESULT</th><th>RULES</th><th>AI%</th><th>NOTES</th>
              </tr>
            </thead>
            <tbody>
              {filteredTrades.length === 0 && (
                <tr>
                  <td colSpan={12} style={{ textAlign: 'center', padding: 24, color: 'var(--text-muted)' }}>
                    No trades found for the selected filters
                  </td>
                </tr>
              )}
              {filteredTrades.map((t: any, i) => {
                const plPos = (t.pl_usd || 0) >= 0
                const pipsPos = (t.pips || 0) >= 0
                return (
                  <tr key={t.id || i}>
                    <td className="mono" style={{ color: 'var(--text-muted)', fontSize: 11 }}>{i + 1}</td>
                    <td style={{ fontSize: 11, color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>
                      {new Date(t.opened_at || t.date || Date.now()).toLocaleDateString()}
                    </td>
                    <td className="mono" style={{ color: '#90b0d0', fontWeight: 600 }}>{t.pair}</td>
                    <td><DirectionBadge dir={t.direction} /></td>
                    <td className="mono" style={{ color: 'var(--text-muted)', fontSize: 12 }}>
                      {(t.entry_price || t.entry || 0).toFixed(5)}
                    </td>
                    <td className="mono" style={{ color: 'var(--text-muted)', fontSize: 12 }}>
                      {t.exit_price || t.exit ? (t.exit_price || t.exit).toFixed(5) : '—'}
                    </td>
                    <td className="mono" style={{ color: pipsPos ? '#00ff87' : '#ff6060' }}>
                      {pipsPos ? '+' : ''}{t.pips?.toFixed(1) || '—'}
                    </td>
                    <td className="mono" style={{ color: plPos ? '#00ff87' : '#ff6060', fontWeight: 700 }}>
                      {plPos ? '+' : ''}{currencySymbol(account?.currency)}{(t.pl_usd || 0).toFixed(2)}
                    </td>

                    <td>
                      <span style={{
                        fontSize: 11, fontWeight: 700,
                        color: t.result === 'WIN' ? '#00ff87' : t.result === 'LOSS' ? '#ff3056' : '#ffb800'
                      }}>{t.result || '—'}</span>
                    </td>
                    <td>
                      <span style={{ fontSize: 11, color: t.rules_followed ? '#00c060' : '#ff6060' }}>
                        {t.rules_followed ? '✓ YES' : '✗ NO'}
                      </span>
                    </td>
                    <td className="mono" style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                      {t.ai_confidence ? `${t.ai_confidence}%` : '—'}
                    </td>
                    <td style={{ fontSize: 11, color: 'var(--text-muted)', maxWidth: 160, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {t.notes || '—'}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </Panel>

      {/* Add Trade Modal */}
      {showAddModal && (
        <AddTradeModal
          userId={userId}
          onClose={() => setShowAddModal(false)}
          onSave={() => { setShowAddModal(false); onTradeAdded?.() }}
        />
      )}
    </div>
  )
}

// ─── Add Trade Modal ─────────────────────────────────────────────────────────

function AddTradeModal({ onClose, onSave, userId }: { onClose: () => void; onSave: () => void; userId?: string }) {
  const [form, setForm] = useState({
    pair: 'EUR/USD', direction: 'BUY', entry: '', exit: '',
    lots: '0.05', result: 'WIN', rules: true, notes: '', date: new Date().toISOString().split('T')[0]
  })
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  function set(k: string, v: any) { setForm(f => ({ ...f, [k]: v })) }

  async function handleSave() {
    if (!userId) { setSaveError('Not logged in — cannot save trade'); return }
    setSaving(true)
    setSaveError(null)

    const entry = parseFloat(form.entry)
    const exit = parseFloat(form.exit)
    const lots = parseFloat(form.lots) || 0.01

    // Calculate pips from entry/exit if both provided
    const isJPY = form.pair.includes('JPY')
    const isGold = form.pair.startsWith('XAU')
    const isSilver = form.pair.startsWith('XAG')
    const pipSize = isGold ? 0.1 : isSilver ? 0.01 : isJPY ? 0.01 : 0.0001
    const pipValPerLot = isGold ? 10 : isSilver ? 5 : isJPY ? 9.1 : 10
    const hasEntryExit = !isNaN(entry) && !isNaN(exit)
    const priceDiff = hasEntryExit ? (form.direction === 'BUY' ? exit - entry : entry - exit) : 0
    const pips = hasEntryExit ? +(priceDiff / pipSize).toFixed(1) : 0
    const pl_usd = +(pips * pipValPerLot * lots).toFixed(2)

    const tradeObj = {
      user_id: userId,
      pair: form.pair,
      direction: form.direction,
      entry_price: !isNaN(entry) ? entry : null,
      exit_price: !isNaN(exit) ? exit : null,
      lots,
      result: form.result,
      pl_usd,
      pips,
      rules_followed: form.rules,
      notes: form.notes,
      opened_at: new Date(form.date).toISOString(),
      closed_at: new Date(form.date).toISOString(),
    }

    try {
      const res = await authFetch('/api/trades', {
        method: 'POST',
        body: JSON.stringify(tradeObj),
      })
      const data = await res.json()
      if (data.error) throw new Error(data.error)
      onSave()
    } catch (e: any) {
      setSaveError(e.message || 'Failed to save trade')
    } finally {
      setSaving(false)
    }
  }

  const overlayStyle: React.CSSProperties = {
    position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.8)',
    display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 9000
  }

  const inputStyle: React.CSSProperties = {
    width: '100%', background: '#060e1c', border: '1px solid var(--border)',
    color: 'var(--text-primary)', padding: '7px 10px', borderRadius: 3,
    fontFamily: 'JetBrains Mono', fontSize: 13, outline: 'none'
  }

  const labelStyle: React.CSSProperties = {
    fontSize: 11, color: 'var(--text-muted)', letterSpacing: 1, display: 'block', marginBottom: 5
  }

  return (
    <div style={overlayStyle} onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="panel" style={{ width: 480, padding: 24, borderColor: 'var(--border-bright)' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 20 }}>
          <span style={{ fontFamily: 'Rajdhani', fontWeight: 700, fontSize: 16, color: '#90b0d0', letterSpacing: 1 }}>
            ADD TRADE MANUALLY
          </span>
          <button onClick={onClose} style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: 18 }}>✕</button>
        </div>
        <div className="grid-2col" style={{ marginBottom: 20 }}>
          <div>
            <label style={labelStyle}>DATE</label>
            <input type="date" value={form.date} onChange={e => set('date', e.target.value)} style={inputStyle} />
          </div>
          <div>
            <label style={labelStyle}>PAIR</label>
            <select value={form.pair} onChange={e => set('pair', e.target.value)} style={inputStyle}>
              {[
                'EUR/USD', 'GBP/USD', 'USD/JPY', 'AUD/USD', 'USD/CAD', 'USD/CHF', 'NZD/USD',
                'GBP/JPY', 'EUR/JPY', 'AUD/JPY', 'EUR/GBP', 'EUR/AUD', 'EUR/CAD',
                'GBP/AUD', 'GBP/CAD', 'GBP/NZD', 'AUD/NZD', 'CAD/JPY', 'NZD/JPY',
                'XAU/USD', 'XAG/USD',
              ].map(p => <option key={p} value={p}>{p}</option>)}
            </select>
          </div>
          <div>
            <label style={labelStyle}>DIRECTION</label>
            <div style={{ display: 'flex', gap: 8 }}>
              {['BUY', 'SELL'].map(d => (
                <button key={d} className={`btn ${form.direction === d ? (d === 'BUY' ? 'btn-buy' : 'btn-sell') : 'btn-ghost'}`}
                  onClick={() => set('direction', d)} style={{ flex: 1, padding: '6px' }}>
                  {d}
                </button>
              ))}
            </div>
          </div>
          <div>
            <label style={labelStyle}>RESULT</label>
            <div style={{ display: 'flex', gap: 8 }}>
              {['WIN', 'LOSS'].map(r => (
                <button key={r} className={`btn ${form.result === r ? (r === 'WIN' ? 'btn-buy' : 'btn-sell') : 'btn-ghost'}`}
                  onClick={() => set('result', r)} style={{ flex: 1, padding: '6px' }}>
                  {r}
                </button>
              ))}
            </div>
          </div>
          <div>
            <label style={labelStyle}>ENTRY PRICE</label>
            <input type="number" step="0.00001" placeholder="1.08420" value={form.entry}
              onChange={e => set('entry', e.target.value)} style={inputStyle} />
          </div>
          <div>
            <label style={labelStyle}>EXIT PRICE</label>
            <input type="number" step="0.00001" placeholder="1.08920" value={form.exit}
              onChange={e => set('exit', e.target.value)} style={inputStyle} />
          </div>
          <div>
            <label style={labelStyle}>LOTS</label>
            <input type="number" step="0.01" placeholder="0.05" value={form.lots}
              onChange={e => set('lots', e.target.value)} style={inputStyle} />
          </div>
          <div>
            <label style={labelStyle}>RULES FOLLOWED</label>
            <div style={{ display: 'flex', gap: 8 }}>
              {[true, false].map(v => (
                <button key={String(v)} className={`btn ${form.rules === v ? 'btn-primary' : 'btn-ghost'}`}
                  onClick={() => set('rules', v)} style={{ flex: 1, padding: '6px', fontSize: 12 }}>
                  {v ? 'YES' : 'NO'}
                </button>
              ))}
            </div>
          </div>
        </div>
        <div style={{ marginBottom: 16 }}>
          <label style={labelStyle}>NOTES</label>
          <textarea
            value={form.notes} onChange={e => set('notes', e.target.value)}
            placeholder="What happened? What did you learn?"
            style={{ ...inputStyle, height: 60, resize: 'none', lineHeight: 1.5 }}
          />
        </div>
        {saveError && (
          <div style={{ marginBottom: 12, padding: '8px 12px', background: 'rgba(255,48,86,0.1)', border: '1px solid rgba(255,48,86,0.3)', borderRadius: 3, fontSize: 12, color: '#ff6060' }}>
            ⚠ {saveError}
          </div>
        )}
        <div style={{ display: 'flex', gap: 10 }}>
          <button className="btn btn-ghost" onClick={onClose} style={{ flex: 1 }}>CANCEL</button>
          <button className="btn btn-primary" onClick={handleSave} disabled={saving} style={{ flex: 2 }}>
            {saving ? 'SAVING…' : 'SAVE TRADE'}
          </button>
        </div>
      </div>
    </div>
  )
}
