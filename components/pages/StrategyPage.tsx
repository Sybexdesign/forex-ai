'use client'
// components/pages/StrategyPage.tsx

import { useState, useEffect, useRef } from 'react'
import { Panel, LoadingDots } from '../ui'
import type { StrategySettings } from '@/lib/supabase'
import { PAIR_GROUPS, PAIR_LABELS, HIGH_VOLATILITY_PAIRS, getIndexSession } from '@/lib/instruments'
import { MAX_RISK_PCT, MAX_LOTS } from '@/lib/trade-levels'
import { validateLotSize, lotSizeToText, isPartialLotInput } from '@/lib/lot-size.mjs'
import { buildStrategySizingView, validateManualRiskPct, isPartialRiskInput, geometryForPair } from '@/lib/strategy-sizing-view.mjs'
import { DEFAULT_STRATEGY } from '@/lib/supabase'
import { currencySymbol } from '@/lib/currency'
const STYLES = ['Scalper', 'Day Trader', 'Swing', 'Position'] as const



// Status → colour. Deliberately descriptive: a large Manual exposure is shown
// plainly (red above the AUTO risk level) and never labelled "safe".
function statusColor(status: string): string {
  return status === 'EXECUTABLE' ? '#00ff87'
       : status === 'CANNOT_EXECUTE' ? '#ff3056'
       : '#ffb800'
}
// Exposure colour by actual account risk %. Purely descriptive emphasis.
function exposureColor(pct: number | null): string {
  if (pct == null) return 'var(--text-dim)'
  return pct >= 20 ? '#ff3056' : pct >= 10 ? '#ffb800' : '#00ff87'
}

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
  // Live account snapshot from useAccount(). Optional — the page renders fine
  // without it, but the manual-lots dollar-risk preview uses balance +
  // profitFixedUsd/profitTargetPct from this object when present.
  account?: {
    balance?: number
    currency?: string
    profitFixedUsd?: number | null
    profitTargetPct?: number | null
  } | null

}

export default function StrategyPage({ strategy, onSave, account }: StrategyPageProps) {
  const [local, setLocal] = useState<StrategySettings>({ ...strategy })
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)

  // ── Manual lot size: a STRING DRAFT, separate from the committed number ─────
  // The committed value is a number|null (null = auto-size). The draft is what
  // the user is typing. Keeping them apart is what allows the field to be
  // cleared , to hold "0." mid-edit, and to hold an invalid value long enough for
  // the user to see why it was rejected — none of which a number-bound input can
  // express. Committed only on blur via validateLotSize().
  const [lotsText, setLotsText] = useState<string>(() => lotSizeToText(strategy.manualLots))
  const [lotsError, setLotsError] = useState<string | null>(null)

  // ── Manual Risk %: the SAME draft/commit contract as Manual Lots ───────────
  // A string draft, committed on blur. Empty must stay empty (never `0`), and the
  // two fields are strictly independent — editing one never rewrites the other.
  // The allowed range is the canonical one from lib/manual-sizing.mjs, not a new
  // frontend range.
  //
  // Unlike Manual Lots, the draft is held as `null` = "no active edit", so the field
  // DISPLAYS the committed value by DERIVATION rather than by copying it into state
  // from an effect. When the committed value changes from outside (strategy reload,
  // reset), the displayed text simply follows it — no sync step, and therefore no
  // stale-draft bug and no state update inside an effect.
  const [riskDraft, setRiskDraft] = useState<string | null>(null)
  const [riskError, setRiskError] = useState<string | null>(null)
  const riskText = riskDraft ?? (local.manualRiskPct == null ? '' : String(local.manualRiskPct))

  // Re-sync the draft when the COMMITTED value changes from outside (initial
  // load, strategy refresh, reset). Guarded so it never clobbers in-progress
  // typing: if the draft already parses to the incoming value, it is left alone.
  useEffect(() => {
    const committed = validateLotSize(local.manualLots, { max: MAX_LOTS })
    const next = committed.ok && !committed.empty && committed.value != null ? String(committed.value) : ''
    setLotsText(prev => (prev.trim() === next ? prev : next))
    setLotsError(null)
  }, [local.manualLots])
  const hasEdited = useRef(false)

  // Sync when the parent loads DB data after this component has already mounted.
  // Only applies until the user makes their first edit — after that, local state is authoritative.
  useEffect(() => {
    if (!hasEdited.current) {
      setLocal({ ...strategy })
    }
  }, [strategy]) // eslint-disable-line react-hooks/exhaustive-deps

  const set = <K extends keyof StrategySettings>(key: K, value: StrategySettings[K]) => {
    hasEdited.current = true
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
    hasEdited.current = false
    setTimeout(() => setSaved(false), 3000)
  }

  // Risk:Reward ratio
  const rr = (local.tpPips / local.slPips).toFixed(1)
  const rrColor = +rr >= 2 ? '#00ff87' : +rr >= 1.5 ? '#ffb800' : '#ff3056'

  // Live account balance for position-sizing previews. Pulled from the `account`
  // prop (useAccount → /api/account, refreshed every 3s). Falls back to a $10k
  // reference only when the broker isn't synced yet.
  const liveBalance      = typeof account?.balance === 'number' && account.balance > 0 ? account.balance : 0
  // Falls back to a $10k reference only when the broker isn't synced yet — the AUTO
  // position-size table below uses this. The MANUAL preview deliberately does NOT:
  // it reports AWAITING_DATA rather than pre-filling a preview from a fake balance.
  const refBalance       = liveBalance > 0 ? liveBalance : 10000

  // ── The ONE sizing view-model for this page ─────────────────────────────────
  // Built from the same policy /api/orders executes. The page renders this and
  // performs no sizing arithmetic of its own. `defaultManualRiskPct` is the
  // canonical DEFAULT_STRATEGY value — the policy deliberately carries no default.
  const previewPair = 'XAU/USD'
  const sizingView = buildStrategySizingView({
    manualLots:           local.manualLots,
    manualRiskPct:        local.manualRiskPct,
    defaultManualRiskPct: DEFAULT_STRATEGY.manualRiskPct,
    autoRiskPct:          local.riskPct,          // context only — never a Manual input
    // A zero balance means "not synced yet" — the view model reports
    // AWAITING_DATA rather than inventing a number.
    balance:              liveBalance,
    pair:                 previewPair,
    currency:             account?.currency,
    strategySlPips:       local.slPips,
    strategyTpPips:       local.tpPips,
    ...geometryForPair(previewPair),
  })

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
      <div className="grid-2col">
        <Panel title="POSITION RISK">
          <div style={{ padding: '14px 18px 4px' }}>
            <SliderRow
              label="Risk per trade" value={local.riskPct} min={0.5} max={MAX_RISK_PCT} step={0.5} unit="%"
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
              label="Take profit" value={local.tpPips} min={10} max={200} step={1} unit=" pips"
              onChange={v => set('tpPips', v)} color="#00ff87"
              description="Target pips per trade"
            />
            <SliderRow
              label="Stop loss" value={local.slPips} min={5} max={80} step={1} unit=" pips"
              onChange={v => set('slPips', v)} color="#ff3056"
              description="Stop loss distance in pips"
            />
            {/* Auto-trade floor/cap explainer (Option C — MIRROR_SL_CAP in AutoTradePage). */}
            <div style={{
              background: 'rgba(0,128,255,0.06)',
              border:     '1px solid rgba(0,128,255,0.18)',
              borderRadius: 3,
              padding:   '8px 12px',
              fontSize:  11,
              lineHeight: 1.5,
              color:     'var(--text-secondary)',
              marginBottom: 16,
            }}>
              ℹ This is the <b>minimum</b> SL. Auto-trade may widen up to 25 pips based on
              market volatility — the engine's ATR-derived SL is used when it sits between
              this value and the 25-pip cap.
            </div>

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

            {/* Position size preview — sized against the LIVE account balance
                (from /api/account via the `account` prop, refreshed every 3s),
                falling back to a $10k reference only when the broker isn't
                synced. Previously hardcoded to $10,000, which under-sized
                positions on larger accounts and over-sized on smaller ones. */}
            <div style={{
              background: 'rgba(0,128,255,0.06)', border: '1px solid rgba(0,128,255,0.15)',
              borderRadius: 3, padding: '10px 14px'
            }}>
              <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 6 }}>
                AUTO POSITION SIZE{liveBalance > 0 ? ` (LIVE ${currencySymbol(account?.currency)}${liveBalance.toLocaleString()} BAL)` : ` (REF ${currencySymbol(account?.currency)}10K BAL — connect broker for live)`}
              </div>

              {['EUR/USD', 'USD/JPY', 'XAU/USD'].map(pair => {
                const pipVal = pair === 'USD/JPY' ? 6.8 : pair === 'XAU/USD' ? 10 : 10
                const lots = Math.max(0.01, Math.min((refBalance * local.riskPct / 100) / (local.slPips * pipVal), MAX_LOTS)).toFixed(2)
                return (
                  <div key={pair} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 4 }}>
                    <span style={{ color: 'var(--text-muted)' }}>{pair}</span>
                    <span className="mono" style={{ color: '#60c0ff' }}>{lots} lots</span>
                  </div>
                )
              })}
            </div>


            {/* Manual lot-size override — bypasses balance×risk auto-sizing.
                Hard cap (1R × hardCapMultiplier) still applies in the orders route. */}
            <div style={{ marginTop: 16 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 8 }}>
                <div>
                  <div style={{ fontSize: 13, color: 'var(--text-secondary)', fontWeight: 600 }}>
                    Manual lot size
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>
                    Override auto-sizing · 0 = use auto (balance × risk%)
                  </div>
                </div>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
                  <input
                    type="text"
                    inputMode="decimal"
                    // No `max`/`min`/`step` attributes on purpose: browser-level
                    // clamping mid-typing is what made 1 and 1.25 unenterable.
                    // Range is validated on commit against MAX_LOTS.
                    value={lotsText}
                    onChange={e => {
                      // STORE THE RAW TEXT. No parseFloat, no clamp, no `|| 0` —
                      // normalizing here is what reset the field to 0 on every
                      // keystroke and made a partial value like "0." untypable.
                      const next = e.target.value
                      setLotsText(next)
                      // Clear a stale error as soon as the text could be valid.
                      if (lotsError && isPartialLotInput(next)) setLotsError(null)
                    }}
                    onBlur={() => {
                      // The COMMIT BOUNDARY. This is the only place validation
                      // and normalization happen.
                      const res = validateLotSize(lotsText, { max: MAX_LOTS })
                      if (!res.ok) {
                        setLotsError(res.error)
                        return
                      }
                      setLotsError(null)
                      setLotsText(res.empty ? '' : String(res.value))
                      set('manualLots', res.value)
                    }}
                    aria-label="Manual lot size"
                    aria-invalid={lotsError ? true : undefined}
                    className="mono"
                    placeholder="auto"
                    style={{ width: 80, textAlign: 'right', fontSize: 14, padding: '4px 8px' }}
                  />
                  <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>lots</span>
                </div>
              </div>
              {lotsError && (
                <div style={{ fontSize: 11, color: 'var(--danger, #e5484d)', marginTop: 4, textAlign: 'right' }}>
                  {lotsError}
                </div>
              )}


              {/* ── MANUAL RISK % ─────────────────────────────────────────────
                  The manual-mode risk BUDGET. Independent of Manual Lots: the
                  two are separate inputs and editing one never rewrites the
                  other. Same draft/commit architecture as Manual Lots — the
                  draft is a raw string so it can be empty mid-edit, and it is
                  committed on blur. Empty commits to null and never to 0. */}
              <div style={{ marginTop: 14 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 8 }}>
                  <div>
                    <div style={{ fontSize: 13, color: 'var(--text-secondary)', fontWeight: 600 }}>
                      Manual risk %
                    </div>
                    <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>
                      Risk budget used to DERIVE the stop loss in manual mode · 0–50%
                    </div>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
                    <input
                      type="text"
                      inputMode="decimal"
                      // No min/max/step attributes: browser-level clamping mid-typing
                      // is what made values like 1.25 unenterable. Validated on blur.
                      value={riskText}
                      onChange={e => {
                        // Raw text into the DRAFT — no parseFloat, no clamp, no `|| 0`.
                        const next = e.target.value
                        setRiskDraft(next)
                        if (riskError && isPartialRiskInput(next)) setRiskError(null)
                      }}
                      onBlur={() => {
                        const res = validateManualRiskPct(riskText)
                        if (!res.ok) {
                          // Keep the draft so the user can see and correct what they typed.
                          setRiskError(res.error)
                          return
                        }
                        setRiskError(null)
                        // Drop the draft: the field falls back to the committed value,
                        // so an empty commit renders empty — never `0`. The canonical
                        // DEFAULT_STRATEGY value is applied at read time, not persisted.
                        setRiskDraft(null)
                        set('manualRiskPct', res.value)
                      }}
                      aria-label="Manual risk percent"
                      aria-invalid={riskError ? true : undefined}
                      className="mono"
                      placeholder="default"
                      style={{ width: 80, textAlign: 'right', fontSize: 14, padding: '4px 8px' }}
                    />
                    <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>%</span>
                  </div>
                </div>
                {riskError && (
                  <div style={{ fontSize: 11, color: 'var(--danger, #e5484d)', marginTop: 4, textAlign: 'right' }}>
                    {riskError}
                  </div>
                )}
              </div>

              {/* ── POSITION SIZING MODE + PREVIEW ──────────────────────────
                  Every number below comes from the SHARED view model
                  (lib/strategy-sizing-view.mjs → buildManualSizingPreview), the
                  same policy /api/orders executes. No sizing arithmetic happens
                  in this component, so the page cannot advertise something the
                  planner will not do. A `null` row value means "not available"
                  and renders as an explicit awaiting state — never a fake zero. */}
              {sizingView.mode === 'AUTO' && (
                <div style={{
                  marginTop: 14, background: 'rgba(0,128,255,0.06)',
                  border: '1px solid rgba(0,128,255,0.15)', borderRadius: 3, padding: '10px 14px',
                }}>
                  <div style={{ fontSize: 10, color: 'var(--text-muted)', letterSpacing: 1, marginBottom: 4 }}>
                    POSITION SIZING
                  </div>
                  <div style={{ fontSize: 13, color: '#60c0ff', fontWeight: 700, marginBottom: 4 }}>
                    Automatic
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--text-dim)', lineHeight: 1.6 }}>
                    Lots are derived from balance × {local.riskPct}% risk ÷ {local.slPips}p SL.
                    Enter a Manual lot size to take control; clearing it returns you here.
                  </div>
                </div>
              )}


              {sizingView.mode === 'MANUAL' && (
                <div style={{
                  marginTop: 14, background: 'rgba(0,0,0,0.2)', borderRadius: 3,
                  padding: '12px 14px', fontSize: 12,
                }}>
                  <div style={{ fontSize: 10, color: 'var(--text-muted)', letterSpacing: 1, marginBottom: 8 }}>
                    MANUAL POSITION SIZING
                  </div>

                  {sizingView.rows.map(row => (
                    <div key={row.key} style={{
                      display: 'flex', justifyContent: 'space-between', alignItems: 'baseline',
                      padding: '3px 0', borderBottom: '1px solid rgba(255,255,255,0.04)',
                    }}>
                      <span style={{ color: 'var(--text-muted)' }}>{row.label}</span>
                      <span className="mono" style={{
                        color: row.value === null ? 'var(--text-dim)'
                             : row.key === 'status' ? statusColor(sizingView.preview.status)
                             : row.key === 'loss'   ? '#ff3056'
                             : row.key === 'arpct'  ? exposureColor(sizingView.preview.actualRiskPct)
                             : row.key === 'tp'     ? '#00ff87'
                             : 'var(--text-secondary)',
                        fontWeight: row.key === 'status' ? 700 : 500,
                      }}>
                        {row.value === null ? 'Awaiting account data' : row.value}
                      </span>
                    </div>
                  ))}

                  {sizingView.constraint && (
                    <div style={{
                      marginTop: 10, padding: '6px 8px', borderRadius: 3, fontSize: 11, fontWeight: 600,
                      background: sizingView.preview.status === 'CANNOT_EXECUTE' ? 'rgba(255,48,86,0.08)' : 'rgba(255,184,0,0.08)',
                      border: `1px solid ${sizingView.preview.status === 'CANNOT_EXECUTE' ? 'rgba(255,48,86,0.3)' : 'rgba(255,184,0,0.25)'}`,
                      color: sizingView.preview.status === 'CANNOT_EXECUTE' ? '#ff3056' : '#ffb800',
                    }}>
                      {sizingView.preview.status === 'CANNOT_EXECUTE' ? '✗ ' : '⚠ '}{sizingView.constraint}
                    </div>
                  )}

                  {/* The requested lots are AUTHORITATIVE. When the request cannot be
                      satisfied we say so, and never imply the system will quietly
                      resize the position to make it fit. */}
                  {sizingView.preview.requestedLots != null && sizingView.preview.status !== 'EXECUTABLE' && (
                    <div style={{ marginTop: 8, fontSize: 11, color: 'var(--text-dim)', lineHeight: 1.6 }}>
                      Requested lot size stays <b className="mono">{sizingView.preview.requestedLots.toFixed(2)}</b> lots —
                      adjust Manual Risk % or the lot size to satisfy the constraint. The position is not resized automatically.
                    </div>
                  )}

                  {sizingView.notices.map((n, i) => (
                    <div key={i} style={{
                      marginTop: 8, padding: '6px 8px', borderRadius: 3, fontSize: 11, lineHeight: 1.6,
                      background: n.tone === 'warn' ? 'rgba(255,184,0,0.06)' : 'rgba(0,128,255,0.06)',
                      border: `1px solid ${n.tone === 'warn' ? 'rgba(255,184,0,0.25)' : 'rgba(0,128,255,0.18)'}`,
                      color: n.tone === 'warn' ? '#ffb800' : 'var(--text-secondary)',
                    }}>{n.text}</div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </Panel>
      </div>

      {/* Watchlist — grouped */}
      <Panel title="INSTRUMENT WATCHLIST">
        <div style={{ padding: '14px 16px 16px' }}>
          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 16 }}>
            Select instruments to monitor. AI signals are only generated for active instruments.
          </div>

          {(Object.entries(PAIR_GROUPS) as [string, string[]][]).map(([group, groupPairs]) => {
            const watchlist = local.watchlist || []
            const hasVolatile = group === 'Crosses' && groupPairs.some(p => HIGH_VOLATILITY_PAIRS.has(p) && watchlist.includes(p))
            const hasIndex = group === 'Indices' && groupPairs.some(p => watchlist.includes(p))
            return (
              <div key={group} style={{ marginBottom: 20 }}>
                <div style={{ fontSize: 10, color: 'var(--text-dim)', letterSpacing: 2, marginBottom: 10, fontWeight: 600 }}>
                  {group.toUpperCase()}
                  {group === 'Indices' && (
                    <span style={{ marginLeft: 8, fontSize: 9, color: '#60c0ff', fontWeight: 400 }}>
                      session-restricted
                    </span>
                  )}
                </div>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  {groupPairs.map(pair => {
                    const active = watchlist.includes(pair)
                    const volatile = HIGH_VOLATILITY_PAIRS.has(pair)
                    const session = getIndexSession(pair)
                    return (
                      <button
                        key={pair}
                        className={`tab-btn ${active ? 'active' : ''}`}
                        onClick={() => togglePair(pair)}
                        title={
                          volatile ? 'High volatility — experienced traders only'
                          : session ? `Session: ${session.hours}`
                          : undefined
                        }
                        style={{ padding: '8px 16px', fontSize: 13 }}
                      >
                        {active ? '✓ ' : ''}{PAIR_LABELS[pair] ?? pair}
                        {volatile && <span style={{ marginLeft: 4, color: '#ffb800' }}>⚡</span>}
                        {session && <span style={{ marginLeft: 4, color: '#60c0ff', fontSize: 10 }}>🕐</span>}
                      </button>
                    )
                  })}
                </div>

                {hasVolatile && (
                  <div style={{
                    marginTop: 10, fontSize: 11, color: '#ffb800',
                    background: 'rgba(255,184,0,0.06)', border: '1px solid rgba(255,184,0,0.2)',
                    borderRadius: 3, padding: '7px 10px',
                  }}>
                    ⚡ High-volatility pair(s) selected — GBP/JPY, GBP/NZD, GBP/AUD carry wider spreads and fast moves. Recommended for experienced traders only.
                  </div>
                )}
                {hasIndex && (
                  <div style={{
                    marginTop: 10, fontSize: 11, color: '#60c0ff',
                    background: 'rgba(0,128,255,0.06)', border: '1px solid rgba(0,128,255,0.15)',
                    borderRadius: 3, padding: '7px 10px',
                  }}>
                    🕐 Index signals are only generated during their respective market hours (shown on hover).
                  </div>
                )}
              </div>
            )
          })}

          {(local.watchlist || []).length === 0 && (
            <div style={{ fontSize: 12, color: '#ff6060' }}>
              ⚠ At least one instrument must be selected
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
            description="Adds a demo-mode warning to every order. Disable this when trading live."
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
                  { label: 'All Day', start: 0, end: 23 },
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
              {local.sessionStart <= local.sessionEnd ? (
                <div style={{
                  position: 'absolute',
                  left: `${(local.sessionStart / 24) * 100}%`,
                  width: `${((local.sessionEnd - local.sessionStart + 1) / 24) * 100}%`,
                  height: '100%', background: '#0080ff', borderRadius: 4,
                  boxShadow: '0 0 8px rgba(0,128,255,0.5)',
                }} />
              ) : (
                <>
                  <div style={{
                    position: 'absolute', left: `${(local.sessionStart / 24) * 100}%`,
                    width: `${((24 - local.sessionStart) / 24) * 100}%`,
                    height: '100%', background: '#0080ff',
                    boxShadow: '0 0 8px rgba(0,128,255,0.5)',
                  }} />
                  <div style={{
                    position: 'absolute', left: 0,
                    width: `${((local.sessionEnd + 1) / 24) * 100}%`,
                    height: '100%', background: '#0080ff',
                    boxShadow: '0 0 8px rgba(0,128,255,0.5)',
                  }} />
                </>
              )}
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
