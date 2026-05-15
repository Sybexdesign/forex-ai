'use client'
// components/pages/AdminPage.tsx — Admin CRUD for users and stats

import { useState, useEffect, useCallback } from 'react'
import { Panel, LoadingDots } from '../ui'
import { authFetch } from '@/lib/api'

interface UserRow {
  id: string
  email: string
  fullName: string
  createdAt: string
  lastSignIn: string
  confirmed: boolean
  trades: number
  wins: number
  totalPL: number
  winRate: number
}

interface AdminPageProps {
  onToast: (msg: string, color?: string) => void
}

export default function AdminPage({ onToast }: AdminPageProps) {
  const [users, setUsers] = useState<UserRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [deleting, setDeleting] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)
  const [search, setSearch] = useState('')

  const loadUsers = useCallback(() => {
    setLoading(true)
    authFetch('/api/admin/users')
      .then(r => r.json())
      .then(d => {
        if (d.error) { setError(d.error); return }
        setUsers(d.users || [])
      })
      .catch(e => setError(e.message))
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => { loadUsers() }, [loadUsers])

  async function handleDelete(userId: string, email: string) {
    if (confirmDelete !== userId) { setConfirmDelete(userId); return }
    setDeleting(userId)
    try {
      const res = await authFetch('/api/admin/users', { method: 'DELETE', body: JSON.stringify({ userId }) })
      const d = await res.json()
      if (d.error) { onToast('Delete failed: ' + d.error, '#ff3056'); return }
      onToast(`Deleted ${email}`, '#ffb800')
      setUsers(u => u.filter(x => x.id !== userId))
    } catch (e: any) {
      onToast('Error: ' + e.message, '#ff3056')
    } finally {
      setDeleting(null)
      setConfirmDelete(null)
    }
  }

  const filtered = users.filter(u =>
    u.email?.toLowerCase().includes(search.toLowerCase()) ||
    u.fullName?.toLowerCase().includes(search.toLowerCase())
  )

  const totalTrades = users.reduce((s, u) => s + u.trades, 0)
  const totalPL = users.reduce((s, u) => s + u.totalPL, 0)
  const activeUsers = users.filter(u => u.trades > 0).length

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>

      {/* Stats row */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12 }}>
        {[
          { label: 'TOTAL USERS', value: users.length, color: '#60c0ff' },
          { label: 'ACTIVE TRADERS', value: activeUsers, color: '#00ff87' },
          { label: 'TOTAL TRADES', value: totalTrades, color: '#ffb800' },
          { label: 'TOTAL P/L', value: `${totalPL >= 0 ? '+' : ''}$${totalPL.toFixed(2)}`, color: totalPL >= 0 ? '#00ff87' : '#ff3056' },
        ].map(s => (
          <div key={s.label} style={{ background: 'rgba(0,0,0,0.3)', border: '1px solid var(--border)', borderRadius: 4, padding: '14px 16px' }}>
            <div style={{ fontSize: 9, color: 'var(--text-muted)', letterSpacing: 2, marginBottom: 8 }}>{s.label}</div>
            <div style={{ fontSize: 22, fontWeight: 700, color: s.color, fontFamily: 'Rajdhani' }}>{s.value}</div>
          </div>
        ))}
      </div>

      {/* User table */}
      <Panel title="USER MANAGEMENT" bright>
        <div style={{ padding: '14px 16px' }}>
          <div style={{ display: 'flex', gap: 10, marginBottom: 16, alignItems: 'center' }}>
            <input
              placeholder="Search by email or name…"
              value={search}
              onChange={e => setSearch(e.target.value)}
              style={{
                flex: 1, padding: '8px 12px', borderRadius: 3,
                background: 'rgba(0,0,0,0.3)', border: '1px solid var(--border)',
                color: 'var(--text-primary)', fontSize: 12, fontFamily: 'JetBrains Mono',
              }}
            />
            <button className="btn btn-ghost" onClick={loadUsers} style={{ padding: '8px 16px', fontSize: 12 }}>
              ⟳ Refresh
            </button>
          </div>

          {loading && <div style={{ textAlign: 'center', padding: 30 }}><LoadingDots /></div>}
          {error && <div style={{ color: '#ff6060', fontSize: 12, padding: 10 }}>⚠ {error}</div>}

          {!loading && !error && (
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                <thead>
                  <tr style={{ borderBottom: '1px solid var(--border)' }}>
                    {['Email', 'Name', 'Joined', 'Last Active', 'Trades', 'Win Rate', 'P/L', 'Status', ''].map(h => (
                      <th key={h} style={{ padding: '8px 12px', textAlign: 'left', color: 'var(--text-muted)', fontWeight: 600, fontSize: 10, letterSpacing: 1, whiteSpace: 'nowrap' }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {filtered.length === 0 && (
                    <tr><td colSpan={9} style={{ textAlign: 'center', padding: 30, color: 'var(--text-muted)' }}>No users found</td></tr>
                  )}
                  {filtered.map(u => (
                    <tr key={u.id} style={{ borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
                      <td style={{ padding: '10px 12px', color: '#60c0ff', fontFamily: 'JetBrains Mono' }}>{u.email}</td>
                      <td style={{ padding: '10px 12px', color: 'var(--text-secondary)' }}>{u.fullName || '—'}</td>
                      <td style={{ padding: '10px 12px', color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>
                        {u.createdAt ? new Date(u.createdAt).toLocaleDateString('en') : '—'}
                      </td>
                      <td style={{ padding: '10px 12px', color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>
                        {u.lastSignIn ? new Date(u.lastSignIn).toLocaleDateString('en') : '—'}
                      </td>
                      <td style={{ padding: '10px 12px', color: 'var(--text-secondary)', textAlign: 'center' }}>{u.trades}</td>
                      <td style={{ padding: '10px 12px', textAlign: 'center' }}>
                        <span style={{ color: u.winRate >= 50 ? '#00ff87' : '#ff6060' }}>{u.winRate}%</span>
                      </td>
                      <td style={{ padding: '10px 12px', fontFamily: 'JetBrains Mono', textAlign: 'right' }}>
                        <span style={{ color: u.totalPL >= 0 ? '#00ff87' : '#ff3056' }}>
                          {u.totalPL >= 0 ? '+' : ''}${u.totalPL.toFixed(2)}
                        </span>
                      </td>
                      <td style={{ padding: '10px 12px' }}>
                        <span style={{
                          fontSize: 9, fontWeight: 700, letterSpacing: 1, padding: '2px 6px', borderRadius: 2,
                          background: u.confirmed ? 'rgba(0,255,135,0.08)' : 'rgba(255,184,0,0.08)',
                          border: `1px solid ${u.confirmed ? 'rgba(0,255,135,0.2)' : 'rgba(255,184,0,0.2)'}`,
                          color: u.confirmed ? '#00ff87' : '#ffb800',
                        }}>
                          {u.confirmed ? 'CONFIRMED' : 'PENDING'}
                        </span>
                      </td>
                      <td style={{ padding: '10px 12px' }}>
                        {u.email !== 'sybexdesigns@gmail.com' && (
                          <button
                            onClick={() => handleDelete(u.id, u.email)}
                            disabled={deleting === u.id}
                            style={{
                              padding: '4px 10px', borderRadius: 3, cursor: 'pointer', fontSize: 11,
                              background: confirmDelete === u.id ? 'rgba(255,48,86,0.15)' : 'rgba(255,255,255,0.04)',
                              border: `1px solid ${confirmDelete === u.id ? 'rgba(255,48,86,0.4)' : 'var(--border)'}`,
                              color: confirmDelete === u.id ? '#ff3056' : 'var(--text-muted)',
                            }}
                          >
                            {deleting === u.id ? '…' : confirmDelete === u.id ? 'Confirm?' : 'Delete'}
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </Panel>
    </div>
  )
}
