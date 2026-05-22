'use client'
// components/pages/PropFirmPage.tsx — Prop-firm evaluation dashboard + settings

import { useState, useEffect, useCallback } from 'react'
import { Panel } from '../ui'
import { authFetch } from '@/lib/api'
import { calcPropFirmStatus, FIRM_PRESETS, DEFAULT_PROP_FIRM, type PropFirmSettings } from '@/lib/propfirm'

const FIRMS = [
  { key: 'ftmo',       label: 'FTMO',         color: '#00c060' },
  { key: 'mff',        label: 'Funded Next',  color: '#0080ff' },
  { key: 'the5ers',    label: 'Funding Pips', color: '#ffb800' },
  { key: 'equityedge', label: 'Equity Edge',  color: '#00c0d0' },
  { key: 'custom',     label: 'Custom',       color: '#9060c0' },
]
const PHASES = ['evaluation', 'verification', 'funded'] as const

interface PropFirmPageProps {
  trades: any[]
  onToast: (msg: string, color?: string) => void
}

export default function PropFirmPage({ trades, onToast }: PropFirmPageProps) {
  const [settings, setSettings] = useState<PropFirmSettings>(DEFAULT_PROP_FIRM)
  const [rawInputs, setRawInputs] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    authFetch('/api/prop-firm').then(r => r.json()).then(d => {
      if (d.settings) setSettings(d.settings)
    }).catch(() => {}).finally(() => setLoading(false))
  }, [])

  const save = useCallback(async () => {
    setSaving(true)
    try {
      await authFetch('/api/prop-firm', { method: 'POST', body: JSON.stringify({ settings }) })
      onToast('Prop firm settings saved', '#00ff87')
    } catch (e: any) {
      onToast('Save failed: ' + e.message, '#ff3056')
    } finally { setSaving(false) }
  }, [settings, onToast])

  function applyPreset(firmType: string) {
    const preset = FIRM_PRESETS[firmType] || FIRM_PRESETS.custom
    setSettings(s => ({ ...s, firmType: firmType as any, ...preset }))
    setRawInputs({})  // clear draft so preset values show immediately
  }

  // Calculate live status from trades
  const today = new Date().toDateString()
  const todayPL = trades.filter(t => t.closed_at && new Date(t.closed_at).toDateString() === today)
    .reduce((s: number, t: any) => s + (t.pl_usd || 0), 0)
  const allTimePL = trades.reduce((s: number, t: any) => s + (t.pl_usd || 0), 0)
  const tradingDays = new Set(
    trades.filter(t => t.closed_at).map(t => new Date(t.closed_at).toDateString())
  ).size
  const dailyPLs = trades
    .filter(t => t.closed_at && (t.pl_usd || 0) > 0)
    .reduce((acc: Record<string, number>, t) => {
      const d = new Date(t.closed_at).toDateString()
      acc[d] = (acc[d] || 0) + t.pl_usd
      return acc
    }, {})
  const maxDailyProfit = Math.max(0, ...Object.values(dailyPLs))

  const status = calcPropFirmStatus(settings, todayPL, allTimePL, tradingDays, maxDailyProfit)

  if (loading) return <div style={{ padding: 40, color: 'var(--text-muted)', textAlign: 'center' }}>Loading…</div>

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, maxWidth: 900 }}>

      {/* Enable toggle + firm selector */}
      <Panel title="PROP FIRM EVALUATION MODE" bright>
        <div style={{ padding: '14px 16px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap', marginBottom: 20 }}>
            <button
              onClick={() => setSettings(s => ({ ...s, enabled: !s.enabled }))}
              style={{
                padding: '10px 24px', borderRadius: 4, cursor: 'pointer',
                fontFamily: 'Rajdhani', fontWeight: 700, fontSize: 14, letterSpacing: 2,
                background: settings.enabled ? 'rgba(0,255,135,0.12)' : 'rgba(255,255,255,0.04)',
                border: `1px solid ${settings.enabled ? 'rgba(0,255,135,0.4)' : 'var(--border)'}`,
                color: settings.enabled ? '#00ff87' : 'var(--text-muted)',
              }}
            >
              {settings.enabled ? '✓ PROP FIRM MODE ACTIVE' : 'ENABLE PROP FIRM MODE'}
            </button>
            {settings.enabled && (
              <div style={{ display: 'flex', gap: 6 }}>
                {PHASES.map(p => (
                  <button key={p} className={`tab-btn ${settings.phase === p ? 'active' : ''}`}
                    onClick={() => setSettings(s => ({ ...s, phase: p }))}>
                    {p.charAt(0).toUpperCase() + p.slice(1)}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Firm presets */}
          <div style={{ marginBottom: 20 }}>
            <div style={{ fontSize: 10, color: 'var(--text-muted)', letterSpacing: 1, marginBottom: 10 }}>SELECT FIRM</div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {FIRMS.map(f => (
                <button
                  key={f.key}
                  onClick={() => applyPreset(f.key)}
                  style={{
                    padding: '8px 18px', borderRadius: 3, cursor: 'pointer',
                    fontFamily: 'Rajdhani', fontWeight: 700, fontSize: 13, letterSpacing: 1,
                    background: settings.firmType === f.key ? `${f.color}18` : 'rgba(255,255,255,0.04)',
                    border: `1px solid ${settings.firmType === f.key ? f.color + '60' : 'var(--border)'}`,
                    color: settings.firmType === f.key ? f.color : 'var(--text-muted)',
                  }}
                >
                  {f.label}
                </button>
              ))}
            </div>
          </div>

          {/* Equity Edge — extra rules note */}
          {settings.firmType === 'equityedge' && (
            <div style={{
              marginBottom: 20, padding: '10px 14px', fontSize: 12,
              background: 'rgba(0,192,208,0.06)', border: '1px solid rgba(0,192,208,0.25)',
              borderRadius: 3, color: '#80d8e0', lineHeight: 1.7,
            }}>
              <div style={{ fontWeight: 700, marginBottom: 6, color: '#00c0d0' }}>Equity Edge — additional rules to apply manually</div>
              <div>• Max risk per trade: <strong>1%</strong> of account balance (set in Strategy Settings)</div>
              <div>• Safety cushion: <strong>3%</strong> — Equity Edge may close accounts approaching this buffer</div>
              <div>• Leverage: up to <strong>1:30</strong></div>
              <div>• Trading period: <strong>Unlimited</strong> — no time pressure, focus on consistency</div>
              <div>• Inactivity rule: account closes after <strong>30 days</strong> of no trades</div>
              <div>• Trailing drawdown: 5% calculated from <strong>highest equity point</strong>, not initial balance</div>
            </div>
          )}

          {/* Rule settings grid */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 14, marginBottom: 20 }}>
            {[
              { label: 'Account Size ($)', key: 'accountSize', min: 1000 },
              { label: 'Initial Balance ($)', key: 'initialBalance', min: 1000 },
              { label: 'Max Daily Loss (%)', key: 'maxDailyLossPct', min: 0.5, step: 0.5 },
              { label: 'Max Total Drawdown (%)', key: 'maxTotalDrawdownPct', min: 1, step: 0.5 },
              { label: 'Profit Target (%)', key: 'profitTargetPct', min: 1, step: 0.5 },
              { label: 'Min Trading Days', key: 'minTradingDays', min: 0 },
              { label: 'Consistency Rule (%)', key: 'consistencyRulePct', min: 0, max: 100 },
            ].map(({ label, key, min = 0, ...rest }) => (
              <div key={key}>
                <label style={{ fontSize: 10, color: 'var(--text-muted)', letterSpacing: 1, display: 'block', marginBottom: 4 }}>{label}</label>
                <input
                  type="text"
                  inputMode="decimal"
                  value={key in rawInputs ? rawInputs[key] : String((settings as any)[key] ?? '')}
                  onChange={e => setRawInputs(ri => ({ ...ri, [key]: e.target.value }))}
                  onBlur={e => {
                    const num = parseFloat(e.target.value)
                    const final = isNaN(num) ? min : Math.max(min, num)
                    setSettings(s => ({ ...s, [key]: final }))
                    setRawInputs(ri => { const n = { ...ri }; delete n[key]; return n })
                  }}
                  style={{
                    width: '100%', padding: '8px 10px', borderRadius: 3, boxSizing: 'border-box' as const,
                    background: 'rgba(0,0,0,0.3)', border: '1px solid var(--border)',
                    color: 'var(--text-primary)', fontSize: 13, fontFamily: 'JetBrains Mono',
                  }}
                />
              </div>
            ))}
          </div>

          {/* Toggle rules */}
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 20 }}>
            {[
              { key: 'noOvernight', label: 'No Overnight Positions' },
              { key: 'noWeekend', label: 'No Weekend Trading' },
              { key: 'newsRestriction', label: 'No News Trading' },
            ].map(({ key, label }) => (
              <button
                key={key}
                onClick={() => setSettings(s => ({ ...s, [key]: !(s as any)[key] }))}
                style={{
                  padding: '6px 14px', borderRadius: 3, cursor: 'pointer', fontSize: 12,
                  background: (settings as any)[key] ? 'rgba(0,128,255,0.1)' : 'rgba(255,255,255,0.04)',
                  border: `1px solid ${(settings as any)[key] ? 'rgba(0,128,255,0.4)' : 'var(--border)'}`,
                  color: (settings as any)[key] ? '#60c0ff' : 'var(--text-muted)',
                }}
              >
                {(settings as any)[key] ? '✓' : '○'} {label}
              </button>
            ))}
          </div>

          <button
            onClick={save} disabled={saving}
            className="btn" style={{ padding: '10px 28px', fontSize: 13 }}
          >
            {saving ? 'Saving…' : 'SAVE SETTINGS'}
          </button>
        </div>
      </Panel>

      {/* Live compliance dashboard */}
      {settings.enabled && (
        <Panel title="LIVE COMPLIANCE STATUS" bright>
          <div style={{ padding: '14px 16px' }}>

            {/* Block/warn alerts */}
            {status.blockReasons.map((r, i) => (
              <div key={i} style={{
                padding: '10px 14px', borderRadius: 3, marginBottom: 10, fontSize: 12,
                background: 'rgba(255,48,86,0.08)', border: '1px solid rgba(255,48,86,0.25)', color: '#ff6060',
              }}>
                🚫 {r}
              </div>
            ))}
            {status.warnReasons.map((r, i) => (
              <div key={i} style={{
                padding: '10px 14px', borderRadius: 3, marginBottom: 10, fontSize: 12,
                background: 'rgba(255,184,0,0.06)', border: '1px solid rgba(255,184,0,0.2)', color: '#c09050',
              }}>
                ⚠ {r}
              </div>
            ))}
            {!status.blockReasons.length && !status.warnReasons.length && (
              <div style={{
                padding: '10px 14px', borderRadius: 3, marginBottom: 14, fontSize: 12,
                background: 'rgba(0,255,135,0.06)', border: '1px solid rgba(0,255,135,0.2)', color: '#00c060',
              }}>
                ✓ All rules compliant — safe to trade
              </div>
            )}

            {/* Metrics grid */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 12 }}>
              <MetricBar
                label="Daily Loss"
                value={Math.abs(status.dailyLoss)}
                limit={status.dailyLossLimit}
                pct={status.dailyLossPct}
                maxPct={settings.maxDailyLossPct}
                danger={status.dailyLossLimitHit}
                prefix="-$"
                color="#ff3056"
              />
              <MetricBar
                label="Total Drawdown"
                value={Math.abs(status.totalDrawdown)}
                limit={status.totalDrawdownLimit}
                pct={status.totalDrawdownPct}
                maxPct={settings.maxTotalDrawdownPct}
                danger={status.maxDrawdownHit}
                prefix="-$"
                color="#ff6030"
              />
              <MetricBar
                label="Profit Progress"
                value={status.profitToDate}
                limit={status.profitTarget}
                pct={status.profitPct}
                maxPct={settings.profitTargetPct}
                danger={false}
                success={status.targetReached}
                prefix="+$"
                color="#00ff87"
              />
            </div>

            {/* Stats row */}
            <div style={{ display: 'flex', gap: 24, marginTop: 16, flexWrap: 'wrap' }}>
              <StatItem
                label="Trading Days"
                value={`${status.tradingDaysCount} / ${settings.minTradingDays}`}
                ok={status.minTradingDaysMet}
              />
              <StatItem
                label="Phase"
                value={settings.phase.charAt(0).toUpperCase() + settings.phase.slice(1)}
                ok={true}
              />
              <StatItem
                label="Consistency"
                value={status.consistencyOk ? 'OK' : 'BREACHED'}
                ok={status.consistencyOk}
              />
              <StatItem
                label="Evaluation"
                value={status.passedEvaluation ? '✓ PASSED' : 'IN PROGRESS'}
                ok={status.passedEvaluation}
              />
            </div>
          </div>
        </Panel>
      )}

      {/* FTMO rules reference */}
      <Panel title="PROP FIRM RULES REFERENCE">
        <div style={{ padding: '14px 16px', display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 14 }}>
          {[
            { firm: 'FTMO', phase1: '10%', phase2: '5%', daily: '5%', dd: '10%', days: '4', color: '#00c060' },
            { firm: 'Funded Next',  phase1: '8%', phase2: '5%', daily: '5%', dd: '12%', days: '5',  color: '#0080ff' },
            { firm: 'Funding Pips', phase1: '6%', phase2: '—', daily: '4%', dd: '8%',  days: '—', color: '#ffb800' },
            { firm: 'Equity Edge',  phase1: '10%', phase2: '—', daily: '3%', dd: '5%',  days: '7',  color: '#00c0d0' },
          ].map(f => (
            <div key={f.firm} style={{ background: `${f.color}08`, border: `1px solid ${f.color}25`, borderRadius: 4, padding: 14 }}>
              <div style={{ fontFamily: 'Rajdhani', fontWeight: 700, fontSize: 15, color: f.color, marginBottom: 10 }}>{f.firm}</div>
              {[
                ['Phase 1 Target', f.phase1], ['Phase 2 Target', f.phase2],
                ['Max Daily Loss', f.daily], ['Max Drawdown', f.dd], ['Min Days', f.days],
              ].map(([k, v]) => (
                <div key={k} style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4, fontSize: 12 }}>
                  <span style={{ color: 'var(--text-muted)' }}>{k}</span>
                  <span className="mono" style={{ color: 'var(--text-secondary)' }}>{v}</span>
                </div>
              ))}
            </div>
          ))}
        </div>
      </Panel>
    </div>
  )
}

function MetricBar({ label, value, limit, pct, maxPct, danger, success, prefix, color }: any) {
  const fill = Math.min(100, (pct / maxPct) * 100)
  const barColor = danger ? '#ff3056' : success ? '#00ff87' : color
  return (
    <div style={{ background: 'rgba(0,0,0,0.2)', borderRadius: 4, padding: '12px 14px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
        <span style={{ fontSize: 10, color: 'var(--text-muted)', letterSpacing: 1 }}>{label.toUpperCase()}</span>
        <span className="mono" style={{ fontSize: 12, color: barColor, fontWeight: 700 }}>
          {prefix}{value.toFixed(2)} / {prefix}{limit.toFixed(2)}
        </span>
      </div>
      <div style={{ height: 4, background: 'rgba(255,255,255,0.06)', borderRadius: 2, overflow: 'hidden' }}>
        <div style={{ height: '100%', width: `${fill}%`, background: barColor, borderRadius: 2, transition: 'width 0.4s' }} />
      </div>
      <div style={{ fontSize: 10, color: 'var(--text-dim)', marginTop: 4 }}>
        {pct.toFixed(1)}% of {maxPct}% limit
      </div>
    </div>
  )
}

function StatItem({ label, value, ok }: { label: string; value: string; ok: boolean }) {
  return (
    <div>
      <div style={{ fontSize: 10, color: 'var(--text-muted)', letterSpacing: 1 }}>{label}</div>
      <div style={{ fontSize: 14, fontWeight: 700, color: ok ? '#00ff87' : '#ff6060', fontFamily: 'Rajdhani', marginTop: 2 }}>{value}</div>
    </div>
  )
}
