'use client'
// components/pages/AdminPage.tsx — Admin CRUD for users and stats

import { useState, useEffect, useCallback } from 'react'
import { Panel, LoadingDots } from '../ui'
import { authFetch } from '@/lib/api'
import { currencySymbol } from '@/lib/currency'


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
  account?: any
}

export default function AdminPage({ onToast, account }: AdminPageProps) {

  const [users, setUsers] = useState<UserRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [deleting, setDeleting] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [cacheClearing, setCacheClearing] = useState(false)
  const [cacheResult, setCacheResult] = useState<{ cleared: string[]; errors: string[] } | null>(null)
  const [cacheLayers, setCacheLayers] = useState<any[]>([])
  const [loadingLayers, setLoadingLayers] = useState(false)
  const [clientCacheCleared, setClientCacheCleared] = useState(false)
  const [confirmClear, setConfirmClear] = useState(false)
  const [confirmClientClear, setConfirmClientClear] = useState(false)
  const [confirmWorkerClear, setConfirmWorkerClear] = useState(false)
  const [workerClearing, setWorkerClearing] = useState(false)
  const [workerResult, setWorkerResult] = useState<string | null>(null)


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

  // ── Cache management ──────────────────────────────────────────────────────
  const loadCacheLayers = useCallback(() => {
    setLoadingLayers(true)
    authFetch('/api/admin/cache')
      .then(r => r.json())
      .then(d => {
        if (d.error) { onToast('Cache status failed: ' + d.error, '#ff3056'); return }
        setCacheLayers(d.layers || [])
      })
      .catch(e => onToast('Cache status error: ' + e.message, '#ff3056'))
      .finally(() => setLoadingLayers(false))
  }, [onToast])

  useEffect(() => { loadCacheLayers() }, [loadCacheLayers])

  async function handleClearServerCaches() {
    if (!confirmClear) { setConfirmClear(true); return }
    setCacheClearing(true)
    setCacheResult(null)
    try {
      const res = await authFetch('/api/admin/cache', { method: 'POST' })
      const d = await res.json()
      if (d.error) { onToast('Cache clear failed: ' + d.error, '#ff3056'); return }
      setCacheResult({ cleared: d.cleared || [], errors: d.errors || [] })
      onToast(`Cleared ${(d.cleared || []).length} cache layer(s)`, '#00ff87')
    } catch (e: any) {
      onToast('Cache clear error: ' + e.message, '#ff3056')
    } finally {
      setCacheClearing(false)
      setConfirmClear(false)
    }
  }

  async function handleClearClientCaches() {
    if (!confirmClientClear) { setConfirmClientClear(true); return }
    try {
      const keys = ['forexai_strategy_v2', 'forexai_account_size', 'forexai_theme']
      const cleared: string[] = []
      for (const key of keys) {
        try { localStorage.removeItem(key); cleared.push(key) } catch { /* ignore */ }
      }
      setClientCacheCleared(true)
      onToast(`Cleared ${cleared.length} client cache key(s)`, '#00ff87')
    } finally {
      setConfirmClientClear(false)
    }
  }

  async function handleClearWorkerCaches() {
    if (!confirmWorkerClear) { setConfirmWorkerClear(true); return }
    setWorkerClearing(true)
    setWorkerResult(null)
    try {
      const res = await authFetch('/api/worker/cache-reset', { method: 'POST' })
      const d = await res.json()
      if (d.error) { onToast('Worker cache reset failed: ' + d.error, '#ff3056'); return }
      setWorkerResult('Worker cache reset requested — will apply on next sweep (~30s)')
      onToast('Worker cache reset requested', '#00ff87')
    } catch (e: any) {
      onToast('Worker cache reset error: ' + e.message, '#ff3056')
    } finally {
      setWorkerClearing(false)
      setConfirmWorkerClear(false)
    }
  }

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
          { label: 'TOTAL P/L', value: `${totalPL >= 0 ? '+' : ''}${currencySymbol(account?.currency)}${totalPL.toFixed(2)}`, color: totalPL >= 0 ? '#00ff87' : '#ff3056' },

        ].map(s => (
          <div key={s.label} style={{ background: 'rgba(0,0,0,0.3)', border: '1px solid var(--border)', borderRadius: 4, padding: '14px 16px' }}>
            <div style={{ fontSize: 9, color: 'var(--text-muted)', letterSpacing: 2, marginBottom: 8 }}>{s.label}</div>
            <div style={{ fontSize: 22, fontWeight: 700, color: s.color, fontFamily: 'Rajdhani' }}>{s.value}</div>
          </div>
        ))}
      </div>

      {/* Cache Management */}
      <Panel title="CACHE MANAGEMENT" bright>
        <div style={{ padding: '14px 16px' }}>
          <div style={{ display: 'flex', gap: 10, marginBottom: 16, alignItems: 'center', flexWrap: 'wrap' }}>
            <button
              className="btn"
              onClick={handleClearServerCaches}
              disabled={cacheClearing}
              style={{
                padding: '8px 16px', fontSize: 12, cursor: 'pointer',
                background: confirmClear ? 'rgba(255,48,86,0.15)' : 'rgba(255,184,0,0.1)',
                border: `1px solid ${confirmClear ? 'rgba(255,48,86,0.4)' : 'rgba(255,184,0,0.3)'}`,
                color: confirmClear ? '#ff3056' : '#ffb800',
                borderRadius: 3,
              }}
            >
              {cacheClearing ? 'Clearing…' : confirmClear ? '⚠ Confirm Clear All?' : '🧹 Clear Server Caches'}
            </button>
            <button
              className="btn btn-ghost"
              onClick={handleClearClientCaches}
              style={{ padding: '8px 16px', fontSize: 12, cursor: 'pointer' }}
            >
              {confirmClientClear ? '⚠ Confirm?' : '🗑 Clear Client Cache'}
            </button>
            <button
              className="btn btn-ghost"
              onClick={handleClearWorkerCaches}
              disabled={workerClearing}
              style={{ padding: '8px 16px', fontSize: 12, cursor: 'pointer' }}
            >
              {workerClearing ? 'Requesting…' : confirmWorkerClear ? '⚠ Confirm?' : '⚙ Reset Worker Cache'}
            </button>
            <button className="btn btn-ghost" onClick={loadCacheLayers} style={{ padding: '8px 16px', fontSize: 12 }}>
              ⟳ Refresh
            </button>
          </div>

          {cacheResult && (
            <div style={{
              padding: '10px 14px', borderRadius: 3, marginBottom: 12, fontSize: 12,
              background: cacheResult.errors.length ? 'rgba(255,48,86,0.08)' : 'rgba(0,255,135,0.08)',
              border: `1px solid ${cacheResult.errors.length ? 'rgba(255,48,86,0.3)' : 'rgba(0,255,135,0.3)'}`,
              color: cacheResult.errors.length ? '#ff6060' : '#00ff87',
              fontFamily: 'JetBrains Mono',
            }}>
              <div style={{ fontWeight: 700, marginBottom: 4 }}>
                {cacheResult.errors.length ? '⚠ Partial clear' : '✅ All caches cleared'}
              </div>
              {cacheResult.cleared.length > 0 && (
                <div style={{ color: 'var(--text-secondary)' }}>
                  Cleared: {cacheResult.cleared.join(', ')}
                </div>
              )}
              {cacheResult.errors.length > 0 && (
                <div style={{ color: '#ff6060', marginTop: 4 }}>
                  Errors: {cacheResult.errors.join('; ')}
                </div>
              )}
            </div>
          )}

          {workerResult && (
            <div style={{
              padding: '10px 14px', borderRadius: 3, marginBottom: 12, fontSize: 12,
              background: 'rgba(0,255,135,0.08)',
              border: '1px solid rgba(0,255,135,0.3)',
              color: '#00ff87',
              fontFamily: 'JetBrains Mono',
            }}>
              {workerResult}
            </div>
          )}

          {clientCacheCleared && (
            <div style={{
              padding: '10px 14px', borderRadius: 3, marginBottom: 12, fontSize: 12,
              background: 'rgba(0,255,135,0.08)',
              border: '1px solid rgba(0,255,135,0.3)',
              color: '#00ff87',
              fontFamily: 'JetBrains Mono',
            }}>
              ✅ Client localStorage cleared — strategy and account size will reload from server
            </div>
          )}

          {loadingLayers ? (
            <div style={{ textAlign: 'center', padding: 20 }}><LoadingDots /></div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {cacheLayers.map(layer => (
                <div key={layer.id} style={{
                  display: 'flex', alignItems: 'center', gap: 12,
                  padding: '10px 14px', borderRadius: 3,
                  background: 'rgba(0,0,0,0.2)', border: '1px solid var(--border)',
                }}>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-primary)' }}>{layer.name}</div>
                    <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 2 }}>{layer.description}</div>
                  </div>
                  <span style={{
                    fontSize: 9, fontWeight: 700, letterSpacing: 1, padding: '2px 6px', borderRadius: 2,
                    background: 'rgba(255,184,0,0.08)', border: '1px solid rgba(255,184,0,0.2)',
                    color: '#ffb800', whiteSpace: 'nowrap',
                  }}>
                    {layer.id}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </Panel>

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
                          {u.totalPL >= 0 ? '+' : ''}{currencySymbol(account?.currency)}{u.totalPL.toFixed(2)}
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
