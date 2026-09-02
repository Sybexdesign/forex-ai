// components/SetupBadges.tsx
// Compact Expectancy / Safety / Authority chips for signal cards. Renders the
// shadow-mode intelligence that /api/scalper/signal attaches to every tradable
// Scalp response (migration 20260902). Pure presentational component.

import type { ReactNode } from 'react'

export interface IntelExpectancyView {
  metrics?: {
    expectancyR?: number | null
    status?: string | null
    n?: number | null
    winRate?: number | null
    sampleConfidence?: string | null
  } | null
  segment?: Record<string, unknown> | null
}

export interface IntelSafetyView {
  total?: number | null
  grade?: string | null
}

export interface IntelAuthorityView {
  status?: string | null
  reasons?: { reason?: string; severity?: string }[] | null
}

export interface SetupBadgesProps {
  expectancy?: IntelExpectancyView | null
  safety?: IntelSafetyView | null
  authority?: IntelAuthorityView | null
}

const STATUS_FG: Record<string, string> = {
  VERY_STRONG: '#22c55e',
  STRONG: '#4ade80',
  POSITIVE: '#a3e635',
  NEUTRAL: '#ffb800',
  NEGATIVE: 'var(--color-sell)',
  INSUFFICIENT_DATA: '#64748b',
}
const STATUS_BG: Record<string, string> = {
  VERY_STRONG: 'rgba(34,197,94,0.16)',
  STRONG: 'rgba(74,222,128,0.16)',
  POSITIVE: 'rgba(163,230,53,0.16)',
  NEUTRAL: 'rgba(255,184,0,0.14)',
  NEGATIVE: 'rgba(255,48,86,0.15)',
  INSUFFICIENT_DATA: 'rgba(100,116,139,0.15)',
}

function chipStyle(fg: string, bg: string) {
  return {
    fontSize: 9, fontWeight: 700, letterSpacing: 1,
    padding: '2px 6px', borderRadius: 2, whiteSpace: 'nowrap' as const,
    color: fg, background: bg,
    border: `1px solid ${fg}55`,
  }
}

function safetyColor(total: number | null | undefined): { fg: string; bg: string } {
  if (total === null || total === undefined) return { fg: '#64748b', bg: 'rgba(100,116,139,0.15)' }
  if (total >= 85) return { fg: '#22c55e', bg: 'rgba(34,197,94,0.16)' }
  if (total >= 70) return { fg: '#a3e635', bg: 'rgba(163,230,53,0.14)' }
  if (total >= 55) return { fg: '#ffb800', bg: 'rgba(255,184,0,0.14)' }
  if (total >= 40) return { fg: '#fb923c', bg: 'rgba(251,146,60,0.15)' }
  return { fg: 'var(--color-sell)', bg: 'rgba(255,48,86,0.15)' }
}

function authorityColor(status: string | null | undefined): { fg: string; bg: string } {
  if (status === 'APPROVED') return { fg: '#22c55e', bg: 'rgba(34,197,94,0.16)' }
  if (status === 'DENIED') return { fg: 'var(--color-sell)', bg: 'rgba(255,48,86,0.16)' }
  if (status === 'REVIEW') return { fg: '#ffb800', bg: 'rgba(255,184,0,0.15)' }
  return { fg: '#64748b', bg: 'rgba(100,116,139,0.14)' }
}

export default function SetupBadges({ expectancy, safety, authority }: SetupBadgesProps) {
  const hasIntel = !!expectancy?.metrics || !!safety || !!authority
  if (!hasIntel) return null

  const m = expectancy?.metrics
  const expStatus = m?.status
  const expR = m?.expectancyR
  const chips: { key: string; node: ReactNode }[] = []

  // ── Expectancy ─────────────────────────────────────────────────────────────
  if (expStatus && expR !== null && expR !== undefined) {
    const fg = STATUS_FG[expStatus] ?? '#64748b'
    const bg = STATUS_BG[expStatus] ?? 'rgba(100,116,139,0.15)'
    const label = `${expR >= 0 ? '+' : ''}${expR.toFixed(2)}R`
    chips.push({
      key: 'exp',
      node: (
        <span
          title={`Historical segment expectancy ${label} · ${String(expStatus).replace('_', ' ').toLowerCase()} · n=${m?.n ?? '?'} · win ${((m?.winRate ?? 0) * 100).toFixed(0)}% · ${m?.sampleConfidence ?? ''}`}
          style={chipStyle(fg, bg)}
        >
          EXP {label}
        </span>
      ),
    })
  } else {
    chips.push({
      key: 'exp',
      node: (
        <span title="No historical segment evidence yet for this setup" style={chipStyle('#64748b', 'rgba(100,116,139,0.15)')}>
          EXP —
        </span>
      ),
    })
  }

  // ── Safety ─────────────────────────────────────────────────────────────────
  const total = safety?.total ?? null
  const grade = safety?.grade ?? null
  const sc = safetyColor(total)
  chips.push({
    key: 'safety',
    node: (
      <span
        title={`Safety score ${total ?? '—'}/100${grade ? ` (grade ${grade})` : ''} — independent of signal strength`}
        style={chipStyle(sc.fg, sc.bg)}
      >
        SAFE {total ?? '—'}
      </span>
    ),
  })

  // ── Authority ──────────────────────────────────────────────────────────────
  const st = authority?.status
  const ac = authorityColor(st)
  const why = (authority?.reasons ?? [])
    .filter(r => r.severity === 'block' || r.severity === 'warn')
    .slice(0, 3).map(r => r.reason).join(' · ')
  chips.push({
    key: 'auth',
    node: (
      <span
        title={why ? `Authority ${st ?? ''} — ${why}` : 'Trade Authority (shadow — advisory, not execution)'}
        style={chipStyle(ac.fg, ac.bg)}
      >
        AUTH {st ?? '—'}
      </span>
    ),
  })

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', opacity: 0.95 }}>
      {chips.map(c => <div key={c.key}>{c.node}</div>)}
    </div>
  )
}
