'use client'
// components/ui.tsx — shared UI components

import { useEffect, useRef, useState, useCallback } from 'react'

// ─── SIGNAL CONFIG ────────────────────────────────────────────────────────────

export const SIGNAL_CONFIG: Record<string, { color: string; bg: string; border: string }> = {
  'STRONG BUY': { color: '#00ff87', bg: 'rgba(0,255,135,0.1)', border: 'rgba(0,255,135,0.3)' },
  'BUY':        { color: '#4dffb4', bg: 'rgba(77,255,180,0.08)', border: 'rgba(77,255,180,0.25)' },
  'WAIT':       { color: '#ffb800', bg: 'rgba(255,184,0,0.08)', border: 'rgba(255,184,0,0.25)' },
  'SELL':       { color: '#ff6b6b', bg: 'rgba(255,107,107,0.08)', border: 'rgba(255,107,107,0.25)' },
  'STRONG SELL':{ color: '#ff3056', bg: 'rgba(255,48,86,0.1)', border: 'rgba(255,48,86,0.3)' },
}

export const DIR_CONFIG = {
  'BUY':  { color: '#00ff87', bg: 'rgba(0,255,135,0.1)', border: 'rgba(0,255,135,0.25)' },
  'SELL': { color: '#ff3056', bg: 'rgba(255,48,86,0.1)', border: 'rgba(255,48,86,0.25)' },
  'WAIT': { color: '#ffb800', bg: 'rgba(255,184,0,0.08)', border: 'rgba(255,184,0,0.25)' },
}

// ─── SIGNAL BADGE ────────────────────────────────────────────────────────────

export function SignalBadge({ signal }: { signal: string }) {
  const cfg = SIGNAL_CONFIG[signal] || SIGNAL_CONFIG['WAIT']
  return (
    <span className="badge" style={{ color: cfg.color, background: cfg.bg, borderColor: cfg.border }}>
      {signal}
    </span>
  )
}

export function DirectionBadge({ dir }: { dir: string }) {
  const cfg = DIR_CONFIG[dir as keyof typeof DIR_CONFIG] || DIR_CONFIG['WAIT']
  return (
    <span className="badge" style={{ color: cfg.color, background: cfg.bg, borderColor: cfg.border }}>
      {dir}
    </span>
  )
}

// ─── TOAST ───────────────────────────────────────────────────────────────────

interface ToastProps { msg: string; color?: string; onClose: () => void }

export function Toast({ msg, color = '#60c0ff', onClose }: ToastProps) {
  useEffect(() => {
    const t = setTimeout(onClose, 2500)
    return () => clearTimeout(t)
  }, [onClose])

  return (
    <div className="toast" style={{ borderLeft: `3px solid ${color}` }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
        <span style={{ color, fontSize: 10, fontWeight: 700, letterSpacing: 1 }}>● SYSTEM ALERT</span>
        <button onClick={onClose} style={{ background: 'none', border: 'none', color: '#405060', cursor: 'pointer', fontSize: 14, lineHeight: 1 }}>✕</button>
      </div>
      <div style={{ color: '#c0d0e0', fontSize: 13, lineHeight: 1.5 }}>{msg}</div>
    </div>
  )
}

// ─── PANEL ───────────────────────────────────────────────────────────────────

interface PanelProps {
  title?: string
  badge?: React.ReactNode
  children: React.ReactNode
  className?: string
  style?: React.CSSProperties
  bright?: boolean
}

export function Panel({ title, badge, children, className = '', style, bright }: PanelProps) {
  return (
    <div className={`${bright ? 'panel-bright' : 'panel'} ${className}`} style={style}>
      {title && (
        <div style={{
          padding: '11px 16px',
          borderBottom: '1px solid var(--border)',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between'
        }}>
          <span style={{ fontSize: 11, color: 'var(--text-muted)', fontWeight: 700, letterSpacing: 1.5 }}>
            {title}
          </span>
          {badge}
        </div>
      )}
      {children}
    </div>
  )
}

// ─── LIVE DOT ────────────────────────────────────────────────────────────────

export function LiveDot({ color = 'var(--green)' }: { color?: string }) {
  return <div className="pulse-dot" style={{ background: color }} />
}

// ─── STAT CARD ───────────────────────────────────────────────────────────────

export function StatCard({ label, value, color = 'var(--text-primary)' }: { label: string; value: React.ReactNode; color?: string }) {
  return (
    <div className="panel" style={{ padding: '12px 16px' }}>
      <div style={{ fontSize: 10, color: 'var(--text-muted)', letterSpacing: 1.5, marginBottom: 6, fontWeight: 700 }}>{label}</div>
      <div className="mono" style={{ fontSize: 20, color, fontWeight: 700, lineHeight: 1 }}>{value}</div>
    </div>
  )
}

// ─── STRENGTH BAR ────────────────────────────────────────────────────────────

export function StrengthBar({ value, color }: { value: number; color: string }) {
  return (
    <div style={{ height: 3, background: 'var(--border)', borderRadius: 2, marginTop: 6 }}>
      <div style={{
        width: `${Math.min(100, value)}%`, height: '100%',
        background: color, borderRadius: 2,
        transition: 'width 0.5s ease',
        boxShadow: `0 0 6px ${color}80`,
      }} />
    </div>
  )
}

// ─── RSI GAUGE ───────────────────────────────────────────────────────────────

export function RsiGauge({ rsi }: { rsi: number }) {
  const color = rsi > 70 ? '#ff3056' : rsi < 30 ? '#00ff87' : '#0080ff'
  return (
    <div>
      <div style={{ position: 'relative', height: 18, borderRadius: 2, overflow: 'hidden' }}>
        <div style={{ position: 'absolute', inset: 0, background: 'linear-gradient(90deg,#ff305640 0%,#ff305620 20%,#1a2940 30%,#1a2940 70%,#ff305620 80%,#ff305640 100%)' }} />
        <div style={{
          position: 'absolute',
          left: `${rsi}%`, top: 0,
          width: 2, height: '100%',
          background: color,
          transform: 'translateX(-50%)',
          boxShadow: `0 0 8px ${color}`,
          transition: 'left 0.5s ease',
        }} />
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: 'var(--text-muted)', marginTop: 4 }}>
        <span>0 OVERSOLD</span>
        <span className="mono" style={{ color }}>{rsi}</span>
        <span>OVERBOUGHT 100</span>
      </div>
    </div>
  )
}

// ─── LOADING SPINNER ─────────────────────────────────────────────────────────

export function LoadingDots({ color = 'var(--blue)' }: { color?: string }) {
  return (
    <span className="loading-dots mono" style={{ color, fontSize: 18 }}>
      <span>●</span><span>●</span><span>●</span>
    </span>
  )
}

// ─── CHECKLIST ITEM ──────────────────────────────────────────────────────────

export function ChecklistItem({ label, pass }: { label: string; pass: boolean }) {
  return (
    <div className="checklist-row">
      <div style={{
        width: 18, height: 18, flexShrink: 0, borderRadius: 2,
        background: pass ? 'rgba(0,255,135,0.12)' : 'rgba(255,48,86,0.1)',
        border: `1px solid ${pass ? 'rgba(0,255,135,0.3)' : 'rgba(255,48,86,0.25)'}`,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontSize: 10, fontWeight: 900,
        color: pass ? '#00ff87' : '#ff3056',
      }}>
        {pass ? '✓' : '✗'}
      </div>
      <span style={{ fontSize: 12, color: pass ? 'var(--text-secondary)' : 'var(--text-muted)', lineHeight: 1.4 }}>
        {label}
      </span>
    </div>
  )
}

// ─── PRICE DISPLAY ───────────────────────────────────────────────────────────

export function PriceDisplay({ value, prev, decimals = 5, size = 22 }: { value: number; prev?: number; decimals?: number; size?: number }) {
  const isUp = prev !== undefined ? value > prev : undefined
  const color = isUp === true ? 'var(--green)' : isUp === false ? 'var(--red)' : 'var(--text-primary)'
  return (
    <span className="mono" style={{ fontSize: size, fontWeight: 700, color, transition: 'color 0.3s' }}>
      {value.toFixed(decimals)}
    </span>
  )
}

// ─── COPY VALUE ──────────────────────────────────────────────────────────────

export function CopyValue({
  value,
  children,
  style,
}: {
  value: string | number
  children?: React.ReactNode
  style?: React.CSSProperties
}) {
  const [copied, setCopied] = useState(false)

  const handleCopy = useCallback(async (e: React.MouseEvent | React.TouchEvent) => {
    e.stopPropagation()
    const text = String(value)
    try {
      await navigator.clipboard.writeText(text)
    } catch {
      const ta = document.createElement('textarea')
      ta.value = text
      ta.style.cssText = 'position:fixed;opacity:0;top:0;left:0'
      document.body.appendChild(ta)
      ta.focus()
      ta.select()
      document.execCommand('copy')
      document.body.removeChild(ta)
    }
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }, [value])

  return (
    <span
      onClick={handleCopy}
      title="Tap to copy"
      style={{
        cursor: 'pointer',
        position: 'relative',
        display: 'inline-flex',
        alignItems: 'center',
        gap: 3,
        userSelect: 'none',
        WebkitUserSelect: 'none',
        WebkitTapHighlightColor: 'transparent',
        borderBottom: copied ? '1px solid #00c060' : '1px dashed rgba(144,176,208,0.4)',
        paddingBottom: 1,
        borderRadius: 0,
        transition: 'border-color 0.15s',
        ...style,
      }}
    >
      {children ?? String(value)}
      {copied ? (
        <span style={{ fontSize: 9, color: '#00c060', fontWeight: 700, letterSpacing: 0.3, flexShrink: 0 }}>✓</span>
      ) : (
        <svg width="9" height="9" viewBox="0 0 16 16" fill="currentColor"
          style={{ opacity: 0.45, flexShrink: 0, marginTop: 1 }}>
          <path d="M4 1.5H3a2 2 0 0 0-2 2V14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V3.5a2 2 0 0 0-2-2h-1v1h1a1 1 0 0 1 1 1V14a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V3.5a1 1 0 0 1 1-1h1z"/>
          <path d="M9.5 1a.5.5 0 0 1 .5.5v1a.5.5 0 0 1-.5.5h-3a.5.5 0 0 1-.5-.5v-1a.5.5 0 0 1 .5-.5h3zm-3-1A1.5 1.5 0 0 0 5 1.5v1A1.5 1.5 0 0 0 6.5 4h3A1.5 1.5 0 0 0 11 2.5v-1A1.5 1.5 0 0 0 9.5 0h-3z"/>
        </svg>
      )}
      {copied && (
        <span style={{
          position: 'absolute', bottom: 'calc(100% + 6px)', left: '50%',
          transform: 'translateX(-50%)',
          background: '#0d2010', border: '1px solid #00c060',
          color: '#00c060', fontSize: 11, fontWeight: 700,
          padding: '3px 10px', borderRadius: 4,
          whiteSpace: 'nowrap', pointerEvents: 'none', zIndex: 9999,
          letterSpacing: 0.5, boxShadow: '0 2px 8px rgba(0,192,96,0.25)',
        }}>
          Copied!
        </span>
      )}
    </span>
  )
}
