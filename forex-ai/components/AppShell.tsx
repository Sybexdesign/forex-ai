'use client'
// components/AppShell.tsx

import { useState, useEffect, useCallback } from 'react'
import { Toast, LiveDot } from './ui'
import DashboardPage from './pages/DashboardPage'
import AnalysisPage from './pages/AnalysisPage'
import StrategyPage from './pages/StrategyPage'
import JournalPage from './pages/JournalPage'
import SignalsPage from './pages/SignalsPage'
import BrokerPage from './pages/BrokerPage'
import MetalsPage from './pages/MetalsPage'
import AdvancedPage from './pages/AdvancedPage'
import { usePriceFeed, useAccount, useNews, useStrategy, useTrades, useSignals } from '@/hooks/useForex'
import type { StrategySettings } from '@/lib/supabase'
import { DEFAULT_STRATEGY } from '@/lib/supabase'

const PAIRS = ['EUR/USD', 'GBP/USD', 'USD/JPY', 'AUD/USD', 'XAU/USD', 'XAG/USD']

const NAV = [
  { id: 'dashboard', label: 'Dashboard',    icon: '◈', shortcut: 'D' },
  { id: 'analysis',  label: 'AI Analysis',  icon: '⚡', shortcut: 'A' },
  { id: 'strategy',  label: 'Strategy',     icon: '⚙', shortcut: 'S' },
  { id: 'journal',   label: 'Journal',      icon: '📋', shortcut: 'J' },
  { id: 'signals',   label: 'Signals',      icon: '📡', shortcut: 'G' },
  { id: 'advanced',  label: 'Advanced TA',   icon: '📐', shortcut: 'V' },
  { id: 'metals',    label: 'Gold & Silver', icon: '🥇', shortcut: 'M' },
  { id: 'broker',    label: 'Brokers',      icon: '🔌', shortcut: 'B' },
]

interface ToastItem { id: number; msg: string; color?: string }

export default function AppShell() {
  const [page, setPage] = useState('dashboard')
  const [toasts, setToasts] = useState<ToastItem[]>([])
  const [toastId, setToastId] = useState(0)
  const [strategy, setStrategy] = useState<StrategySettings>(DEFAULT_STRATEGY)

  const { prices, loading: priceLoading } = usePriceFeed(PAIRS, 5000)
  const account = useAccount()
  const news = useNews()
  const { trades } = useTrades()
  const { signals } = useSignals()
  const { strategy: savedStrategy, save: saveStrategy } = useStrategy()

  useEffect(() => {
    if (savedStrategy) setStrategy(savedStrategy)
  }, [savedStrategy])

  const addToast = useCallback((msg: string, color?: string) => {
    const id = toastId + 1
    setToastId(id)
    setToasts(prev => [...prev, { id, msg, color }].slice(-3))
  }, [toastId])

  const removeToast = useCallback((id: number) => {
    setToasts(prev => prev.filter(t => t.id !== id))
  }, [])

  const handleSaveStrategy = useCallback(async (s: StrategySettings) => {
    setStrategy(s)
    await saveStrategy(s)
    addToast('Strategy settings saved', '#00ff87')
  }, [saveStrategy, addToast])

  // Keyboard shortcuts
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return
      const item = NAV.find(n => n.shortcut === e.key.toUpperCase())
      if (item) setPage(item.id)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // Today's P/L from trades
  const today = new Date().toDateString()
  const todayTrades = trades.filter(t => t.closed_at && new Date(t.closed_at).toDateString() === today)
  const todayPL = todayTrades.reduce((s: number, t: any) => s + (t.pl_usd || 0), 0)
  const wins = trades.filter((t: any) => t.result === 'WIN').length
  const winRate = trades.length ? Math.round((wins / trades.length) * 100) : 0

  const PAGE_TITLES: Record<string, string> = {
    dashboard: 'LIVE DASHBOARD',
    analysis: 'AI MARKET ANALYSIS',
    strategy: 'STRATEGY SETTINGS',
    journal: 'TRADE JOURNAL',
    signals: 'SIGNAL HISTORY',
    advanced: 'ADVANCED TECHNICAL ANALYSIS',
    metals: 'GOLD & SILVER TRADING',
    broker: 'BROKER CONNECTIONS',
  }

  return (
    <div className="scanline-bg" style={{ display: 'flex', minHeight: '100vh' }}>
      {/* ─── Sidebar ─────────────────────────────────────────────────────── */}
      <aside style={{
        width: 210, flexShrink: 0,
        background: 'linear-gradient(180deg,#060e1e 0%,#040810 100%)',
        borderRight: '1px solid var(--border)',
        display: 'flex', flexDirection: 'column',
        position: 'sticky', top: 0, height: '100vh',
        overflowY: 'auto',
      }}>
        {/* Logo */}
        <div style={{ padding: '18px 16px 14px', borderBottom: '1px solid var(--border)' }}>
          <div style={{ fontFamily: 'Rajdhani', fontWeight: 900, fontSize: 22, letterSpacing: 3, lineHeight: 1 }}>
            <span style={{ color: '#0080ff' }}>FOREX</span><span style={{ color: '#00ff87' }}>AI</span>
          </div>
          <div style={{ fontSize: 9, color: 'var(--text-dim)', letterSpacing: 2, marginTop: 3 }}>
            TRADING TERMINAL v2.4
          </div>
        </div>

        {/* Live status */}
        <div style={{
          padding: '8px 16px', borderBottom: '1px solid var(--border)',
          display: 'flex', alignItems: 'center', gap: 8
        }}>
          <LiveDot />
          <span style={{ fontSize: 11, color: '#00ff87', letterSpacing: 1, fontWeight: 700 }}>LIVE</span>
          <span className="mono" style={{ fontSize: 9, color: 'var(--text-muted)', marginLeft: 'auto' }}>5s FEED</span>
        </div>

        {/* Nav */}
        <nav style={{ padding: '8px 6px', flex: 1 }}>
          {NAV.map(item => (
            <button
              key={item.id}
              className={`nav-btn ${page === item.id ? 'active' : ''}`}
              onClick={() => setPage(item.id)}
            >
              <span style={{ fontSize: 15, width: 22, textAlign: 'center' }}>{item.icon}</span>
              <span>{item.label}</span>
              <span style={{ marginLeft: 'auto', fontSize: 9, color: 'var(--text-dim)', background: 'var(--border)', padding: '1px 5px', borderRadius: 2 }}>
                {item.shortcut}
              </span>
            </button>
          ))}
        </nav>

        {/* Account mini-summary */}
        <div style={{ padding: '12px 16px', borderTop: '1px solid var(--border)', fontSize: 12 }}>
          <div style={{ color: 'var(--text-muted)', fontSize: 10, letterSpacing: 1, marginBottom: 8 }}>ACCOUNT</div>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
            <span style={{ color: 'var(--text-muted)' }}>Balance</span>
            <span className="mono" style={{ color: '#60c0ff' }}>${(account?.balance || 10284.50).toLocaleString('en', { minimumFractionDigits: 2 })}</span>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
            <span style={{ color: 'var(--text-muted)' }}>Today P/L</span>
            <span className="mono" style={{ color: todayPL >= 0 ? '#00ff87' : '#ff3056' }}>
              {todayPL >= 0 ? '+' : ''}${todayPL.toFixed(2)}
            </span>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
            <span style={{ color: 'var(--text-muted)' }}>Win Rate</span>
            <span className="mono" style={{ color: winRate > 50 ? '#00ff87' : '#ff6060' }}>{winRate}%</span>
          </div>
        </div>

        {/* Demo badge */}
        <div style={{ padding: '10px 16px', borderTop: '1px solid var(--border)' }}>
          <div style={{
            background: 'rgba(255,184,0,0.08)', border: '1px solid rgba(255,184,0,0.25)',
            borderRadius: 3, padding: '5px 10px', textAlign: 'center'
          }}>
            <span style={{ fontSize: 11, color: '#ffb800', fontWeight: 700, letterSpacing: 1 }}>🔒 DEMO MODE</span>
          </div>
        </div>
      </aside>

      {/* ─── Main ────────────────────────────────────────────────────────── */}
      <main style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0, overflow: 'hidden' }}>
        {/* Top bar */}
        <header style={{
          background: '#060e1e',
          borderBottom: '1px solid var(--border)',
          padding: '0 20px',
          height: 48, flexShrink: 0,
          display: 'flex', alignItems: 'center', gap: 16
        }}>
          <span style={{ fontFamily: 'Rajdhani', fontWeight: 700, fontSize: 14, color: '#60c0ff', letterSpacing: 2 }}>
            {PAGE_TITLES[page]}
          </span>
          {news.hasHighImpactInWindow && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11 }}>
              <span className="blink" style={{ color: '#ff3056' }}>⚠</span>
              <span style={{ color: '#ff8060' }}>
                {news.events.find(e => e.isInWindow)?.title} in{' '}
                <span className="mono" style={{ color: '#ffb800' }}>
                  {news.events.find(e => e.isInWindow)?.minutesAway}m
                </span>
              </span>
            </div>
          )}
          <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>
              {new Date().toLocaleTimeString('en', { hour12: false })} UTC
            </span>
            {news.hasHighImpactInWindow && (
              <span style={{ background: 'rgba(255,48,86,0.15)', border: '1px solid rgba(255,48,86,0.3)', color: '#ff3056', fontSize: 10, fontWeight: 700, padding: '2px 8px', borderRadius: 2 }}>
                NEWS RISK
              </span>
            )}
          </div>
        </header>

        {/* Content */}
        <div style={{ flex: 1, overflowY: 'auto', padding: 20 }}>
          {page === 'dashboard' && (
            <DashboardPage
              prices={prices}
              account={account}
              news={news}
              trades={trades}
              onToast={addToast}
            />
          )}
          {page === 'analysis' && (
            <AnalysisPage
              prices={prices}
              strategy={strategy}
              news={news}
              account={account}
              openPositions={account?.openTradeCount || 0}
              todayPL={todayPL}
              onToast={addToast}
            />
          )}
          {page === 'strategy' && (
            <StrategyPage
              strategy={strategy}
              onSave={handleSaveStrategy}
            />
          )}
          {page === 'journal' && <JournalPage trades={trades} />}
          {page === 'signals' && <SignalsPage signals={signals} />}
          {page === 'advanced' && <AdvancedPage prices={prices} />}
          {page === 'metals' && <MetalsPage prices={prices} strategy={strategy} news={news} account={account} onToast={addToast} />}
          {page === 'broker' && <BrokerPage />}
        </div>
      </main>

      {/* Toasts */}
      <div style={{ position: 'fixed', bottom: 24, right: 24, display: 'flex', flexDirection: 'column', gap: 8, zIndex: 9999 }}>
        {toasts.map(t => (
          <Toast key={t.id} msg={t.msg} color={t.color} onClose={() => removeToast(t.id)} />
        ))}
      </div>
    </div>
  )
}
