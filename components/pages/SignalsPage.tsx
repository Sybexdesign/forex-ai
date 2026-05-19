'use client'
// components/pages/SignalsPage.tsx

import React, { useState, useMemo } from 'react'
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Cell } from 'recharts'
import { Panel, StatCard, DirectionBadge, CopyValue } from '../ui'

interface SignalsPageProps { signals: any[] }

const OUTCOME_COLOR: Record<string, string> = {
  WIN: '#00ff87', LOSS: '#ff3056', PENDING: '#ffb800', SKIPPED: '#405060'
}

const DIR_COLOR: Record<string, string> = {
  BUY: '#00ff87', SELL: '#ff3056', WAIT: '#ffb800'
}

const CONFIDENCE_COLOR = (n: number) =>
  n >= 75 ? '#00ff87' : n >= 60 ? '#0080ff' : n >= 50 ? '#ffb800' : '#ff6060'

const TOOLTIP_STYLE = {
  contentStyle: { background: '#0a1628', border: '1px solid #1a2940', borderRadius: 3, fontSize: 12 },
  labelStyle: { color: '#607080' },
}

export default function SignalsPage({ signals }: SignalsPageProps) {
  const [dirFilter, setDirFilter] = useState<'ALL' | 'BUY' | 'SELL' | 'WAIT'>('ALL')
  const [outcomeFilter, setOutcomeFilter] = useState<'ALL' | 'WIN' | 'LOSS' | 'PENDING' | 'SKIPPED'>('ALL')
  const [minConf, setMinConf] = useState(0)
  const [expandedId, setExpandedId] = useState<string | null>(null)

  // ─── Stats ───────────────────────────────────────────────────────────────
  const total = signals.length
  const acted = signals.filter(s => s.acted_on).length
  const wins = signals.filter(s => s.outcome === 'WIN').length
  const losses = signals.filter(s => s.outcome === 'LOSS').length
  const pending = signals.filter(s => s.outcome === 'PENDING').length
  const actionRate = total ? (acted / total * 100).toFixed(0) : '0'
  const accuracy = acted ? (wins / acted * 100).toFixed(0) : '0'
  const avgConfidence = total
    ? (signals.reduce((s, sg) => s + sg.confidence, 0) / total).toFixed(0)
    : '0'

  // High-quality signals (confidence >= 70, checklist >= 6)
  const hqSignals = signals.filter(s => s.confidence >= 70 && s.checklist_score >= 6)
  const hqWins = hqSignals.filter(s => s.acted_on && s.outcome === 'WIN').length
  const hqActed = hqSignals.filter(s => s.acted_on).length
  const hqAccuracy = hqActed ? (hqWins / hqActed * 100).toFixed(0) : '0'

  // Confidence distribution
  const confBuckets = useMemo(() => {
    const buckets = [
      { range: '50–59', min: 50, max: 59, wins: 0, losses: 0 },
      { range: '60–69', min: 60, max: 69, wins: 0, losses: 0 },
      { range: '70–79', min: 70, max: 79, wins: 0, losses: 0 },
      { range: '80–89', min: 80, max: 89, wins: 0, losses: 0 },
      { range: '90+',   min: 90, max: 100, wins: 0, losses: 0 },
    ]
    signals.filter(s => s.acted_on).forEach(s => {
      const bucket = buckets.find(b => s.confidence >= b.min && s.confidence <= b.max)
      if (bucket) {
        if (s.outcome === 'WIN') bucket.wins++
        else if (s.outcome === 'LOSS') bucket.losses++
      }
    })
    return buckets
  }, [signals])

  // Pair accuracy
  const pairAccuracy = useMemo(() => {
    const map: Record<string, { wins: number; acted: number }> = {}
    signals.filter(s => s.acted_on && (s.outcome === 'WIN' || s.outcome === 'LOSS')).forEach(s => {
      if (!map[s.pair]) map[s.pair] = { wins: 0, acted: 0 }
      map[s.pair].acted++
      if (s.outcome === 'WIN') map[s.pair].wins++
    })
    return Object.entries(map).map(([pair, v]) => ({
      pair: pair.replace('/', ''),
      accuracy: +(v.wins / v.acted * 100).toFixed(0),
    }))
  }, [signals])

  // Filtered signals
  const filtered = signals
    .filter(s => dirFilter === 'ALL' || s.direction === dirFilter)
    .filter(s => outcomeFilter === 'ALL' || s.outcome === outcomeFilter)
    .filter(s => s.confidence >= minConf)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>

      {/* Stats */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))', gap: 10 }}>
        <StatCard label="TOTAL SIGNALS"    value={total}              color="#60c0ff" />
        <StatCard label="ACTED ON"          value={acted}              color="#ffb800" />
        <StatCard label="ACTION RATE"       value={`${actionRate}%`}  color="#ffb800" />
        <StatCard label="SIGNAL ACCURACY"   value={`${accuracy}%`}   color={+accuracy > 55 ? '#00ff87' : '#ff6060'} />
        <StatCard label="AVG CONFIDENCE"    value={`${avgConfidence}%`} color="#0080ff" />
        <StatCard label="HQ ACCURACY"       value={`${hqAccuracy}%`} color={+hqAccuracy > 60 ? '#00ff87' : '#ffb800'} />
        <StatCard label="WINS"              value={wins}              color="#00ff87" />
        <StatCard label="LOSSES"            value={losses}            color="#ff6060" />
        <StatCard label="PENDING"           value={pending}           color="#ffb800" />
      </div>

      {/* High quality note */}
      <div style={{
        background: 'rgba(0,128,255,0.06)', border: '1px solid rgba(0,128,255,0.2)',
        borderRadius: 3, padding: '10px 16px', fontSize: 13, color: 'var(--text-secondary)'
      }}>
        <span style={{ color: '#60c0ff', fontWeight: 700 }}>💡 INSIGHT: </span>
        High-quality signals (≥70% confidence + ≥6/8 rules) achieve{' '}
        <span style={{ color: '#00ff87', fontWeight: 700 }}>{hqAccuracy}% accuracy</span>{' '}
        vs overall <span style={{ color: '#ffb800' }}>{accuracy}%</span>.
        {' '}You have <span style={{ color: '#60c0ff' }}>{hqSignals.length}</span> HQ signals in history.
      </div>

      {/* Charts */}
      <div className="grid-2col" style={{ gap: 12 }}>
        <Panel title="WIN RATE BY CONFIDENCE BAND">
          <div style={{ padding: '8px 4px 12px' }}>
            <ResponsiveContainer width="100%" height={160}>
              <BarChart data={confBuckets} margin={{ top: 4, right: 16, left: -10, bottom: 0 }}>
                <CartesianGrid strokeDasharray="2 6" stroke="#0d1e30" />
                <XAxis dataKey="range" tick={{ fill: '#405060', fontSize: 10 }} />
                <YAxis tick={{ fill: '#405060', fontSize: 9 }} />
                <Tooltip {...TOOLTIP_STYLE} />
                <Bar dataKey="wins" name="Wins" fill="#00ff87" opacity={0.85} radius={[2, 2, 0, 0]} />
                <Bar dataKey="losses" name="Losses" fill="#ff3056" opacity={0.7} radius={[2, 2, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Panel>

        <Panel title="SIGNAL ACCURACY BY PAIR">
          <div style={{ padding: '8px 4px 12px' }}>
            <ResponsiveContainer width="100%" height={160}>
              <BarChart data={pairAccuracy} margin={{ top: 4, right: 16, left: -10, bottom: 0 }}>
                <CartesianGrid strokeDasharray="2 6" stroke="#0d1e30" />
                <XAxis dataKey="pair" tick={{ fill: '#405060', fontSize: 9 }} />
                <YAxis domain={[0, 100]} tick={{ fill: '#405060', fontSize: 9 }}
                  tickFormatter={v => `${v}%`} />
                <Tooltip {...TOOLTIP_STYLE} formatter={(v: any) => [`${v}%`, 'Accuracy']}
                  itemStyle={{ color: '#60c0ff' }} />
                <Bar dataKey="accuracy" name="Accuracy" radius={[2, 2, 0, 0]}>
                  {pairAccuracy.map((entry, i) => (
                    <Cell key={i} fill={entry.accuracy >= 60 ? '#00ff87' : entry.accuracy >= 45 ? '#0080ff' : '#ff3056'} opacity={0.85} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Panel>
      </div>

      {/* Signal log */}
      <Panel
        title={`SIGNAL LOG (${filtered.length} shown)`}
        badge={
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            {/* Direction filter */}
            {(['ALL', 'BUY', 'SELL', 'WAIT'] as const).map(d => (
              <button key={d} className={`tab-btn ${dirFilter === d ? 'active' : ''}`}
                onClick={() => setDirFilter(d)} style={{ fontSize: 10, padding: '2px 8px' }}>
                {d}
              </button>
            ))}
            <span style={{ color: 'var(--border)', fontSize: 16 }}>|</span>
            {(['ALL', 'WIN', 'LOSS', 'PENDING', 'SKIPPED'] as const).map(o => (
              <button key={o} className={`tab-btn ${outcomeFilter === o ? 'active' : ''}`}
                onClick={() => setOutcomeFilter(o)} style={{ fontSize: 10, padding: '2px 8px' }}>
                {o}
              </button>
            ))}
            <span style={{ color: 'var(--border)', fontSize: 16 }}>|</span>
            <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
              Min conf:{' '}
              <input
                type="number" min={0} max={100} value={minConf}
                onChange={e => setMinConf(+e.target.value)}
                style={{ width: 44, background: 'var(--bg-panel)', border: '1px solid var(--border)', color: 'var(--text-primary)', padding: '2px 6px', borderRadius: 2, fontSize: 11, fontFamily: 'JetBrains Mono' }}
              />%
            </span>
          </div>
        }
      >
        <div style={{ overflowX: 'auto', maxHeight: 500, overflowY: 'auto' }}>
          <table>
            <thead>
              <tr>
                <th>#</th><th>DATETIME</th><th>PAIR</th><th>TF</th>
                <th>DIRECTION</th><th>CONF</th><th>CHECKLIST</th>
                <th>ACTED</th><th>OUTCOME</th><th>DETAILS</th>
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0 && (
                <tr>
                  <td colSpan={10} style={{ textAlign: 'center', padding: 24, color: 'var(--text-muted)' }}>
                    No signals match the current filters
                  </td>
                </tr>
              )}
              {filtered.map((s: any, i) => {
                const isExpanded = expandedId === (s.id || i.toString())
                const hq = s.confidence >= 70 && s.checklist_score >= 6
                return (
                  <React.Fragment key={s.id || i}>
                    <tr style={{ cursor: 'pointer' }}
                      onClick={() => setExpandedId(isExpanded ? null : (s.id || i.toString()))}>
                      <td className="mono" style={{ color: 'var(--text-muted)', fontSize: 11 }}>
                        {i + 1}
                        {hq && <span style={{ marginLeft: 4, color: '#0080ff', fontSize: 9 }}>★</span>}
                      </td>
                      <td style={{ fontSize: 11, color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>
                        {new Date(s.created_at || Date.now()).toLocaleString('en', {
                          month: 'short', day: '2-digit',
                          hour: '2-digit', minute: '2-digit', hour12: false
                        })}
                      </td>
                      <td className="mono" style={{ color: '#90b0d0', fontWeight: 600 }}>{s.pair}</td>
                      <td className="mono" style={{ color: 'var(--text-muted)', fontSize: 11 }}>{s.timeframe}</td>
                      <td><DirectionBadge dir={s.direction} /></td>
                      <td>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                          <span className="mono" style={{
                            fontSize: 13, fontWeight: 700,
                            color: CONFIDENCE_COLOR(s.confidence)
                          }}>{s.confidence}%</span>
                          <div style={{ width: 40, height: 3, background: 'var(--border)', borderRadius: 2 }}>
                            <div style={{
                              width: `${s.confidence}%`, height: '100%',
                              background: CONFIDENCE_COLOR(s.confidence), borderRadius: 2
                            }} />
                          </div>
                        </div>
                      </td>
                      <td>
                        <span className="mono" style={{
                          fontSize: 13, fontWeight: 700,
                          color: s.checklist_score >= 6 ? '#00ff87' : '#ff6060'
                        }}>
                          {s.checklist_score}/8
                        </span>
                      </td>
                      <td>
                        <span style={{
                          fontSize: 11, fontWeight: 700,
                          color: s.acted_on ? '#00c060' : 'var(--text-muted)'
                        }}>
                          {s.acted_on ? '✓ YES' : '— NO'}
                        </span>
                      </td>
                      <td>
                        <span style={{
                          fontSize: 11, fontWeight: 700,
                          color: OUTCOME_COLOR[s.outcome] || 'var(--text-muted)'
                        }}>
                          {s.outcome || '—'}
                        </span>
                      </td>
                      <td>
                        <span style={{ color: 'var(--text-muted)', fontSize: 12, cursor: 'pointer' }}>
                          {isExpanded ? '▲' : '▼'}
                        </span>
                      </td>
                    </tr>

                    {/* Expanded row */}
                    {isExpanded && (
                      <tr>
                        <td colSpan={10} style={{ background: 'rgba(0,128,255,0.04)', padding: 0 }}>
                          <div className="grid-2col" style={{ padding: '12px 16px', gap: 16 }}>
                            <div>
                              <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 8, fontWeight: 700, letterSpacing: 1 }}>REASONS</div>
                              {(s.reasons || ['No reasons recorded']).map((r: string, ri: number) => (
                                <div key={ri} style={{ display: 'flex', gap: 8, marginBottom: 5, fontSize: 12, color: 'var(--text-secondary)' }}>
                                  <span style={{ color: DIR_COLOR[s.direction] || '#607080', flexShrink: 0 }}>→</span>
                                  <span>{r}</span>
                                </div>
                              ))}
                            </div>
                            <div>
                              <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 8, fontWeight: 700, letterSpacing: 1 }}>RISK NOTE</div>
                              <div style={{ fontSize: 12, color: '#e0a060', lineHeight: 1.6, padding: '8px 10px', background: 'rgba(255,184,0,0.07)', borderRadius: 3 }}>
                                {s.risk_note || 'No risk note recorded'}
                              </div>
                              {(s.entry_zone_low && s.entry_zone_high) && (
                                <div style={{ marginTop: 10, fontSize: 12, color: 'var(--text-muted)' }}>
                                  Entry zone: <span className="mono" style={{ color: '#90b0d0' }}>
                                    <CopyValue value={s.entry_zone_low.toFixed(5)}>{s.entry_zone_low.toFixed(5)}</CopyValue>
                                    {' — '}
                                    <CopyValue value={s.entry_zone_high.toFixed(5)}>{s.entry_zone_high.toFixed(5)}</CopyValue>
                                  </span>
                                </div>
                              )}
                            </div>
                          </div>
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                )
              })}
            </tbody>
          </table>
        </div>
      </Panel>
    </div>
  )
}
