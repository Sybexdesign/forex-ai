'use client'
// components/pages/SetupIntelPage.tsx
// Read-only dashboard for the Expectancy + Authority + Safety intelligence
// layer (migration 20260902). Shows segmented historical expectancy, qualified
// setup lifecycle rows/alerts, strategy health (signal scarcity + filter
// bottlenecks) and recurring failure patterns. Data refreshes every 60s; the
// qualified-setup table also listens to Supabase Realtime so new setups appear
// live without a manual refresh.

import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { getSupabase } from '@/lib/supabase'

interface SetupIntelPageProps { userId?: string | null }

const fmt = (n: number | null | undefined, d = 2) =>
  n === null || n === undefined || !Number.isFinite(n) ? '—' : n.toFixed(d)
const pct = (n: number | null | undefined) =>
  n === null || n === undefined || !Number.isFinite(n) ? '—' : `${(n * 100).toFixed(0)}%`

const STATUS_COLOR: Record<string, string> = {
  VERY_STRONG: '#22c55e', STRONG: '#4ade80', POSITIVE: '#a3e635',
  NEUTRAL: '#eab308', NEGATIVE: '#ef4444', INSUFFICIENT_DATA: '#64748b',
  APPROVED: '#22c55e', DENIED: '#ef4444', REVIEW: '#eab308', NO_OP: '#64748b',
  ALERTED: '#22c55e', QUALIFIED: '#4ade80', DETECTED: '#64748b',
  ACTED: '#38bdf8', EXPIRED: '#64748b', REJECTED: '#ef4444', SUPPRESSED: '#64748b',
}

export default function SetupIntelPage({ userId }: SetupIntelPageProps) {
  const [segments, setSegments] = useState<any[]>([])
  const [config, setConfig] = useState<any>(null)
  const [setups, setSetups] = useState<any[]>([])
  const [alerts, setAlerts] = useState<any[]>([])
  const [health, setHealth] = useState<any>(null)
  const [diagnoses, setDiagnoses] = useState<any>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  // Phase 10 walk-forward backtest
  const [bt, setBt] = useState<any>(null)
  const [btLoading, setBtLoading] = useState(false)
  const [btError, setBtError] = useState<string | null>(null)
  const btStarted = useRef(false)
  const [testAlerting, setTestAlerting] = useState(false)
  const [testMsg, setTestMsg] = useState<string | null>(null)
  const timer = useRef<ReturnType<typeof setInterval> | null>(null)

  const fireTestAlert = async () => {
    if (testAlerting) return
    setTestAlerting(true)
    setTestMsg(null)
    try {
      const r = await fetch('/api/setup-alerts/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId }),
      }).then(x => x.json())
      setTestMsg(r?.message ?? r?.error ?? 'test fired')
      load()
    } catch (e: any) {
      setTestMsg(e?.message || 'test failed')
    } finally {
      setTestAlerting(false)
    }
  }

  const loadBacktest = async (fresh = false) => {
    if (btLoading) return
    setBtLoading(true)
    try {
      const uq = userId ? `&userId=${encodeURIComponent(userId)}` : ''
      const r = await fetch(`/api/backtest?window=90${uq}${fresh ? '&refresh=1' : ''}`).then(x => x.json())
      if (!r?.error) { setBt(r); setBtError(null) } else setBtError(r.error)
    } catch (e: any) {
      setBtError(e?.message || 'Backtest failed')
    } finally {
      setBtLoading(false)
    }
  }

  const load = async () => {
    try {
      const userQ = userId ? `?userId=${encodeURIComponent(userId)}` : ''
      const alertQ = userId
        ? `?userId=${encodeURIComponent(userId)}&limit=40`
        : '?limit=40'
      const [seg, setup, hlth, diag] = await Promise.all([
        fetch(`/api/expectancy${userQ}`).then(r => r.json()),
        fetch(`/api/setup-alerts${alertQ}`).then(r => r.json()),
        fetch(`/api/strategy-health?window=7d${userQ}`).then(r => r.json()),
        fetch(`/api/loss-diagnostics?days=7${userQ}`).then(r => r.json()),
      ])
      if (!seg?.error) { setSegments(seg.segments ?? []); setConfig(seg.config ?? null) }
      if (!setup?.error) { setSetups(setup.setups ?? []); setAlerts(setup.alerts ?? []) }
      if (!hlth?.error) setHealth(hlth)
      if (!diag?.error) setDiagnoses(diag)
      setError(null)
    } catch (e: any) {
      setError(e?.message || 'Failed to load intelligence data')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    load()
    if (!timer.current) timer.current = setInterval(load, 60_000)
    return () => { if (timer.current) clearInterval(timer.current) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId])

  // ── Realtime: new qualified setups push in without a refresh ─────────────
  useEffect(() => {
    let sub: any = null
    try {
      sub = getSupabase()
        .channel('setup_alerts_live')
        .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'setup_alerts' }, () => load())
        .subscribe()
    } catch { /* realtime is optional */ }
    return () => { try { sub?.unsubscribe() } catch { /* noop */ } }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId])

  // ── Phase 10: kick the walk-forward backtest once (server-cached after) ──
  useEffect(() => {
    if (btStarted.current) return
    btStarted.current = true
    loadBacktest()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId])


  const h = health?.payload ?? null

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <h2 style={{ margin: 0, fontSize: 18 }}>🎯 SETUP INTELLIGENCE — SHADOW MODE</h2>
        <span style={{ fontSize: 11, color: '#94a3b8' }}>
          Expectancy / Authority / Safety advisory layer — no execution impact
        </span>
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>
          <button className="btn btn-ghost" disabled={testAlerting}
            onClick={fireTestAlert}
            style={{ fontSize: 10, padding: '4px 10px' }}>
            {testAlerting ? 'FIRING…' : '🔔 TEST ALERT (no trade)'}
          </button>
        </div>
      </div>
      {testMsg && <div style={{ fontSize: 11, color: '#4ade80' }}>{testMsg}</div>}
      {error && <div style={{ color: '#ef4444', fontSize: 12 }}>{error}</div>}
      {loading && <div style={{ color: '#64748b', fontSize: 12 }}>Loading…</div>}

      {/* Summary cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px,1fr))', gap: 10 }}>
        {[
          ['Qualified alerts (7d)', `${alerts.length}`, '#4ade80'],
          ['Active setups', setups.filter(s => ['DETECTED', 'QUALIFIED', 'ALERTED'].includes(s.status)).length, '#94a3b8'],
          ['Closed trades (7d)', h ? `${h.trades.closed}` : '—', '#94a3b8'],
          ['Win rate (7d)', h ? pct(h.trades.winRate) : '—', '#eab308'],
          ['Expectancy R (7d)', h ? fmt(h.trades.expectancyR) : '—', '#38bdf8'],
          ['Signals / 24h', h ? `${h.signalsPer24h ?? '—'}` : '—', '#94a3b8'],
          ['Authority DENIED (7d)', h ? `${h.authority.denied}` : '—', '#ef4444'],
          ['Critical diagnoses (7d)', h ? `${h.diagnosisCritical}` : '—', '#f97316'],
        ].map(([label, value, color]) => (
          <div key={label as string} style={{ background: '#0b1120', border: '1px solid #1e293b', borderRadius: 8, padding: '10px 12px' }}>
            <div style={{ fontSize: 10, color: '#64748b', textTransform: 'uppercase', letterSpacing: 0.5 }}>{label}</div>
            <div style={{ fontSize: 22, fontWeight: 700, color: color as string, fontFamily: 'JetBrains Mono, monospace' }}>{value}</div>
          </div>
        ))}
      </div>


      {/* Phase 10 — Walk-forward backtest */}
      <section style={{ background: '#0b1120', border: '1px solid #1e293b', borderRadius: 8, padding: 14 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 10 }}>
          <div style={{ fontSize: 13, fontWeight: 700 }}>PHASE 10 — WALK-FORWARD BACKTEST <span style={{ fontSize: 10, color: '#64748b', fontWeight: 400 }}>· no-lookahead segment stats · 90d</span></div>
          {btLoading && <span style={{ fontSize: 11, color: '#94a3b8' }}>computing…</span>}
          <button className="btn btn-ghost" disabled={btLoading}
            onClick={() => loadBacktest(true)}
            style={{ fontSize: 10, padding: '4px 10px', marginLeft: 'auto' }}>
            ↻ RE-RUN
          </button>
        </div>

        {btError && <div style={{ color: '#ef4444', fontSize: 11, marginBottom: 8 }}>{btError}</div>}
        {!bt?.ok && !btError && bt && (bt.warnings ?? []).length > 0 && (
          <div style={{ color: '#ffb800', fontSize: 11, marginBottom: 8 }}>
            {(bt.warnings ?? []).map((w: string, i: number) => <div key={i}>⚠ {w}</div>)}
          </div>
        )}

        {bt?.ok && (
          <>
            <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', fontSize: 11, color: '#94a3b8', marginBottom: 10 }}>
              <span>{bt.candidates} candidates · {bt.evidence} evidence episodes</span>
              {bt.dateFrom && <span>{(bt.dateFrom as string).slice(0, 10)} → {(bt.dateTo as string).slice(0, 10)}</span>}
              <span>conf ≥ {bt.options.confFloor} · strict safety ≥ {bt.options.strictSafetyMin} · min n = {bt.options.minSamples}</span>
              {(bt.warnings ?? []).length > 0 && <span style={{ color: '#ffb800' }}>⚠ {(bt.warnings as string[]).join(' · ')}</span>}
            </div>
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', fontSize: 11, borderCollapse: 'collapse' }}>
                <thead><tr style={{ color: '#64748b', textAlign: 'left' }}>
                  <th style={th}>System</th><th style={th}>Trades</th><th style={th}>Win</th>
                  <th style={th}>Expect R</th><th style={th}>PF</th><th style={th}>Total R%</th>
                  <th style={th}>MaxDD R</th><th style={th}>Lose Streak</th><th style={th}>Sharpe</th>
                  <th style={th}>Sortino</th><th style={th}>Missed+</th><th style={th}>Exec Loss</th>
                </tr></thead>
                <tbody>
                  {(['current', 'expectancy', 'authority', 'safety'] as const).map((k) => {
                    const m = bt.runs?.[k]
                    if (!m) return null
                    const isBaseline = k === 'current'
                    const color = isBaseline ? '#94a3b8' : (m.expectancyR >= 0 ? '#22c55e' : '#ef4444')
                    return (
                      <tr key={k} style={{ borderTop: '1px solid #1e293b' }}>
                        <td style={{ ...td, fontFamily: 'inherit', color }}>{m.label}{isBaseline ? ' (baseline)' : ''}</td>
                        <td style={td}>{m.trades}</td>
                        <td style={td}>{pct(m.winRate)}</td>
                        <td style={{ ...td, color }}>{fmt(m.expectancyR)}</td>
                        <td style={td}>{fmt(m.profitFactor, 2)}</td>
                        <td style={td}>{m.totalReturnPct !== null ? `${m.totalReturnPct.toFixed(2)}%` : '—'}</td>
                        <td style={td}>{fmt(m.maxDrawdownR)}</td>
                        <td style={td}>{m.losingStreak}</td>
                        <td style={td}>{fmt(m.sharpePerTrade)}</td>
                        <td style={td}>{fmt(m.sortinoPerTrade)}</td>
                        <td style={td}>{!isBaseline ? `${m.missedWins} (${fmt(m.missedWinSumR)}R)` : '—'}</td>
                        <td style={td}>{`${m.falsePositives} (${fmt(m.falsePositiveSumR)}R)`}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
            <div style={{ fontSize: 10, color: '#475569', marginTop: 8 }}>
              Total R% assumes 1% risk per trade (simple sum, no compounding). Missed+ = winning setups this layer skipped vs the
              previous system; Exec Loss = losing setups this system still executed. Segment statistics are strictly point-in-time
              (only outcomes knowable before each signal) — shadow run, never touches execution.
            </div>
          </>
        )}
      </section>

      {/* Segmented expectancy */}
      <section style={{ background: '#0b1120', border: '1px solid #1e293b', borderRadius: 8, padding: 14 }}>
        <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 10 }}>SEGMENTED HISTORICAL EXPECTANCY
          {config && (
            <span style={{ fontSize: 10, color: '#64748b', marginLeft: 8 }}>
              {config.windowDaysDefault}d window · min +{config.minPositiveR}R · samples: &lt;{config.sampleThresholds?.low} insuff · {config.sampleThresholds?.low}–{config.sampleThresholds?.moderate} low · {config.sampleThresholds?.moderate}–{config.sampleThresholds?.strong} mod · {config.sampleThresholds?.strong}+ strong
            </span>
          )}
        </div>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', fontSize: 11, borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ color: '#64748b', textAlign: 'left' }}>
                <th style={th}>Segment</th><th style={th}>N</th><th style={th}>W/L</th>
                <th style={th}>WinRate</th><th style={th}>AvgW R</th><th style={th}>AvgL R</th>
                <th style={th}>Expect R</th><th style={th}>PF</th><th style={th}>Status</th>
              </tr>
            </thead>
            <tbody>
              {(segments || []).slice(0, 30).map((s: any) => {
                const m = s.metrics ?? {}
                const label = [
                  s.segment?.pair, s.segment?.direction,
                  s.segment?.session, s.segment?.regime, s.segment?.volRegime,
                  s.segment?.conf ? `conf ${s.segment.conf}` : null,
                  s.segment?.ml ? `ml ${s.segment.ml}` : null,
                  s.segment?.spread ? s.segment.spread : null,
                ].filter(Boolean).join(' · ') || 'ALL'
                const color = STATUS_COLOR[m.status] ?? '#94a3b8'
                return (
                  <tr key={s.key} style={{ borderTop: '1px solid #1e293b' }}>
                    <td style={{ ...td, fontFamily: 'inherit' }}>{label}</td>
                    <td style={td}>{m.n ?? 0}</td>
                    <td style={td}>{m.wins ?? 0}/{m.losses ?? 0}</td>
                    <td style={td}>{pct(m.winRate)}</td>
                    <td style={td}>{fmt(m.avgWinR)}</td>
                    <td style={td}>{fmt(m.avgLossR)}</td>
                    <td style={{ ...td, color }}>{fmt(m.expectancyR)}</td>
                    <td style={td}>{fmt(m.profitFactor, 1)}</td>
                    <td style={{ ...td, color }}>{m.status ?? '—'}</td>
                  </tr>
                )
              })}
              {(segments || []).length === 0 && (
                <tr><td colSpan={9} style={{ ...td, color: '#64748b' }}>
                  No expectancy samples yet — they are collected from closed trades and resolved predictions. Run the worker for a few hours and refresh.
                </td></tr>
              )}
            </tbody>
          </table>
        </div>
      </section>


      {/* Setup lifecycle */}
      <section style={{ background: '#0b1120', border: '1px solid #1e293b', borderRadius: 8, padding: 14 }}>
        <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 10 }}>QUALIFIED SETUP LIFECYCLE (live via Realtime)</div>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', fontSize: 11, borderCollapse: 'collapse' }}>
            <thead><tr style={{ color: '#64748b', textAlign: 'left' }}>
              <th style={th}>Time</th><th style={th}>Pair</th><th style={th}>Dir</th>
              <th style={th}>Status</th><th style={th}>Expect R</th><th style={th}>Safety</th><th style={th}>Why</th>
            </tr></thead>
            <tbody>
              {(setups || []).slice(0, 20).map((s: any) => {
                const snap = s.snapshot ?? {}
                const exp = snap.expectancy
                const color = STATUS_COLOR[s.status] ?? '#94a3b8'
                const why = (snap.authority?.reasons ?? []).filter((r: any) => r.severity !== 'info').map((r: any) => r.reason)
                return (
                  <tr key={s.id} style={{ borderTop: '1px solid #1e293b' }}>
                    <td style={td}>{new Date(s.detected_at).toLocaleTimeString([], { hour12: false })}</td>
                    <td style={{ ...td, fontFamily: 'inherit' }}>{s.pair}</td>
                    <td style={td}>{s.direction}</td>
                    <td style={{ ...td, color }}>{s.status}</td>
                    <td style={td}>{exp ? fmt(exp.expectancy_r) : '—'}</td>
                    <td style={td}>{snap.safety?.total ?? '—'}</td>
                    <td style={{ ...td, fontFamily: 'inherit', maxWidth: 340, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {why.join('; ') || '—'}
                    </td>
                  </tr>
                )
              })}
              {(setups || []).length === 0 && (
                <tr><td colSpan={7} style={{ ...td, color: '#64748b' }}>No setups tracked yet.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </section>


      {/* Health: bottlenecks + failure patterns */}
      {h && (
        <section style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px,1fr))', gap: 12 }}>
          <div style={{ background: '#0b1120', border: '1px solid #1e293b', borderRadius: 8, padding: 14 }}>
            <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 10 }}>FILTER BOTTLENECKS (7d)</div>
            {(h.filterBottlenecks ?? []).length === 0 && <div style={{ color: '#64748b', fontSize: 11 }}>No rejections recorded yet.</div>}
            {(h.filterBottlenecks ?? []).slice(0, 8).map((b: any) => (
              <div key={b.filter} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, padding: '3px 0' }}>
                <span>{b.filter}</span><span style={{ fontFamily: 'JetBrains Mono, monospace' }}>{b.count}</span>
              </div>
            ))}
          </div>
          <div style={{ background: '#0b1120', border: '1px solid #1e293b', borderRadius: 8, padding: 14 }}>
            <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 10 }}>RECURRING FAILURE PATTERNS (7d)</div>
            {(diagnoses?.patterns?.ranked ?? []).length === 0 && <div style={{ color: '#64748b', fontSize: 11 }}>No diagnoses yet — automatic loss diagnosis runs on resolved losses.</div>}
            {(diagnoses?.patterns?.ranked ?? []).slice(0, 8).map((p: any) => (
              <div key={p.code} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, padding: '3px 0' }}>
                <span>{p.code}</span><span style={{ fontFamily: 'JetBrains Mono, monospace' }}>{p.count}</span>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  )
}

const th: CSSProperties = { padding: '4px 8px', textTransform: 'uppercase', fontSize: 10, letterSpacing: 0.5 }
const td: CSSProperties = { padding: '4px 8px', fontFamily: 'JetBrains Mono, monospace' }
