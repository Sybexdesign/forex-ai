'use client'
// components/pages/StrategyPage.tsx

import { useState } from 'react'
import { Panel, LoadingDots } from '../ui'
import type { StrategySettings } from '@/lib/supabase'

const PAIRS = ['EUR/USD', 'GBP/USD', 'USD/JPY', 'AUD/USD', 'XAU/USD']
const STYLES = ['Scalper', 'Day Trader', 'Swing', 'Position'] as const

const STYLE_DESCRIPTIONS: Record<string, string> = {
  Scalper: 'Very short trades, 5–15 min. High frequency, tight stops. Reduced TP/SL defaults.',
  'Day Trader': 'Intraday trades closed before session end. Balanced risk/reward.',
  Swing: 'Multi-day trades following larger trends. Wider stops, bigger targets.',
  Position: 'Week-to-month holds. Fundamental + technical confluence required.',
}

interface SliderRowProps {
  label: string
  value: number
  min: number
  max: number
  step: number
  unit?: string
  onChange: (v: number) => void
  color?: string
  description?: string
}

function SliderRow({ label, value, min, max, step, unit = '', onChange, color = '#0080ff', description }: SliderRowProps) {
  const pct = ((value - min) / (max - min)) * 100
  return (
    <div style={{ marginBottom: 22 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 10 }}>
        <div>
          <span style={{ fontSize: 14, color: 'var(--text-secondary)', fontWeight: 600 }}>{label}</span>
          {description && (
            <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>{description}</div>
          )}
        </div>
        <span className="mono" style={{ fontSize: 18, color, fontWeight: 700 }}>
          {value}{unit}
        </span>
      </div>
      <div style={{ position: 'relative' }}>
        <input
          type="range" min={min} max={max} step={step} value={value}
          onChange={e => onChange(+e.target.value)}
          style={{
            background: `linear-gradient(90deg, ${color}60 ${pct}%, var(--border) ${pct}%)`
          }}
        />
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: 'var(--text-dim)', marginTop: 4 }}>
        <span>{min}{unit}</span>
        <span>{max}{unit}</span>
      </div>
    </div>
  )
}

interface HardRuleRowProps {
  icon: string
  label: string
  description: string
  enabled: boolean
  onChange: () => void
}

function HardRuleRow({ icon, label, description, enabled, onChange }: HardRuleRowProps) {
  const [confirming, setConfirming] = useState(false)

  function handleToggle() {
    if (enabled) {
      if (!confirming) {
        setConfirming(true)
        setTimeout(() => setConfirming(false), 3000)
        return
      }
    }
    setConfirming(false)
    onChange()
  }

  return (
    <div style={{
      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      padding: '12px 0', borderBottom: '1px solid var(--border)'
    }}>
      <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start', flex: 1, marginRight: 16 }}>
        <span style={{ fontSize: 18, flexShrink: 0 }}>{icon}</span>
        <div>
          <div style={{ fontSize: 14, color: 'var(--text-secondary)', fontWeight: 600 }}>{label}</div>
          <div style={{ fontSize: 11, color: confirming ? '#ffb800' : 'var(--text-muted)', marginTop: 2 }}>
            {confirming ? '⚠ Click again to confirm disable' : description}
          </div>
        </div>
      </div>
      <button
        onClick={handleToggle}
        style={{
          width: 44, height: 24, borderRadius: 12, cursor: 'pointer',
          border: 'none', flexShrink: 0,
          background: enabled
            ? 'linear-gradient(90deg,#004d28,#00803a)'
            : 'linear-gradient(90deg,#1a2940,#1a2940)',
          position: 'relative', transition: 'background 0.2s',
          boxShadow: enabled ? '0 0 8px rgba(0,200,80,0.3)' : 'none',
        }}
      >
        <div style={{
          position: 'absolute', top: 3,
          left: enabled ? 22 : 3,
          width: 18, height: 18, borderRadius: 9,
          background: enabled ? '#00ff87' : '#405060',
          transition: 'left 0.2s, background 0.2s',
          boxShadow: enabled ? '0 0 6px rgba(0,255,135,0.6)' : 'none',
        }} />
      </button>
    </div>
  )
}

interface StrategyPageProps {
  strategy: StrategySettings
  onSave: (s: StrategySettings) => Promise<void>
}

export default function StrategyPage({ strategy, onSave }: StrategyPageProps) {
  const [local, setLocal] = useState<StrategySettings>({ ...strategy })
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)

  const set = <K extends keyof StrategySettings>(key: K, value: StrategySettings[K]) => {
    setLocal(s => ({ ...s, [key]: value }))
    setSaved(false)
  }

  const togglePair = (pair: string) => {
    const wl = local.watchlist || []
    set('watchlist', wl.includes(pair) ? wl.filter(p => p !== pair) : [...wl, pair])
  }

  async function handleSave() {
    setSaving(true)
    await onSave(local)
    setSaving(false)
    setSaved(true)
    setTimeout(() => setSaved(false), 3000)
  }

  // Risk:Reward ratio
  const rr = (local.tpPips / local.slPips).toFixed(1)
  const rrColor = +rr >= 2 ? '#00ff87' : +rr >= 1.5 ? '#ffb800' : '#ff3056'

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, maxWidth: 860 }}>

      {/* Trading Style */}
      <Panel title="TRADING STYLE">
        <div style={{ padding: '14px 16px 16px' }}>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 14 }}>
            {STYLES.map(s => (
              <button
                key={s}
                className={`tab-btn ${local.style === s ? 'active' : ''}`}
                onClick={() => set('style', s)}
                style={{ padding: '8px 22px', fontSize: 14 }}
              >
                {s}
              </button>
            ))}
          </div>
          <div style={{
            fontSize: 13, color: 'var(--text-muted)',
            background: 'rgba(0,128,255,0.06)', border: '1px solid rgba(0,128,255,0.15)',
            borderRadius: 3, padding: '8px 12px'
          }}>
            {STYLE_DESCRIPTIONS[local.style]}
          </div>
        </div>
      </Panel>

      {/* Risk settings */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
        <Panel title="POSITION RISK">
          <div style={{ padding: '14px 18px 4px' }}>
            <SliderRow
              label="Risk per trade" value={local.riskPct} min={0.5} max={5} step={0.5} unit="%"
              onChange={v => set('riskPct', v)} color="#0080ff"
              description="% of account balance risked per trade"
            />
            <SliderRow
              label="Max daily loss" value={local.maxLoss} min={2} max={10} step={0.5} unit="%"
              onChange={v => set('maxLoss', v)} color="#ff6060"
              description="Trading halts if daily loss exceeds this"
            />
            <SliderRow
              label="Max open positions" value={local.maxPositions} min={1} max={6} step={1}
              onChange={v => set('maxPositions', v)} color="#ffb800"
              description="Maximum simultaneous open trades"
            />
            <SliderRow
              label="Min signal strength" value={local.minStrength} min={50} max={90} step={5} unit="%"
              onChange={v => set('minStrength', v)} color="#00c0ff"
              description="AI confidence minimum to consider trading"
            />
          </div>
        </Panel>

        <Panel title="TRADE PARAMETERS">
          <div style={{ padding: '14px 18px 4px' }}>
            <SliderRow
              label="Take profit" value={local.tpPips} min={10} max={200} step={5} unit=" pips"
              onChange={v => set('tpPips', v)} color="#00ff87"
              description="Target pips per trade"
            />
            <SliderRow
              label="Stop loss" value={local.slPips} min={5} max={80} step={5} unit=" pips"
              onChange={v => set('slPips', v)} color="#ff3056"
              description="Max loss pips before auto-close"
            />

            {/* R:R display */}
            <div style={{
              background: 'rgba(0,0,0,0.2)', borderRadius: 3, padding: '10px 14px',
              display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 22
            }}>
              <div>
                <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 3 }}>Risk:Reward Ratio</div>
                <div style={{ fontSize: 11, color: 'var(--text-dim)' }}>
                  {local.slPips}p risk → {local.tpPips}p target
                </div>
              </div>
              <div style={{ textAlign: 'right' }}>
                <div className="mono" style={{ fontSize: 24, fontWeight: 700, color: rrColor, lineHeight: 1 }}>
                  1:{rr}
                </div>
                <div style={{ fontSize: 10, color: rrColor, marginTop: 2 }}>
                  {+rr >= 2 ? '✓ EXCELLENT' : +rr >= 1.5 ? '~ ACCEPTABLE' : '✗ POOR'}
                </div>
              </div>
            </div>

            {/* Position size preview */}
            <div style={{
              background: 'rgba(0,128,255,0.06)', border: '1px solid rgba(0,128,255,0.15)',
              borderRadius: 3, padding: '10px 14px'
            }}>
              <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 6 }}>AUTO POSITION SIZE (on $10,000 balance)</div>
              {['EUR/USD', 'USD/JPY', 'XAU/USD'].map(pair => {
                const pipVal = pair === 'USD/JPY' ? 6.8 : pair === 'XAU/USD' ? 10 : 10
                const lots = Math.max(0.01, Math.min((10000 * local.riskPct / 100) / (local.slPips * pipVal), 10)).toFixed(2)
                return (
                  <div key={pair} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 4 }}>
                    <span style={{ color: 'var(--text-muted)' }}>{pair}</span>
                    <span className="mono" style={{ color: '#60c0ff' }}>{lots} lots</span>
                  </div>
                )
              })}
            </div>
          </div>
        </Panel>
      </div>

      {/* Watchlist */}
      <Panel title="CURRENCY WATCHLIST">
        <div style={{ padding: '14px 16px 16px' }}>
          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 12 }}>
            Select pairs to monitor. AI signals will only be generated for active pairs.
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {PAIRS.map(pair => {
              const active = (local.watchlist || []).includes(pair)
              return (
                <button
                  key={pair}
                  className={`tab-btn ${active ? 'active' : ''}`}
                  onClick={() => togglePair(pair)}
                  style={{ padding: '9px 20px', fontSize: 14 }}
                >
                  {active ? '✓ ' : ''}{pair}
                </button>
              )
            })}
          </div>
          {(local.watchlist || []).length === 0 && (
            <div style={{ marginTop: 10, fontSize: 12, color: '#ff6060' }}>
              ⚠ At least one pair must be selected
            </div>
          )}
        </div>
      </Panel>

      {/* Hard rules */}
      <Panel title="HARD RISK RULES">
        <div style={{ padding: '0 16px 4px' }}>
          <div style={{ fontSize: 12, color: 'var(--text-muted)', padding: '10px 0 4px' }}>
            These rules are enforced automatically. Disabling requires double confirmation.
          </div>
          <HardRuleRow
            icon="🛑" label="Stop trading after daily loss limit"
            description="Automatically blocks all new trades once daily loss limit is hit"
            enabled={local.hardDailyStop}
            onChange={() => set('hardDailyStop', !local.hardDailyStop)}
          />
          <HardRuleRow
            icon="📰" label="No trading 30min around red news events"
            description="Blocks orders when high-impact news is within ±30 minutes"
            enabled={local.hardNews}
            onChange={() => set('hardNews', !local.hardNews)}
          />
          <HardRuleRow
            icon="🔒" label="Demo mode lock (prevent live account trading)"
            description="Forces all orders to OANDA practice account. Unlock to go live."
            enabled={local.demoLock}
            onChange={() => set('demoLock', !local.demoLock)}
          />
        </div>
      </Panel>

      {/* Session hours */}
      <Panel title="ACTIVE TRADING HOURS (UTC)">
        <div style={{ padding: '14px 16px 16px' }}>
          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 14 }}>
            AI will only generate signals during these hours. Outside this window signals are marked as low-priority.
          </div>
          <div style={{ display: 'flex', gap: 16, alignItems: 'flex-end', flexWrap: 'wrap' }}>
            <div>
              <div style={{ fontSize: 11, color: 'var(--text-muted)', letterSpacing: 1, marginBottom: 6 }}>START HOUR</div>
              <input
                type="number" min={0} max={23} value={local.sessionStart}
                onChange={e => set('sessionStart', Math.max(0, Math.min(23, +e.target.value)))}
                style={{ width: 80 }}
              />
              <div style={{ fontSize: 10, color: 'var(--text-dim)', marginTop: 4 }}>0–23 UTC</div>
            </div>
            <div style={{ paddingBottom: 18, color: 'var(--text-muted)', fontSize: 20 }}>→</div>
            <div>
              <div style={{ fontSize: 11, color: 'var(--text-muted)', letterSpacing: 1, marginBottom: 6 }}>END HOUR</div>
              <input
                type="number" min={0} max={23} value={local.sessionEnd}
                onChange={e => set('sessionEnd', Math.max(0, Math.min(23, +e.target.value)))}
                style={{ width: 80 }}
              />
              <div style={{ fontSize: 10, color: 'var(--text-dim)', marginTop: 4 }}>0–23 UTC</div>
            </div>
            {/* Session presets */}
            <div style={{ paddingBottom: 2 }}>
              <div style={{ fontSize: 11, color: 'var(--text-muted)', letterSpacing: 1, marginBottom: 6 }}>PRESETS</div>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {[
                  { label: 'London', start: 7, end: 16 },
                  { label: 'NY', start: 13, end: 22 },
                  { label: 'Asian', start: 23, end: 8 },
                  { label: 'All Day', start: 0, end: 24 },
                ].map(preset => (
                  <button
                    key={preset.label}
                    className="tab-btn"
                    onClick={() => { set('sessionStart', preset.start); set('sessionEnd', preset.end) }}
                    style={{ fontSize: 11, padding: '4px 10px' }}
                  >
                    {preset.label}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {/* Session visual */}
          <div style={{ marginTop: 14 }}>
            <div style={{ height: 8, background: 'var(--border)', borderRadius: 4, position: 'relative', overflow: 'hidden' }}>
              <div style={{
                position: 'absolute',
                left: `${(local.sessionStart / 24) * 100}%`,
                width: `${((local.sessionEnd - local.sessionStart) / 24) * 100}%`,
                height: '100%', background: '#0080ff', borderRadius: 4,
                boxShadow: '0 0 8px rgba(0,128,255,0.5)',
              }} />
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 9, color: 'var(--text-dim)', marginTop: 4 }}>
              {[0, 4, 8, 12, 16, 20, 24].map(h => <span key={h}>{h}:00</span>)}
            </div>
          </div>
        </div>
      </Panel>

      {/* Save button */}
      <button
        className="btn btn-primary"
        onClick={handleSave}
        disabled={saving || (local.watchlist || []).length === 0}
        style={{ padding: '14px', fontSize: 15, letterSpacing: 2 }}
      >
        {saving
          ? <LoadingDots />
          : saved
          ? '✓ SETTINGS SAVED'
          : 'SAVE STRATEGY SETTINGS'
        }
      </button>
    </div>
  )
}
