'use client'
// components/OutcomeReconciliation.tsx — Phase 3 Outcome Reconciliation panel.
// Renders the read-only /api/outcome-reconciliation summary for Historical
// Intelligence. Every number comes from the API (pure lib modules), which never
// writes to any source engine.
import { useState, useEffect } from 'react'
import { Panel } from './ui'

const FOUR_COLORS: Record<string, string> = {
  FULL_AGREEMENT: '#00ff87',
  PARTIAL_AGREEMENT: '#ffb800',
  DISAGREEMENT: '#ff3056',
  NOT_COMPARABLE: '#405060',
  PARTIAL_DATA: '#607080',
}

export default function OutcomeReconciliation({ windowDays = 30 }: { windowDays?: number }) {
  const [data, setData] = useState<any>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    fetch(`/api/outcome-reconciliation?windowDays=${windowDays}`, { cache: 'no-store' })
      .then(r => r.json())
      .then(j => { if (alive) setData(j) })
      .catch(e => { if (alive) setError(e?.message || 'fetch failed') })
    return () => { alive = false }
  }, [windowDays])

  const summary = data?.summary
  const four = summary?.fourEngine ?? {}
  const pairwise = summary?.pairwise ?? {}
  const causes = summary?.causes ?? {}

  return (
    <Panel title="OUTCOME AGREEMENT" badge={`Phase 3 · ${windowDays}d · reconciliation (read-only)`}>
      {error && <div style={{ fontSize: 11, color: '#ff6060' }}>{error}</div>}
      {!data && !error && <div style={{ fontSize: 11, color: 'var(--text-dim)' }}>loading…</div>}
      {data && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, fontSize: 11 }}>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', color: 'var(--text-dim)' }}>
            <span>Records linked: <b style={{ color: 'var(--text)' }}>{summary?.records ?? 0}</b></span>
            <span>
              Ambiguous skipped:
              {data.linkage?.ambiguousSkipped
                ? ` recon ${data.linkage.ambiguousSkipped.reconciliation ?? 0} · exec ${data.linkage.ambiguousSkipped.execution ?? 0}`
                : ' —'}
            </span>
          </div>

          {/* Pairwise agreement */}
          {Object.entries(pairwise).map(([label, p]: any) => (
            <div key={label} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ width: 210, color: 'var(--text-muted)' }}>{label}</span>
              <div style={{ width: 150, height: 6, borderRadius: 3, background: 'rgba(255,255,255,0.06)', overflow: 'hidden' }}>
                <div style={{
                  width: p.agreementPct === null ? 0 : `${p.agreementPct}%`,
                  height: '100%',
                  background: p.agreementPct === null ? '#405060' : (p.agreementPct >= 60 ? '#00ff87' : p.agreementPct >= 40 ? '#ffb800' : '#ff3056'),
                }} />
              </div>
              <span style={{ fontFamily: 'JetBrains Mono', fontWeight: 700, width: 46 }}>
                {p.agreementPct === null ? '—' : `${p.agreementPct}%`}
              </span>
              <span style={{ color: 'var(--text-dim)', fontSize: 10 }}>
                {p.n} linked · {p.agree}A/{p.disagree}D/{p.notComparable}NC
              </span>
            </div>
          ))}

          {/* Four-engine classes */}
          <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', marginTop: 2 }}>
            {Object.entries(FOUR_COLORS).map(([k, color]) => (
              <span key={k} style={{ color: 'var(--text-muted)' }}>
                <span style={{ color, fontWeight: 700 }}>{four[k] ?? 0}</span> {k.replace(/_/g, ' ')}
              </span>
            ))}
          </div>

          {/* Top disagreement causes */}
          <div style={{ color: 'var(--text-muted)' }}>
            Top disagreement causes:{' '}
            {Object.entries(causes)
              .sort((a: any, b: any) => b[1] - a[1])
              .slice(0, 6)
              .map(([reason, n]: any) => `${reason.replace(/_/g, ' ').toLowerCase()} ${n}`)
              .join(' · ') || 'none yet'}
          </div>

          <div style={{ fontSize: 10, color: 'var(--text-dim)', fontStyle: 'italic' }}>
            Not every difference is a bug — each engine answers a different question
            (prediction quality · direction @5m · 30-min label · real money).
          </div>
        </div>
      )}
    </Panel>
  )
}
