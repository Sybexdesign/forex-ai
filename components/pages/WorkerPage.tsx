'use client'
// components/pages/WorkerPage.tsx — Live 24/7 background worker monitor

import { useState, useEffect, useRef, useCallback } from 'react'

interface WorkerLog {
  id: string
  created_at: string
  level: string
  pair: string | null
  session: string | null
  message: string
  metadata: Record<string, any> | null
}

const LEVEL_COLOR: Record<string, string> = {
  signal:    '#00e5b4',
  alert:     '#f59e0b',
  order:     '#38bdf8',
  error:     '#f87171',
  heartbeat: '#818cf8',
  info:      '#6b7280',
}

const LEVEL_ICON: Record<string, string> = {
  signal:    '⚡',
  alert:     '🔔',
  order:     '💸',
  error:     '⚠',
  heartbeat: '💓',
  info:      '·',
}

const LEVELS = ['all', 'signal', 'alert', 'order', 'heartbeat', 'error']

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime()
  if (diff < 60_000)  return `${Math.floor(diff / 1000)}s ago`
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)}m ago`
  return `${Math.floor(diff / 3600_000)}h ago`
}

function formatTime(iso: string): string {
  return new Date(iso).toUTCString().slice(17, 25) + ' UTC'
}

export default function WorkerPage() {
  const [logs, setLogs]         = useState<WorkerLog[]>([])
  const [filter, setFilter]     = useState('all')
  const [loading, setLoading]   = useState(true)
  const [error, setError]       = useState('')
  const [autoScroll, setAutoScroll] = useState(true)
  const bottomRef  = useRef<HTMLDivElement>(null)
  const listRef    = useRef<HTMLDivElement>(null)
  const timerRef   = useRef<ReturnType<typeof setInterval> | null>(null)

  const fetchLogs = useCallback(async () => {
    try {
      const url = `/api/worker/logs?limit=200${filter !== 'all' ? `&level=${filter}` : ''}`
      const res = await fetch(url)
      const { logs: data, error: err } = await res.json()
      if (err) throw new Error(err)
      setLogs(data || [])
      setError('')
    } catch (e: any) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }, [filter])

  useEffect(() => {
    setLoading(true)
    fetchLogs()
    timerRef.current = setInterval(fetchLogs, 5_000)
    return () => { if (timerRef.current) clearInterval(timerRef.current) }
  }, [fetchLogs])

  useEffect(() => {
    if (autoScroll && bottomRef.current)
      bottomRef.current.scrollIntoView({ behavior: 'smooth' })
  }, [logs, autoScroll])

  const handleScroll = () => {
    const el = listRef.current
    if (!el) return
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40
    setAutoScroll(atBottom)
  }

  // Derive status from most recent log
  const lastLog    = logs[0]
  const lastSeenMs = lastLog ? Date.now() - new Date(lastLog.created_at).getTime() : null
  const isOnline   = lastSeenMs !== null && lastSeenMs < 90_000  // no log in 90s = offline

  // Latest heartbeat for stats
  const heartbeat  = logs.find(l => l.level === 'heartbeat')
  const hbMeta     = heartbeat?.metadata as any

  const C = {
    bg:      '#0a0d12',
    panel:   '#111620',
    border:  '#1e2535',
    text:    '#c9d1d9',
    muted:   '#6b7280',
    green:   '#00e5b4',
    amber:   '#f59e0b',
    red:     '#f87171',
    blue:    '#38bdf8',
  }

  const pill = (text: string, color: string, bg?: string) => (
    <span style={{
      background: bg || `${color}22`,
      color,
      border:     `1px solid ${color}44`,
      borderRadius: 4,
      padding:    '1px 7px',
      fontSize:   10,
      fontWeight: 700,
      letterSpacing: 0.5,
      fontFamily: 'monospace',
    }}>{text}</span>
  )

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', gap: 12, fontFamily: 'monospace' }}>

      {/* ── Status bar ── */}
      <div style={{
        background: C.panel, border: `1px solid ${C.border}`,
        borderRadius: 8, padding: '12px 16px',
        display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{
            width: 8, height: 8, borderRadius: '50%',
            background: isOnline ? C.green : C.muted,
            boxShadow:  isOnline ? `0 0 6px ${C.green}` : 'none',
            display: 'inline-block',
          }} />
          <span style={{ color: isOnline ? C.green : C.muted, fontWeight: 700, fontSize: 13 }}>
            WORKER {isOnline ? 'ONLINE' : 'OFFLINE'}
          </span>
          {lastLog && (
            <span style={{ color: C.muted, fontSize: 11 }}>
              · last seen {timeAgo(lastLog.created_at)}
            </span>
          )}
        </div>

        {hbMeta && (
          <>
            <div style={{ width: 1, height: 18, background: C.border }} />
            <div style={{ display: 'flex', gap: 16 }}>
              {[
                ['Sweeps', hbMeta.sweeps?.toLocaleString()],
                ['Signals', hbMeta.sigChecks],
                ['Alerts', hbMeta.alerts],
                hbMeta.trades != null ? ['Trades', hbMeta.trades] : null,
                ['Errors', hbMeta.errors],
              ].filter(Boolean).map(([k, v]) => (
                <div key={k as string} style={{ textAlign: 'center' }}>
                  <div style={{ color: C.muted, fontSize: 9, letterSpacing: 1 }}>{k as string}</div>
                  <div style={{ color: C.text, fontSize: 13, fontWeight: 700 }}>{v as string}</div>
                </div>
              ))}
            </div>
            <div style={{ width: 1, height: 18, background: C.border }} />
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              {pill(hbMeta.mode || 'PAPER', hbMeta.mode === 'LIVE' ? C.green : C.amber)}
              {pill(hbMeta.session || '—', C.blue)}
              {pill(hbMeta.market || '—', hbMeta.market === '✅ OPEN' ? C.green : C.muted)}
            </div>
          </>
        )}

        <div style={{ marginLeft: 'auto', display: 'flex', gap: 6, alignItems: 'center' }}>
          <span style={{ color: C.muted, fontSize: 10 }}>auto-refresh 5s</span>
          <button
            onClick={fetchLogs}
            style={{
              background: 'transparent', border: `1px solid ${C.border}`,
              color: C.muted, borderRadius: 4, padding: '2px 8px', cursor: 'pointer', fontSize: 11,
            }}
          >↻</button>
        </div>
      </div>

      {/* ── Filter tabs ── */}
      <div style={{ display: 'flex', gap: 6 }}>
        {LEVELS.map(l => (
          <button
            key={l}
            onClick={() => setFilter(l)}
            style={{
              background:   filter === l ? `${LEVEL_COLOR[l] || C.muted}22` : 'transparent',
              border:       `1px solid ${filter === l ? (LEVEL_COLOR[l] || C.muted) : C.border}`,
              color:        filter === l ? (LEVEL_COLOR[l] || C.text) : C.muted,
              borderRadius: 4,
              padding:      '3px 10px',
              cursor:       'pointer',
              fontSize:     11,
              fontWeight:   filter === l ? 700 : 400,
              fontFamily:   'monospace',
              letterSpacing: 0.5,
            }}
          >
            {LEVEL_ICON[l] || ''} {l.toUpperCase()}
          </button>
        ))}
        <span style={{ marginLeft: 'auto', color: C.muted, fontSize: 11, alignSelf: 'center' }}>
          {logs.length} entries
        </span>
      </div>

      {/* ── Log list ── */}
      {loading ? (
        <div style={{ color: C.muted, textAlign: 'center', padding: 40, fontSize: 13 }}>
          Loading logs…
        </div>
      ) : error ? (
        <div style={{ color: C.red, textAlign: 'center', padding: 40, fontSize: 13 }}>
          ⚠ {error}
          {error.includes('does not exist') && (
            <div style={{ marginTop: 12, color: C.muted, fontSize: 11, maxWidth: 480, margin: '12px auto 0' }}>
              Run the SQL migration first:<br />
              <code style={{ color: C.amber }}>supabase/migrations/20260516_worker_logs.sql</code><br />
              Paste it in the{' '}
              <a href="https://supabase.com/dashboard/project/lfurosnmkwvqtlifggaa/sql"
                 target="_blank" rel="noreferrer"
                 style={{ color: C.blue }}>
                Supabase SQL editor ↗
              </a>
            </div>
          )}
        </div>
      ) : logs.length === 0 ? (
        <div style={{ color: C.muted, textAlign: 'center', padding: 40, fontSize: 13 }}>
          No logs yet — worker will write here on its next significant event
        </div>
      ) : (
        <div
          ref={listRef}
          onScroll={handleScroll}
          style={{
            flex: 1, overflowY: 'auto',
            background: C.bg,
            border: `1px solid ${C.border}`,
            borderRadius: 8,
            padding: '8px 0',
          }}
        >
          {[...logs].reverse().map(log => {
            const color = LEVEL_COLOR[log.level] || C.muted
            const icon  = LEVEL_ICON[log.level]  || '·'
            const meta  = log.metadata as any

            return (
              <div
                key={log.id}
                style={{
                  display: 'flex', gap: 10, padding: '5px 14px',
                  borderBottom: `1px solid ${C.border}22`,
                  alignItems: 'flex-start',
                }}
              >
                {/* timestamp */}
                <span style={{ color: C.muted, fontSize: 10, whiteSpace: 'nowrap', paddingTop: 2, minWidth: 68 }}>
                  {formatTime(log.created_at)}
                </span>

                {/* icon */}
                <span style={{ fontSize: 11, paddingTop: 1 }}>{icon}</span>

                {/* level badge */}
                <span style={{
                  color, fontSize: 9, fontWeight: 700, letterSpacing: 1,
                  paddingTop: 2, minWidth: 64,
                }}>
                  {log.level.toUpperCase()}
                </span>

                {/* pair badge */}
                {log.pair && (
                  <span style={{
                    background: '#1e2535', color: C.text,
                    borderRadius: 3, padding: '0 5px', fontSize: 10,
                    fontWeight: 700, whiteSpace: 'nowrap', paddingTop: 2,
                  }}>
                    {log.pair}
                  </span>
                )}

                {/* message + metadata */}
                <div style={{ flex: 1, minWidth: 0 }}>
                  <span style={{ color, fontSize: 12 }}>{log.message}</span>

                  {/* signal metadata inline */}
                  {log.level === 'signal' && meta && (
                    <div style={{ color: C.muted, fontSize: 10, marginTop: 2 }}>
                      Entry {meta.entry?.toFixed?.(meta.pair?.includes('JPY') ? 3 : 5)}
                      {' · '} SL {meta.sl?.toFixed?.(meta.pair?.includes('JPY') ? 3 : 5)}
                      {' · '} TP {meta.tp?.toFixed?.(meta.pair?.includes('JPY') ? 3 : 5)}
                      {meta.reasons?.length ? ` · ${meta.reasons.slice(0, 2).join(' · ')}` : ''}
                    </div>
                  )}

                  {/* heartbeat stats inline */}
                  {log.level === 'heartbeat' && meta && (
                    <div style={{ color: C.muted, fontSize: 10, marginTop: 2 }}>
                      Sweeps {meta.sweeps?.toLocaleString()} · Alerts {meta.alerts} · Uptime {meta.uptimeH}h
                    </div>
                  )}

                  {/* order metadata */}
                  {log.level === 'order' && meta && (
                    <div style={{ color: C.muted, fontSize: 10, marginTop: 2 }}>
                      {meta.success
                        ? `✓ trade ${meta.tradeId} @ ${meta.filledPrice}`
                        : `blocked: ${(meta.reasons || []).join(', ')}`}
                    </div>
                  )}

                  {/* session tag */}
                  {log.session && (
                    <span style={{ color: C.muted, fontSize: 9, marginLeft: 8 }}>
                      [{log.session}]
                    </span>
                  )}
                </div>
              </div>
            )
          })}
          <div ref={bottomRef} />
        </div>
      )}

      {/* ── Auto-scroll indicator ── */}
      {!autoScroll && (
        <button
          onClick={() => {
            setAutoScroll(true)
            bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
          }}
          style={{
            position: 'absolute', bottom: 80, right: 32,
            background: C.panel, border: `1px solid ${C.border}`,
            color: C.text, borderRadius: 6, padding: '5px 12px',
            cursor: 'pointer', fontSize: 11,
          }}
        >
          ↓ Jump to latest
        </button>
      )}
    </div>
  )
}
