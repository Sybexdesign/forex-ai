'use client'
// components/pages/IntelligencePage.tsx — Phase 4 Historical Intelligence.
//
// Two panels:
//   1. Similar-Pattern Engine (item 13) — given a live tick, find the N most
//      similar RESOLVED predictions and show how they played out.
//   2. Session / Regime / Confidence-band dashboards (item 14) — where does
//      the historical edge actually live?

import { useState, useEffect, useCallback } from 'react'
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Cell } from 'recharts'
import { Panel, StatCard } from '../ui'

const TOOLTIP_STYLE = {
  contentStyle: { background: '#0a1628', border: '1px solid #1a2940', borderRadius: 3, fontSize: 12 },
  labelStyle: { color: '#607080' },
}

const OUTCOME_COLOR: Record<string, string> = {
  WIN: '#00ff87', LOSS: '#ff3056', INCONCLUSIVE: '#ffb800', PENDING: '#405060',
}

const WIN_COLOR = '#00ff87'
const LOSS_COLOR = '#ff3056'

function winRateColor(wr: number | null): string {
  if (wr === null) return '#607080'
  if (wr >= 55) return WIN_COLOR
  if (wr >= 45) return '#ffb800'
  return LOSS_COLOR
}

interface BandSlice { label: string; n: number; wins: number; losses: number; winRate: number | null; avgMfe: number | null; avgMae: number | null; expectancy: number | null }

function SliceTable({ title, rows }: { title: string; rows: BandSlice[] }) {
  return (
    <Panel title={title}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        {rows.map(r => (
          <div key={r.label} style={{
            display: 'flex', alignItems: 'center', gap: 8, fontSize: 11,
            padding: '5px 8px', borderRadius: 2, background: 'rgba(0,0,0,0.15)',
          }}>
            <span style={{ width: 70, color: 'var(--text-dim)', fontWeight: 700 }}>{r.label}</span>
            <span style={{ width: 60, fontFamily: 'JetBrains Mono', fontWeight: 800, color: winRateColor(r.winRate) }}>
              {r.winRate === null ? '—' : `${r.winRate}%`}
            </span>
            <span style={{ width: 90, color: 'var(--text-muted)' }}>
              {r.wins}W/{r.losses}L
            </span>
            <span style={{ flex: 1, color: 'var(--text-dim)', fontSize: 10 }}>
              {r.expectancy === null ? '—' : `exp ${r.expectancy > 0 ? '+' : ''}${r.expectancy}p`}
            </span>
            <div style={{ width: 90, height: 6, borderRadius: 3, background: 'rgba(255,255,255,0.06)', overflow: 'hidden' }}>
              <div style={{
                width: r.winRate === null ? 0 : `${Math.min(100, r.winRate)}%`,
                height: '100%', background: winRateColor(r.winRate),
              }} />
            </div>
          </div>
        ))}
        {rows.every(r => r.n === 0) && (
          <div style={{ fontSize: 11, color: 'var(--text-dim)', padding: 8, fontStyle: 'italic' }}>
            No resolved prediction data yet — run the worker for a few hours after the prediction_logs migration.
          </div>
        )}
      </div>
    </Panel>
  )
}


export default function IntelligencePage() {
  const [days, setDays] = useState(30)
  const [analytics, setAnalytics] = useState<{ bySession: BandSlice[]; byRegime: BandSlice[]; byConfidenceBand: BandSlice[]; totalResolved: number } | null>(null)
  const [analyticsError, setAnalyticsError] = useState('')

  // Similar-pattern panel state
  const [pair, setPair] = useState('XAU/USD')
  const [topK, setTopK] = useState(10)
  const [patterns, setPatterns] = useState<any>(null)
  const [patternError, setPatternError] = useState('')
  const [loadingPatterns, setLoadingPatterns] = useState(false)

  const fetchAnalytics = useCallback(async () => {
    setAnalyticsError('')
    try {
      const res = await fetch(`/api/scalper/analytics?days=${days}`)
      if (!res.ok) throw new Error(`analytics ${res.status}`)
      setAnalytics(await res.json())
    } catch (e: any) {
      setAnalyticsError(e.message || 'analytics failed')
    }
  }, [days])

  useEffect(() => { fetchAnalytics() }, [fetchAnalytics])

  const runSimilarPatterns = useCallback(async () => {
    setPatternError('')
    setLoadingPatterns(true)
    try {
      // Fetch the live tick, then ask the pattern engine for look-alikes.
      const tickRes = await fetch(`/api/scalper/tick?pair=${encodeURIComponent(pair)}&timeframe=5m`)
      if (!tickRes.ok) throw new Error(`tick ${tickRes.status}`)
      const tick = await tickRes.json()
      const res = await fetch('/api/scalper/similar-patterns', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pair, indicators: tick, topK }),
      })
      if (!res.ok) throw new Error(`similar-patterns ${res.status}`)
      setPatterns(await res.json())
    } catch (e: any) {
      setPatternError(e.message || 'similar-patterns failed')
      setPatterns(null)
    } finally {
      setLoadingPatterns(false)
    }
  }, [pair, topK])


  const stats = analytics?.byConfidenceBand?.length
    ? {
        total: analytics.totalResolved,
        bestSession: [...(analytics.bySession || [])].sort((a, b) => (b.winRate ?? 0) - (a.winRate ?? 0))[0],
        bestRegime: [...(analytics.byRegime || [])].sort((a, b) => (b.winRate ?? 0) - (a.winRate ?? 0))[0],
      }
    : null

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* Header stats */}
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
        <StatCard label="Resolved predictions" value={stats ? stats.total : '…'} color="var(--color-accent)" />
        <StatCard label="Best session" value={stats?.bestSession ? `${stats.bestSession.label} ${stats.bestSession.winRate}%` : '…'} color={winRateColor(stats?.bestSession?.winRate ?? null)} />
        <StatCard label="Best regime" value={stats?.bestRegime ? `${stats.bestRegime.label} ${stats.bestRegime.winRate}%` : '…'} color={winRateColor(stats?.bestRegime?.winRate ?? null)} />
      </div>

      {analyticsError && <div style={{ color: '#ff6060', fontSize: 12 }}>{analyticsError}</div>}


      {/* Item 13: Similar-Pattern Engine */}
      <Panel title="Similar-Pattern Engine" badge="Phase 4 · item 13">
        <div style={{ display: 'flex', alignItems: 'flex-end', gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
          <div>
            <div style={{ fontSize: 10, color: 'var(--text-dim)', marginBottom: 3 }}>PAIR</div>
            <input value={pair} onChange={e => setPair(e.target.value)}
              style={{ background: '#0a1628', border: '1px solid #1a2940', color: 'var(--text-primary)', padding: '5px 8px', borderRadius: 2, fontSize: 12, width: 110 }} />
          </div>
          <div>
            <div style={{ fontSize: 10, color: 'var(--text-dim)', marginBottom: 3 }}>TOP K</div>
            <input type="number" min={1} max={50} value={topK} onChange={e => setTopK(Number(e.target.value) || 10)}
              style={{ background: '#0a1628', border: '1px solid #1a2940', color: 'var(--text-primary)', padding: '5px 8px', borderRadius: 2, fontSize: 12, width: 70 }} />
          </div>
          <button onClick={runSimilarPatterns} disabled={loadingPatterns}
            style={{ background: 'var(--color-accent)', color: '#04101f', border: 'none', borderRadius: 2, padding: '7px 16px', fontWeight: 800, cursor: 'pointer', fontSize: 12 }}>
            {loadingPatterns ? 'Scanning…' : 'Find Similar Patterns'}
          </button>
          <span style={{ fontSize: 10, color: 'var(--text-dim)', flex: 1 }}>
            Matches the live tick against resolved history — “when did the market look like this, and what happened?”
          </span>
        </div>

        {patternError && <div style={{ color: '#ff6060', fontSize: 12, marginBottom: 8 }}>{patternError}</div>}

        {patterns?.message && !patterns.matches?.length && (
          <div style={{ fontSize: 11, color: 'var(--text-dim)', fontStyle: 'italic' }}>{patterns.message}</div>
        )}

        {patterns?.stats && (
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 10 }}>
            <StatCard label="Similar win rate" value={`${patterns.stats.winRate}%`} color={winRateColor(patterns.stats.winRate)} />
            <StatCard label="Avg MFE" value={`${patterns.stats.avgMfePips}p`} color="var(--color-buy)" />
            <StatCard label="Avg MAE" value={`${patterns.stats.avgMaePips}p`} color="var(--color-sell)" />
            <StatCard label="Expectancy" value={patterns.stats.expectancyPips === null ? '—' : `${patterns.stats.expectancyPips > 0 ? '+' : ''}${patterns.stats.expectancyPips}p`} color={patterns.stats.expectancyPips >= 0 ? 'var(--color-buy)' : 'var(--color-sell)'} />
          </div>
        )}

        {patterns?.matches?.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 3, maxHeight: 380, overflowY: 'auto' }}>
            {patterns.matches.map((m: any, i: number) => (
              <div key={i} style={{
                display: 'flex', alignItems: 'center', gap: 8, fontSize: 11,
                padding: '5px 8px', borderRadius: 2, background: 'rgba(0,0,0,0.15)',
              }}>
                <span style={{ width: 30, color: 'var(--text-dim)', fontFamily: 'JetBrains Mono' }}>{m.distance}</span>
                <span style={{ width: 45, fontWeight: 800, color: m.direction === 'BUY' ? 'var(--color-buy)' : 'var(--color-sell)' }}>{m.direction}</span>
                <span style={{ width: 60, fontFamily: 'JetBrains Mono', fontWeight: 800, color: OUTCOME_COLOR[m.outcome] || '#607080' }}>
                  {m.outcome}
                </span>
                <span style={{ width: 55, color: 'var(--text-muted)' }}>{m.confidence}%</span>
                <span style={{ width: 70, color: 'var(--text-dim)' }}>{m.regime ?? '—'}</span>
                <span style={{ width: 85, color: 'var(--text-muted)' }}>MFE {m.mfePips ?? '—'}p</span>
                <span style={{ width: 85, color: 'var(--text-muted)' }}>MAE {m.maePips ?? '—'}p</span>
                <span style={{ flex: 1, color: 'var(--text-dim)', fontSize: 10, textAlign: 'right' }}>
                  {m.createdAt ? new Date(m.createdAt).toLocaleString() : ''}
                </span>
              </div>
            ))}
          </div>
        )}
      </Panel>


      {/* Item 14: Dashboards */}
      <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
        <span style={{ fontSize: 11, color: 'var(--text-dim)', fontWeight: 700 }}>WINDOW</span>
        {[7, 14, 30, 90].map(d => (
          <button key={d} onClick={() => setDays(d)}
            style={{
              background: days === d ? 'var(--color-accent)' : '#0a1628',
              color: days === d ? '#04101f' : 'var(--text-muted)',
              border: '1px solid #1a2940', borderRadius: 2, padding: '4px 12px',
              fontWeight: 800, cursor: 'pointer', fontSize: 11,
            }}>
            {d}d
          </button>
        ))}
        <span style={{ fontSize: 10, color: 'var(--text-dim)', flex: 1, textAlign: 'right' }}>
          Expectancy = avg MFE − avg MAE (pips) · winRate = WIN/(WIN+LOSS)
        </span>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: 12 }}>
        <SliceTable title="By Session (UTC)" rows={analytics?.bySession || []} />
        <SliceTable title="By Regime" rows={analytics?.byRegime || []} />
        <SliceTable title="By Confidence Band" rows={analytics?.byConfidenceBand || []} />
      </div>

      {/* Bar chart of win rates */}
      {analytics && (
        <Panel title="Win Rate by Slice" badge="Phase 4 · item 14">
          <div style={{ height: 220 }}>
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={[
                ...(analytics.bySession || []).map(r => ({ name: `S:${r.label}`, winRate: r.winRate })),
                ...(analytics.byRegime || []).map(r => ({ name: `R:${r.label}`, winRate: r.winRate })),
                ...(analytics.byConfidenceBand || []).map(r => ({ name: `C:${r.label}`, winRate: r.winRate })),
              ]}>
                <CartesianGrid strokeDasharray="3 3" stroke="#1a2940" />
                <XAxis dataKey="name" tick={{ fill: '#607080', fontSize: 10 }} interval={0} angle={-30} textAnchor="end" height={60} />
                <YAxis domain={[0, 100]} tick={{ fill: '#607080', fontSize: 10 }} />
                <Tooltip {...TOOLTIP_STYLE} />
                <Bar dataKey="winRate" name="Win rate %">
                  {[
                    ...(analytics.bySession || []).map(() => 'session'),
                    ...(analytics.byRegime || []).map(() => 'regime'),
                    ...(analytics.byConfidenceBand || []).map(() => 'confidence'),
                  ].map((kind, i) => (
                    <Cell key={i} fill={kind === 'session' ? '#38bdf8' : kind === 'regime' ? '#8b5cf6' : '#00e5b4'} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Panel>
      )}
    </div>
  )
}
