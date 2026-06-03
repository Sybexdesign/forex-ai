'use client'
// components/pages/BrokerPage.tsx — Per-user broker management (stored in Supabase)

import { useState, useEffect, useCallback } from 'react'
import { Panel, LoadingDots } from '../ui'
import { BROKER_INFO, type BrokerKey } from '@/lib/brokers/index'
import { authFetch } from '@/lib/api'

interface BrokerConfig {
  id: string
  broker_type: BrokerKey
  label: string
  config: Record<string, string>
  is_active: boolean
}

export default function BrokerPage({ onToast, onBrokerSaved }: { onToast?: (msg: string, color?: string) => void; onBrokerSaved?: () => void }) {
  const [configs, setConfigs] = useState<BrokerConfig[]>([])
  const [loading, setLoading] = useState(true)
  const [editing, setEditing] = useState<Partial<BrokerConfig> | null>(null)
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<string | null>(null)
  const [showSecrets, setShowSecrets] = useState(false)
  const [changingBroker, setChangingBroker] = useState(false)

  const load = useCallback(() => {
    authFetch('/api/broker-config').then(r => r.json()).then(d => {
      setConfigs(d.configs || [])
    }).catch(() => {}).finally(() => setLoading(false))
  }, [])

  useEffect(() => { load() }, [load])

  function startNew(brokerType: BrokerKey) {
    const info = BROKER_INFO[brokerType]
    const config: Record<string, string> = {}
    info.fields.forEach(f => { config[f.key] = '' })
    if (brokerType === 'mt5direct' || brokerType === 'exness') {
      config.webhookToken = crypto.randomUUID().replace(/-/g, '')
    }
    setEditing({ broker_type: brokerType, label: info.name, config, is_active: false })
    setTestResult(null)
    setChangingBroker(false)
  }

  function startEdit(cfg: BrokerConfig) {
    setEditing({ ...cfg, config: { ...cfg.config } })
    setTestResult(null)
    setShowSecrets(false)
  }

  async function save() {
    if (!editing) return
    setSaving(true)
    try {
      const res = await authFetch('/api/broker-config', {
        method: 'POST',
        body: JSON.stringify(editing),
      })
      const d = await res.json()
      if (d.error) { onToast?.('Save failed: ' + d.error, '#ff3056'); return }
      onToast?.('Broker saved', '#00ff87')
      setEditing(null)
      load()
      onBrokerSaved?.()
    } catch (e: any) {
      onToast?.('Error: ' + e.message, '#ff3056')
    } finally { setSaving(false) }
  }

  async function deleteConfig(id: string) {
    if (!confirm('Delete this broker config?')) return
    await authFetch('/api/broker-config', { method: 'DELETE', body: JSON.stringify({ id }) })
    onToast?.('Broker removed', '#ffb800')
    load()
  }

  async function setActive(id: string) {
    await authFetch('/api/broker-config', {
      method: 'POST',
      body: JSON.stringify({ id, is_active: true }),
    })
    onToast?.('Active broker updated', '#00ff87')
    load()
    onBrokerSaved?.()
  }

  async function testConnection() {
    setTesting(true); setTestResult(null)
    try {
      const res = await authFetch('/api/account')
      const d = await res.json()
      const isMt5 = activeConfig?.broker_type === 'mt5direct' || activeConfig?.broker_type === 'exness'
      if (d.error) {
        setTestResult(`✕ Error: ${d.error}`)
      } else if (d.balance > 0) {
        const login = (activeConfig?.config as any)?.login
        const server = (activeConfig?.config as any)?.server
        const extra = login ? ` · Login ${login}${server ? ' @ ' + server : ''}` : ''
        setTestResult(`✓ Connected — ${d.currency || 'USD'} ${d.balance?.toFixed(2)}${extra} via ${d.broker}`)
      } else if (isMt5) {
        const lastSync = (activeConfig?.config as any)?.updatedAt
        if (!lastSync) {
          setTestResult(`⚠ EA has not synced yet — step-by-step checklist:\n1. EA is attached to a chart in MT5\n2. MT5: Tools → Options → Expert Advisors → Allow WebRequest → add the webhook URL\n3. Auto Trading is enabled in the MT5 toolbar`)
        } else {
          const minsAgo = Math.floor((Date.now() - new Date(lastSync).getTime()) / 60000)
          if (minsAgo < 5) {
            setTestResult(`⚠ EA is online (synced ${minsAgo}m ago) but MT5 account shows $0 — account may not be funded or is a demo that hasn't been initialized`)
          } else {
            setTestResult(`⚠ EA last synced ${minsAgo}m ago and appears offline — recheck that MT5 is open and the EA is attached to a chart`)
          }
        }
      } else {
        setTestResult(`⚠ Connected to ${d.broker} but balance is $0 — check your broker API credentials`)
      }
    } catch (e: any) {
      setTestResult('✕ Connection failed: ' + e.message)
    } finally { setTesting(false) }
  }

  const activeConfig = configs.find(c => c.is_active)
  const addBrokerKeys = Object.keys(BROKER_INFO) as BrokerKey[]
  const hasSavedConfig = configs.length > 0

  if (loading) return <div style={{ display: 'flex', justifyContent: 'center', padding: 60 }}><LoadingDots /></div>

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, maxWidth: 960 }}>

      {/* Active broker summary */}
      <Panel title="ACTIVE BROKER" bright>
        <div style={{ padding: '14px 16px', display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
          {activeConfig ? (
            <>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <div style={{ width: 10, height: 10, borderRadius: '50%', background: '#00ff87', boxShadow: '0 0 8px rgba(0,255,135,0.6)' }} />
                <span style={{ fontFamily: 'Rajdhani', fontWeight: 700, fontSize: 18, color: '#90b0d0' }}>
                  {activeConfig.label}
                </span>
                <span style={{ fontSize: 10, color: 'var(--text-muted)', background: 'var(--border)', padding: '2px 8px', borderRadius: 2 }}>
                  {activeConfig.broker_type.toUpperCase()}
                </span>
              </div>
              <div style={{ display: 'flex', gap: 8, marginLeft: 'auto' }}>
                <button onClick={testConnection} disabled={testing} className="btn btn-ghost" style={{ fontSize: 12, padding: '6px 14px' }}>
                  {testing ? <LoadingDots /> : '⚡ Test Connection'}
                </button>
                <button onClick={() => startEdit(activeConfig)} className="btn btn-ghost" style={{ fontSize: 12, padding: '6px 14px' }}>
                  Edit
                </button>
              </div>
              {testResult && (() => {
                const isOk   = testResult.startsWith('✓')
                const isWarn = testResult.startsWith('⚠')
                return (
                  <div style={{
                    width: '100%', padding: '10px 14px', borderRadius: 3, fontSize: 12,
                    background: isOk ? 'rgba(0,255,135,0.06)' : isWarn ? 'rgba(255,184,0,0.07)' : 'rgba(255,48,86,0.06)',
                    border: `1px solid ${isOk ? 'rgba(0,255,135,0.2)' : isWarn ? 'rgba(255,184,0,0.25)' : 'rgba(255,48,86,0.2)'}`,
                    color: isOk ? '#00ff87' : isWarn ? '#ffb800' : '#ff6060',
                    fontFamily: 'JetBrains Mono', whiteSpace: 'pre-line', lineHeight: 1.7,
                  }}>
                    {testResult}
                  </div>
                )
              })()}
            </>
          ) : (
            <span style={{ fontSize: 13, color: 'var(--text-muted)' }}>No active broker — add one below</span>
          )}
        </div>
      </Panel>

      {/* Saved configs */}
      {configs.length > 0 && (
        <Panel title="YOUR BROKER CONFIGS">
          <div style={{ padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 8 }}>
            {configs.map(cfg => {
              const isMt5 = cfg.broker_type === 'mt5direct' || cfg.broker_type === 'exness'
              const pending = (cfg.config as any)?.pendingOrders?.length ?? 0
              const lastSync = (cfg.config as any)?.updatedAt
              const minutesAgo = lastSync ? Math.floor((Date.now() - new Date(lastSync).getTime()) / 60000) : null
              const eaOnline = minutesAgo !== null && minutesAgo < 5
              return (
              <div key={cfg.id} style={{
                display: 'flex', alignItems: 'center', gap: 12,
                padding: '10px 14px', borderRadius: 3,
                background: cfg.is_active ? 'rgba(0,255,135,0.04)' : 'rgba(0,0,0,0.2)',
                border: `1px solid ${cfg.is_active ? 'rgba(0,255,135,0.2)' : 'var(--border)'}`,
              }}>
                <div style={{ flex: 1 }}>
                  <span style={{ fontWeight: 700, color: cfg.is_active ? '#00ff87' : 'var(--text-secondary)', fontSize: 14 }}>{cfg.label}</span>
                  <span style={{ fontSize: 10, color: 'var(--text-muted)', marginLeft: 8 }}>{cfg.broker_type.toUpperCase()}</span>
                  {isMt5 && (
                    <div style={{ marginTop: 4, display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                      <span style={{ fontSize: 10, color: eaOnline ? '#00ff87' : minutesAgo === null ? '#607080' : '#ff6060' }}>
                        {eaOnline ? '● EA online' : minutesAgo === null ? '○ EA never synced' : `○ EA last seen ${minutesAgo}m ago`}
                      </span>
                      {(cfg.config as any)?.login && (
                        <span style={{ fontSize: 10, color: 'var(--text-muted)', fontFamily: 'JetBrains Mono' }}>
                          #{(cfg.config as any).login}{(cfg.config as any).server ? ' · ' + (cfg.config as any).server : ''}
                        </span>
                      )}
                      {(cfg.config as any)?.balance && parseFloat((cfg.config as any).balance) > 0 && (
                        <span style={{ fontSize: 10, color: '#60c0ff', fontFamily: 'JetBrains Mono' }}>
                          {(cfg.config as any).currency || 'USD'} {parseFloat((cfg.config as any).balance).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                        </span>
                      )}
                      {pending > 0 && (
                        <>
                          <span style={{ fontSize: 10, color: '#ffb800', fontFamily: 'JetBrains Mono' }}>
                            ⏳ {pending} order{pending > 1 ? 's' : ''} waiting for EA
                          </span>
                          <button
                            onClick={async () => {
                              await authFetch('/api/broker-config', { method: 'PATCH', body: JSON.stringify({ id: cfg.id }) })
                              onToast?.('Queue cleared', '#ffb800')
                              load()
                            }}
                            style={{ fontSize: 9, padding: '2px 8px', borderRadius: 2, cursor: 'pointer', background: 'none', border: '1px solid #ff6060', color: '#ff6060' }}
                          >Clear</button>
                        </>
                      )}
                    </div>
                  )}
                </div>
                {cfg.is_active && <span style={{ fontSize: 9, color: '#00ff87', fontWeight: 700, letterSpacing: 1 }}>ACTIVE</span>}
                {!cfg.is_active && (
                  <button onClick={() => setActive(cfg.id)} className="btn btn-ghost" style={{ fontSize: 11, padding: '4px 12px' }}>
                    Set Active
                  </button>
                )}
                <button onClick={() => startEdit(cfg)} className="btn btn-ghost" style={{ fontSize: 11, padding: '4px 12px' }}>Edit</button>
                <button onClick={() => deleteConfig(cfg.id)} style={{
                  padding: '4px 12px', borderRadius: 3, cursor: 'pointer', fontSize: 11, background: 'none',
                  border: '1px solid var(--border)', color: '#ff6060',
                }}>✕</button>
              </div>
            )
            })}
          </div>
        </Panel>
      )}

      {/* Edit / Add form */}
      {editing && (
        <Panel title={editing.id ? `EDIT — ${editing.label}` : `ADD ${(editing.broker_type || '').toUpperCase()} BROKER`} bright>
          <div style={{ padding: '14px 16px' }}>
            <div style={{ marginBottom: 16 }}>
              <label style={{ fontSize: 10, color: 'var(--text-muted)', letterSpacing: 1, display: 'block', marginBottom: 6 }}>LABEL</label>
              <input
                value={editing.label || ''}
                onChange={e => setEditing(s => ({ ...s!, label: e.target.value }))}
                style={inputSt}
                placeholder="My FTMO Account"
              />
            </div>
            {(BROKER_INFO[editing.broker_type as BrokerKey]?.fields || []).map(f => (
              <div key={f.key} style={{ marginBottom: 14 }}>
                <label style={{ fontSize: 10, color: 'var(--text-muted)', letterSpacing: 1, display: 'block', marginBottom: 6 }}>
                  {f.label.toUpperCase()}
                  {f.secret && <span style={{ marginLeft: 6, fontSize: 9, color: '#607080' }}>encrypted</span>}
                </label>
                <div style={{ position: 'relative' }}>
                  <input
                    type={f.secret && !showSecrets ? 'password' : 'text'}
                    value={editing.config?.[f.key] || ''}
                    onChange={e => setEditing(s => ({ ...s!, config: { ...s!.config, [f.key]: e.target.value } }))}
                    placeholder={f.placeholder}
                    style={inputSt}
                  />
                </div>
              </div>
            ))}
            {(editing.broker_type === 'mt5direct' || editing.broker_type === 'exness') && editing.config?.webhookToken && (() => {
              const token = editing.config.webhookToken
              const supabaseUrl = `https://lfurosnmkwvqtlifggaa.supabase.co/rest/v1/rpc/mt5_webhook_sync`
              return (
                <div style={{ marginBottom: 14 }}>
                  {/* Setup instructions */}
                  <div style={{ padding: '12px 14px', background: 'rgba(0,255,135,0.04)', border: '1px solid rgba(0,255,135,0.2)', borderRadius: 3, fontSize: 12, color: '#80d0a0', marginBottom: 12 }}>
                    <div style={{ fontWeight: 700, marginBottom: 8, color: '#00ff87' }}>EA v7 setup — trade management + fast order polling (2s), direct Supabase sync:</div>
                    <div style={{ marginBottom: 5 }}>1. Save this broker config, then download <strong>SybexForexAI_EA_v7.mq5</strong> below</div>
                    <div style={{ marginBottom: 5 }}>2. In MT5: <strong>Tools → Options → Expert Advisors → Allow WebRequest</strong> → add the Supabase URL below</div>
                    <div style={{ marginBottom: 5 }}>3. Compile the EA in MetaEditor and attach to any chart</div>
                    <div>4. In EA Inputs, paste your <strong>Webhook Token</strong> — copy it below</div>
                  </div>

                  {/* Supabase URL to add to MT5 allowed list */}
                  <label style={{ fontSize: 10, color: 'var(--text-muted)', letterSpacing: 1, display: 'block', marginBottom: 6 }}>ADD THIS URL TO MT5 ALLOWED WEBREQUEST URLS</label>
                  <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
                    <input readOnly value={supabaseUrl} style={{ ...inputSt, flex: 1, fontSize: 11, color: '#60c0ff' }} />
                    <button
                      onClick={() => { navigator.clipboard.writeText(supabaseUrl); onToast?.('URL copied', '#00ff87') }}
                      className="btn btn-ghost" style={{ fontSize: 11, padding: '6px 12px', flexShrink: 0 }}
                    >Copy</button>
                  </div>

                  {/* Webhook token */}
                  <label style={{ fontSize: 10, color: 'var(--text-muted)', letterSpacing: 1, display: 'block', marginBottom: 6 }}>WEBHOOK TOKEN (paste into EA v7 Inputs → WebhookToken)</label>
                  <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
                    <input readOnly value={token} style={{ ...inputSt, flex: 1, fontSize: 13, color: '#00e5b4', letterSpacing: 1, fontFamily: 'monospace' }} />
                    <button
                      onClick={() => { navigator.clipboard.writeText(token); onToast?.('Token copied', '#00ff87') }}
                      className="btn btn-ghost" style={{ fontSize: 11, padding: '6px 12px', flexShrink: 0 }}
                    >Copy</button>
                  </div>

                  {/* Download EA v7 */}
                  <a
                    href="/SybexForexAI_EA_v7.mq5"
                    download="SybexForexAI_EA_v7.mq5"
                    style={{
                      display: 'inline-flex', alignItems: 'center', gap: 8,
                      background: 'rgba(0,229,180,0.12)', color: '#00e5b4',
                      border: '1px solid rgba(0,229,180,0.4)', borderRadius: 5,
                      padding: '8px 18px', fontSize: 13, fontWeight: 700,
                      textDecoration: 'none', letterSpacing: 0.3,
                    }}
                  >
                    ↓ Download SybexForexAI_EA_v7.mq5
                  </a>
                  <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 6 }}>
                    v7.1 — fix retcode 10013: add SymbolSuffix input (set to <strong>.s</strong> for Exness)
                  </div>
                </div>
              )
            })()}
            <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
              <button onClick={save} disabled={saving} className="btn" style={{ padding: '10px 24px', fontSize: 13 }}>
                {saving ? 'Saving…' : 'SAVE BROKER'}
              </button>
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--text-muted)', cursor: 'pointer' }}>
                <input type="checkbox" checked={editing.is_active || false}
                  onChange={e => setEditing(s => ({ ...s!, is_active: e.target.checked }))} />
                Set as active broker
              </label>
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--text-muted)', cursor: 'pointer', marginLeft: 'auto' }}>
                <input type="checkbox" checked={showSecrets} onChange={e => setShowSecrets(e.target.checked)} />
                Show secrets
              </label>
              <button onClick={() => setEditing(null)} className="btn btn-ghost" style={{ fontSize: 12, padding: '8px 16px' }}>
                Cancel
              </button>
            </div>
          </div>
        </Panel>
      )}

      {/* Add new broker cards — only shown when no saved config, or user clicked Change Broker */}
      {!editing && (!hasSavedConfig || changingBroker) && (
        <Panel title="ADD BROKER">
          <div style={{ padding: '14px 16px', display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 10 }}>
            {addBrokerKeys.map(key => {
              const info = BROKER_INFO[key]
              const isExness = key === 'exness'
              const isMt5 = key === 'mt5direct'
              return (
                <button key={key} onClick={() => startNew(key)} style={{
                  padding: '14px 16px', borderRadius: 4, cursor: 'pointer', textAlign: 'left',
                  background: isExness ? 'rgba(0,255,135,0.04)' : 'rgba(0,0,0,0.2)',
                  border: isExness ? '1px solid rgba(0,255,135,0.3)' : '1px solid var(--border)',
                  transition: 'all 0.15s',
                }}>
                  <div style={{ fontFamily: 'Rajdhani', fontWeight: 700, fontSize: 15, color: '#90b0d0', marginBottom: 6 }}>
                    {info.name}
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.5 }}>{info.description}</div>
                  {isExness && (
                    <div style={{ marginTop: 6, fontSize: 10, color: '#00ff87', fontWeight: 700 }}>🔥 RECOMMENDED</div>
                  )}
                  {isMt5 && (
                    <>
                      <div style={{ marginTop: 6, fontSize: 10, color: '#ffb800', fontWeight: 700 }}>🏆 FTMO COMPATIBLE</div>
                      <div style={{ marginTop: 3, fontSize: 10, color: '#00ff87' }}>✓ No MetaApi required</div>
                    </>
                  )}
                  {info.demo && !isExness && (
                    <div style={{ marginTop: 6, fontSize: 10, color: '#60c0ff' }}>✓ Demo available</div>
                  )}
                </button>
              )
            })}
          </div>
        </Panel>
      )}

      {/* Change broker button — shown when user already has a saved config and not currently changing */}
      {!editing && hasSavedConfig && !changingBroker && (
        <div style={{ display: 'flex', justifyContent: 'center' }}>
          <button
            onClick={() => setChangingBroker(true)}
            className="btn btn-ghost"
            style={{ fontSize: 13, padding: '10px 28px', letterSpacing: 1 }}
          >
            CHANGE BROKER
          </button>
        </div>
      )}
    </div>
  )
}

const inputSt: React.CSSProperties = {
  width: '100%', padding: '10px 12px', borderRadius: 3, boxSizing: 'border-box',
  background: 'rgba(0,0,0,0.3)', border: '1px solid var(--border)',
  color: 'var(--text-primary)', fontSize: 13, fontFamily: 'JetBrains Mono',
}
