'use client'
// components/RecentTradesTable.tsx
//
// RECENT TRADES — the row presenter (Phase 4.2.1).
//
// Each row arrives already described by `describeTradeRow()` in
// lib/analytics-scope.mjs, which is the SAME classifier that decides the
// dashboard's headline statistics. This component performs NO accounting: it
// formats, and it refuses to invent a number.
//
// Display rules that are deliberate, not cosmetic:
//   • NET is rendered only when the row is net-complete; otherwise an em dash.
//   • GROSS is always shown (it is the broker's realised figure).
//   • commission / swap / fees render an em dash when the broker did not report
//     them — never 0.00.
//   • a gross-only row shows RESULT PENDING plus a "gross only" qualifier.
//   • the ticket column carries the genuine broker reference or an em dash.
//   • rows are ordered by BROKER close timestamp, newest first.

import { currencySigned } from '@/lib/currency'

const DIR_COLOR: Record<string, string> = { BUY: '#00ff87', SELL: '#ff3056' }

function formatPrice(pair: string | null, price: number): string {
  if (!Number.isFinite(price)) return '—'
  if (pair?.includes('JPY')) return price.toFixed(3)
  if (pair === 'XAU/USD') return price.toFixed(2)
  if (pair === 'XAG/USD') return price.toFixed(3)
  return price.toFixed(5)
}

function formatTs(iso: string | null): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (!Number.isFinite(d.getTime())) return '—'
  // Always UTC: the broker records UTC and the platform evaluates UTC.
  return d.toLocaleString('en-GB', {
    day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'UTC',
  })
}

const money = (v: number | null, currency?: string) =>
  v === null || v === undefined ? '—' : currencySigned(v, currency)

const tone = (v: number | null) =>
  v === null || v === undefined ? '#607080' : v > 0 ? '#00ff87' : v < 0 ? '#ff6060' : '#90b0d0'

export default function RecentTradesTable({
  rows, page, onPage, pageSize, currency, simulated, pendingToday,
}: {
  rows: any[]
  page: number
  onPage: (p: number) => void
  pageSize: number
  currency?: string
  simulated: number
  pendingToday: number
}) {
  const pages = Math.max(1, Math.ceil(rows.length / pageSize))
  const safePage = Math.min(page, pages - 1)
  const visible = rows.slice(safePage * pageSize, (safePage + 1) * pageSize)

  return (
    <>
      <div style={{ overflowX: 'auto' }}>
        <table>
          <thead>
            <tr>
              <th>PAIR</th><th>DIR</th><th>VOL</th>
              <th>ENTRY</th><th>EXIT</th>
              <th>OPENED (UTC)</th><th>CLOSED (UTC)</th>
              <th>GROSS</th><th>COMM</th><th>SWAP</th><th>FEES</th><th>NET</th>
              <th>RESULT</th><th>ACCOUNTING</th><th>TICKET</th><th>SOURCE</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((r: any) => (
              <tr key={r.id ?? `${r.pair}-${r.closedAt ?? r.openedAt}`}>
                <td className="mono" style={{ color: '#90b0d0' }}>{r.pair ?? '—'}</td>
                <td>
                  <span style={{ color: DIR_COLOR[r.direction] || '#ffb800', fontWeight: 700, fontSize: 12 }}>
                    {r.direction ?? '—'}
                  </span>
                </td>
                <td className="mono" style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                  {typeof r.lots === 'number' ? r.lots.toFixed(2) : '—'}
                </td>
                <td className="mono" style={{ fontSize: 12 }}>
                  {r.entryPrice === null ? '—' : formatPrice(r.pair, r.entryPrice)}
                </td>
                <td className="mono" style={{ fontSize: 12 }}>
                  {r.exitPrice === null ? '—' : formatPrice(r.pair, r.exitPrice)}
                </td>
                <td style={{ fontSize: 10, color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>{formatTs(r.openedAt)}</td>
                <td style={{ fontSize: 10, color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>{formatTs(r.closedAt)}</td>
                <td className="mono" style={{ fontSize: 12, color: tone(r.grossPnl) }}>{money(r.grossPnl, currency)}</td>
                <td className="mono" style={{ fontSize: 12, color: tone(r.commission) }}>{money(r.commission, currency)}</td>
                <td className="mono" style={{ fontSize: 12, color: tone(r.swap) }}>{money(r.swap, currency)}</td>
                <td className="mono" style={{ fontSize: 12, color: tone(r.otherFees) }}>{money(r.otherFees, currency)}</td>
                <td
                  className="mono"
                  style={{ fontSize: 12, fontWeight: 700, color: tone(r.netPnl) }}
                  title={r.netPnl !== null
                    ? 'Net realised P&L = gross + commission + swap + fees, as reported by the broker'
                    : 'Net is not shown: commission/swap are unconfirmed for this row'}
                >
                  {money(r.netPnl, currency)}
                </td>
                <td>
                  <span style={{
                    fontSize: 11, fontWeight: 700, whiteSpace: 'nowrap',
                    color: r.result === 'WIN' ? '#00ff87'
                      : r.result === 'LOSS' ? '#ff3056'
                      : r.result === 'OPEN' ? '#60c0ff'
                      : '#ffb800',
                  }}>
                    {r.result}
                  </span>
                  {r.provisional && (
                    <span
                      style={{ fontSize: 9, color: '#ffb800', display: 'block' }}
                      title="Direction taken from gross P&L. Costs are unconfirmed, so this is not a settled result."
                    >
                      gross only
                    </span>
                  )}
                </td>
                <td style={{ fontSize: 10, whiteSpace: 'nowrap' }}>
                  <span style={{
                    color: r.accountingComplete ? '#00ff87'
                      : r.population === 'ACCOUNTING_ERROR' ? '#ff3056' : '#ffb800',
                  }}>
                    {r.accountingStatus}
                  </span>
                  {r.missingCosts?.length > 0 && (
                    <span style={{ color: 'var(--text-dim)', display: 'block' }}>
                      missing: {r.missingCosts.join(', ')}
                    </span>
                  )}
                </td>
                <td className="mono" style={{ fontSize: 11, color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>
                  {r.ticket ?? '—'}
                </td>
                <td style={{ fontSize: 10, color: 'var(--text-muted)' }}>{r.source ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div style={{ padding: '8px 12px 0', fontSize: 10, color: 'var(--text-dim)' }}>
        Sorted by broker close timestamp, newest first. NET is shown only when
        accounting is complete for that row; GROSS ONLY rows carry a provisional
        result. An em dash means the broker has not reported that value — it is never
        treated as zero.
        {simulated > 0 && (
          <> {simulated} ticket-less simulation row(s) are excluded from this table and
          from every figure above.</>
        )}
        {pendingToday > 0 && (
          <> {pendingToday} close(s) today await broker accounting.</>
        )}
      </div>

      {rows.length > pageSize && (
        <div style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: 8, padding: '8px 12px' }}>
          <button onClick={() => onPage(safePage - 1)} disabled={safePage === 0} className="btn btn-ghost" style={{ fontSize: 11, padding: '4px 12px' }}>← Prev</button>
          <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{safePage + 1} / {pages}</span>
          <button onClick={() => onPage(safePage + 1)} disabled={safePage >= pages - 1} className="btn btn-ghost" style={{ fontSize: 11, padding: '4px 12px' }}>Next →</button>
        </div>
      )}
    </>
  )
}
