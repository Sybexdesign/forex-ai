'use client'
// components/ui.tsx — shared UI components

import { useEffect, useRef } from 'react'

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
    const t = setTimeout(onClose, 5000)
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
