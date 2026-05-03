'use client'
// components/pages/BrokerPage.tsx

import { useState, useEffect } from 'react'
import { Panel, LoadingDots } from '../ui'

const ENV_GUIDES: Record<string, { vars: Array<{ key: string; description: string; example: string }>; steps: string[] }> = {
  oanda: {
    vars: [
      { key: 'TRADING_BROKER',    description: 'Select OANDA',                   example: 'oanda' },
      { key: 'OANDA_API_KEY',     description: 'Personal access token',           example: 'abc123def456...' },
      { key: 'OANDA_ACCOUNT_ID',  description: 'Your account number',             example: '001-001-12345678-001' },
      { key: 'OANDA_BASE_URL',    description: 'Use practice for demo, fxtrade for live', example: 'https://api-fxpractice.oanda.com' },
    ],
    steps: [
      'Sign up at oanda.com — free demo account, no deposit',
      'Log in → My Account → Manage API Access → Generate Token',
      'Copy your Account ID from the main dashboard (format: 001-xxx-xxxxxxxx-xxx)',
      'Leave OANDA_BASE_URL as the practice URL until ready to go live',
    ],
  },
  alpaca: {
    vars: [
      { key: 'TRADING_BROKER',      description: 'Select Alpaca',         example: 'alpaca' },
      { key: 'ALPACA_API_KEY',      description: 'API Key ID (starts PKTEST or PK)', example: 'PKTEST1234567890' },
      { key: 'ALPACA_SECRET_KEY',   description: 'Secret key',            example: 'AbCdEfGh1234567890...' },
      { key: 'ALPACA_BASE_URL',     description: 'Paper or live URL',     example: 'https://paper-api.alpaca.markets' },
    ],
    steps: [
      'Sign up at alpaca.markets — 100% free paper trading, no deposit ever needed',
      'Log in → your account → API Keys → Generate New Key',
      'Copy both the Key ID and Secret Key (secret shown once only)',
      'Keep URL as paper-api for testing. Change to api.alpaca.markets for live.',
    ],
  },
  capital: {
    vars: [
      { key: 'TRADING_BROKER',        description: 'Select Capital.com',                   example: 'capital' },
      { key: 'CAPITAL_API_KEY',       description: 'API key from Capital.com dashboard',   example: 'abc123...' },
      { key: 'CAPITAL_IDENTIFIER',    description: 'Your Capital.com account email address', example: 'you@example.com' },
      { key: 'CAPITAL_PASSWORD',      description: 'Your Capital.com account password',    example: 'YourPassword' },
      { key: 'CAPITAL_BASE_URL',      description: 'Demo or live API URL',                 example: 'https://demo-api-capital.backend.currency.com/api' },
    ],
    steps: [
      'Sign up at capital.com — free demo with £10,000 virtual funds',
      'Log in → Settings → API → Create new API key',
      'Set CAPITAL_API_KEY to the generated key',
      'Set CAPITAL_IDENTIFIER to your account email address (used for login)',
      'Keep the demo URL until confident in the system',
    ],
  },
  ibkr: {
    vars: [
      { key: 'TRADING_BROKER',   description: 'Select Interactive Brokers', example: 'ibkr' },
      { key: 'IBKR_GATEWAY_URL', description: 'URL where Client Portal Gateway runs', example: 'https://localhost:5000' },
      { key: 'IBKR_ACCOUNT_ID',  description: 'Your IB account ID',         example: 'U12345678' },
    ],
    steps: [
      'Open an IBKR account at interactivebrokers.com (paper trading available)',
      'Download the Client Portal API Gateway from IBKR GitHub',
      'Run the gateway locally: ./bin/run.sh root/conf.yaml',
      'Log in at https://localhost:5000 in your browser to authenticate',
      'The gateway must be running for the app to connect',
    ],
  },
  simulation: {
    vars: [
      { key: 'TRADING_BROKER', description: 'Use built-in simulation', example: 'simulation' },
    ],
    steps: [
      'No setup needed — simulation works out of the box',
      'Realistic price simulation with proper spread and volatility',
      'Full order management with simulated TP/SL tracking',
      'Perfect for testing AI signals and strategy before connecting a real broker',
    ],
  },
}

const STATUS_COLOR = {
  active: '#00ff87',
  configured: '#0080ff',
  available: '#ffb800',
  simulation: '#607080',
}

export default function BrokerPage() {
  const [brokerData, setBrokerData] = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const [fetchError, setFetchError] = useState<string | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [copied, setCopied] = useState<string | null>(null)

  useEffect(() => {
    fetch('/api/broker')
      .then(r => r.json())
      .then(d => {
        setBrokerData(d)
        setSelected(d.active)
        setLoading(false)
      })
      .catch(err => {
        setFetchError(err?.message || 'Failed to load broker data')
        setLoading(false)
      })
  }, [])

  function copyEnvBlock(key: string) {
    const guide = ENV_GUIDES[key]
    if (!guide) return
    const text = guide.vars.map(v => `${v.key}=${v.example}`).join('\n')
    navigator.clipboard.writeText(text)
    setCopied(key)
    setTimeout(() => setCopied(null), 2000)
  }

  if (loading) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', padding: 60 }}>
        <LoadingDots />
      </div>
    )
  }

  if (fetchError) {
    return (
      <div style={{ padding: 40, color: '#ff6060', fontFamily: 'JetBrains Mono', fontSize: 13 }}>
        <strong style={{ color: '#ff3056' }}>Connection error:</strong> {fetchError}
      </div>
    )
  }

  const activeBroker = brokerData?.active || 'simulation'
  const guide = selected ? ENV_GUIDES[selected] : null
  const selectedInfo = brokerData?.allBrokers?.find((b: any) => b.key === selected)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, maxWidth: 900 }}>

      {/* Active broker status */}
      <Panel title="ACTIVE BROKER" bright>
        <div style={{ padding: '14px 16px', display: 'flex', alignItems: 'center', gap: 20, flexWrap: 'wrap' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <div style={{
              width: 10, height: 10, borderRadius: '50%',
              background: '#00ff87', boxShadow: '0 0 8px rgba(0,255,135,0.6)'
            }} />
            <span style={{ fontSize: 20, fontWeight: 700, color: '#90b0d0', fontFamily: 'Rajdhani' }}>
              {brokerData?.activeName}
            </span>
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {(brokerData?.supportedPairs || []).map((p: string) => (
              <span key={p} style={{
                fontSize: 11, color: '#60c0ff', background: 'rgba(0,128,255,0.1)',
                border: '1px solid rgba(0,128,255,0.2)', borderRadius: 2, padding: '2px 8px',
                fontFamily: 'JetBrains Mono',
              }}>{p}</span>
            ))}
          </div>
          <div style={{ marginLeft: 'auto', fontSize: 12, color: 'var(--text-muted)' }}>
            Set <code style={{ color: '#ffb800', background: 'rgba(255,184,0,0.1)', padding: '1px 6px', borderRadius: 2 }}>TRADING_BROKER</code> in .env.local to switch
          </div>
        </div>
      </Panel>

      {/* Broker cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 12 }}>
        {(brokerData?.allBrokers || []).map((broker: any) => {
          const isActive = broker.key === activeBroker
          const isSelected = broker.key === selected
          const statusColor = isActive ? STATUS_COLOR.active : broker.configured ? STATUS_COLOR.configured : STATUS_COLOR.available

          return (
            <div
              key={broker.key}
              className={isSelected ? 'panel-bright' : 'panel'}
              onClick={() => setSelected(broker.key)}
              style={{
                padding: 16, cursor: 'pointer',
                borderColor: isSelected ? '#1a3a5c' : undefined,
                transition: 'all 0.15s',
                outline: isActive ? '1px solid rgba(0,255,135,0.3)' : undefined,
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 10 }}>
                <div style={{ fontFamily: 'Rajdhani', fontWeight: 700, fontSize: 16, color: '#90b0d0' }}>
                  {broker.name}
                </div>
                <div style={{ display: 'flex', gap: 6 }}>
                  {isActive && (
                    <span style={{ fontSize: 9, fontWeight: 700, color: '#00ff87', background: 'rgba(0,255,135,0.1)', border: '1px solid rgba(0,255,135,0.3)', borderRadius: 2, padding: '2px 6px', letterSpacing: 1 }}>
                      ACTIVE
                    </span>
                  )}
                  {broker.configured && !isActive && (
                    <span style={{ fontSize: 9, fontWeight: 700, color: '#0080ff', background: 'rgba(0,128,255,0.1)', border: '1px solid rgba(0,128,255,0.3)', borderRadius: 2, padding: '2px 6px', letterSpacing: 1 }}>
                      CONFIGURED
                    </span>
                  )}
                  {broker.demo && (
                    <span style={{ fontSize: 9, color: '#607080', background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 2, padding: '2px 6px', letterSpacing: 1 }}>
                      DEMO ✓
                    </span>
                  )}
                </div>
              </div>

              <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 12, lineHeight: 1.5 }}>
                {broker.description}
              </div>

              {/* Supported pairs preview */}
              <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginBottom: 12 }}>
                {broker.pairs.slice(0, 6).map((p: string) => (
                  <span key={p} style={{ fontSize: 10, color: 'var(--text-muted)', background: 'rgba(255,255,255,0.04)', padding: '1px 5px', borderRadius: 2 }}>
                    {p}
                  </span>
                ))}
                {broker.pairs.length > 6 && (
                  <span style={{ fontSize: 10, color: 'var(--text-dim)' }}>+{broker.pairs.length - 6} more</span>
                )}
              </div>

              {broker.website && (
                <a href={broker.website} target="_blank" rel="noopener noreferrer"
                  style={{ fontSize: 11, color: '#0080ff', textDecoration: 'none' }}
                  onClick={e => e.stopPropagation()}
                >
                  {broker.website.replace('https://', '')} ↗
                </a>
              )}
            </div>
          )
        })}
      </div>

      {/* Setup guide for selected broker */}
      {guide && selectedInfo && (
        <Panel title={`SETUP GUIDE — ${selectedInfo.name.toUpperCase()}`} bright>
          <div style={{ padding: '14px 16px' }}>

            {/* Steps */}
            <div style={{ marginBottom: 20 }}>
              <div style={{ fontSize: 11, color: 'var(--text-muted)', letterSpacing: 1, marginBottom: 10, fontWeight: 700 }}>
                SETUP STEPS
              </div>
              {guide.steps.map((step, i) => (
                <div key={i} style={{ display: 'flex', gap: 12, marginBottom: 8 }}>
                  <div style={{
                    width: 20, height: 20, borderRadius: '50%', flexShrink: 0,
                    background: 'rgba(0,128,255,0.15)', border: '1px solid rgba(0,128,255,0.3)',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    fontSize: 11, color: '#60c0ff', fontFamily: 'JetBrains Mono', fontWeight: 700,
                  }}>
                    {i + 1}
                  </div>
                  <span style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.5 }}>{step}</span>
                </div>
              ))}
            </div>

            {/* Env vars */}
            <div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
                <div style={{ fontSize: 11, color: 'var(--text-muted)', letterSpacing: 1, fontWeight: 700 }}>
                  .ENV.LOCAL VARIABLES
                </div>
                <button
                  className="btn btn-ghost"
                  onClick={() => copyEnvBlock(selected!)}
                  style={{ fontSize: 11, padding: '4px 12px' }}
                >
                  {copied === selected ? '✓ COPIED' : '⎘ COPY ALL'}
                </button>
              </div>

              <div style={{
                background: '#030710', border: '1px solid var(--border)', borderRadius: 3,
                padding: '12px 16px', fontFamily: 'JetBrains Mono', fontSize: 12,
              }}>
                {guide.vars.map((v, i) => (
                  <div key={i} style={{ marginBottom: i < guide.vars.length - 1 ? 10 : 0 }}>
                    <div style={{ display: 'flex', gap: 8, alignItems: 'baseline' }}>
                      <span style={{ color: '#ffb800' }}>{v.key}</span>
                      <span style={{ color: 'var(--text-dim)' }}>=</span>
                      <span style={{ color: '#00c060' }}>{v.example}</span>
                    </div>
                    <div style={{ fontSize: 10, color: 'var(--text-dim)', marginTop: 2, paddingLeft: 0 }}>
                      # {v.description}
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* Restart reminder */}
            <div style={{
              marginTop: 16, padding: '10px 14px',
              background: 'rgba(255,184,0,0.06)', border: '1px solid rgba(255,184,0,0.2)',
              borderRadius: 3, fontSize: 12, color: '#c0a060', lineHeight: 1.6,
            }}>
              <strong style={{ color: '#ffb800' }}>⚠ After editing .env.local: </strong>
              stop the dev server (Ctrl+C) and run <code style={{ color: '#00ff87', background: 'rgba(0,255,135,0.1)', padding: '1px 5px', borderRadius: 2 }}>npm run dev</code> again to apply the new broker.
            </div>
          </div>
        </Panel>
      )}

      {/* How to add a custom broker */}
      <Panel title="ADD YOUR OWN BROKER">
        <div style={{ padding: '14px 16px' }}>
          <div style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.7, marginBottom: 14 }}>
            Any broker with a REST API can be connected. Create a new adapter file in{' '}
            <code style={{ color: '#ffb800', background: 'rgba(255,184,0,0.1)', padding: '1px 6px', borderRadius: 2 }}>lib/brokers/</code>
            {' '}that implements the <code style={{ color: '#60c0ff' }}>IBroker</code> interface, then register it in the index.
          </div>

          <div style={{ background: '#030710', border: '1px solid var(--border)', borderRadius: 3, padding: '14px 16px', fontFamily: 'JetBrains Mono', fontSize: 12, overflowX: 'auto' }}>
            {[
              { color: '#607080', text: '// lib/brokers/mybroker.adapter.ts' },
              { color: '#0080ff', text: "import type { IBroker, Price, Candle, AccountSummary," },
              { color: '#0080ff', text: "  OpenTrade, OrderRequest, OrderResult, CloseResult } from './interface'" },
              { color: '', text: '' },
              { color: '#00c060', text: 'export class MyBroker implements IBroker {' },
              { color: '#90b0d0', text: "  name = 'My Broker'" },
              { color: '#90b0d0', text: "  supportedPairs = ['EUR/USD', 'GBP/USD']" },
              { color: '', text: '' },
              { color: '#607080', text: '  async getPrices(pairs: string[]): Promise<Price[]> { ... }' },
              { color: '#607080', text: '  async getCandles(pair, tf, count): Promise<Candle[]> { ... }' },
              { color: '#607080', text: '  async getAccountSummary(): Promise<AccountSummary> { ... }' },
              { color: '#607080', text: '  async getOpenTrades(): Promise<OpenTrade[]> { ... }' },
              { color: '#607080', text: '  async placeOrder(req): Promise<OrderResult> { ... }' },
              { color: '#607080', text: '  async closeTrade(id): Promise<CloseResult> { ... }' },
              { color: '#607080', text: '  calcPositionSize(bal, risk, sl, pair): number { ... }' },
              { color: '#00c060', text: '}' },
            ].map((line, i) => (
              <div key={i} style={{ color: line.color || 'transparent', minHeight: 18 }}>{line.text || '\u00A0'}</div>
            ))}
          </div>

          <div style={{ marginTop: 12, fontSize: 12, color: 'var(--text-muted)' }}>
            Then add a <code style={{ color: '#ffb800' }}>case 'mybroker':</code> block in{' '}
            <code style={{ color: '#60c0ff' }}>lib/brokers/index.ts</code> and set{' '}
            <code style={{ color: '#ffb800' }}>TRADING_BROKER=mybroker</code> in .env.local.
          </div>
        </div>
      </Panel>
    </div>
  )
}
