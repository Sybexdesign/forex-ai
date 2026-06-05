'use client'
// components/AppShell.tsx

import { useState, useEffect, useCallback, useRef } from 'react'
import { Toast, LiveDot } from './ui'
import DashboardPage from './pages/DashboardPage'
import AnalysisPage from './pages/AnalysisPage'
import StrategyPage from './pages/StrategyPage'
import JournalPage from './pages/JournalPage'
import SignalsPage from './pages/SignalsPage'
import BrokerPage from './pages/BrokerPage'
import MetalsPage from './pages/MetalsPage'
import AdvancedPage from './pages/AdvancedPage'
import AutoTradePage from './pages/AutoTradePage'
import PropFirmPage from './pages/PropFirmPage'
import AdminPage from './pages/AdminPage'
// import ScalpPage from './pages/ScalpPage'
import ScalperPage from './pages/ScalperPage'
import WorkerPage from './pages/WorkerPage'
import AuthPage from './AuthPage'
import { usePriceFeed, useAccount, useNews, useStrategy, useTrades, useSignals } from '@/hooks/useForex'
import { useScanner } from '@/hooks/useScanner'
import { useAuth } from '@/hooks/useAuth'
import type { StrategySettings } from '@/lib/supabase'
import { DEFAULT_STRATEGY } from '@/lib/supabase'

const METALS_ONLY = ['XAU/USD', 'XAG/USD']
const FALLBACK_PAIRS = METALS_ONLY

function buildNav(isAdmin: boolean) {
  const nav = [
    { id: 'dashboard', label: 'Dashboard',    icon: '◈', shortcut: 'D' },
    { id: 'auto',      label: 'Auto Trade',   icon: '🤖', shortcut: 'T' },
    { id: 'analysis',  label: 'AI Analysis',  icon: '⚡', shortcut: 'A' },
    { id: 'strategy',  label: 'Strategy',     icon: '⚙', shortcut: 'S' },
    { id: 'journal',   label: 'Journal',      icon: '📋', shortcut: 'J' },
    { id: 'signals',   label: 'Signals',      icon: '📡', shortcut: 'G' },
    { id: 'advanced',  label: 'Advanced TA',  icon: '📐', shortcut: 'V' },
    { id: 'metals',    label: 'Gold & Silver', icon: '🥇', shortcut: 'M' },
    { id: 'propfirm',  label: 'Prop Firm',    icon: '🏆', shortcut: 'P' },
    { id: 'broker',    label: 'Brokers',      icon: '🔌', shortcut: 'B' },
    // { id: 'scalp',     label: 'Scalp Mode',   icon: '⚡', shortcut: 'X' },
    { id: 'scalper',   label: 'AI Scalper',   icon: '🤖', shortcut: 'R' },
    { id: 'worker',    label: 'Worker Logs',  icon: '📟', shortcut: 'W' },
  ]
  if (isAdmin) nav.push({ id: 'admin', label: 'Admin', icon: '🛡', shortcut: 'Z' })
  return nav
}

const PAGE_TITLES: Record<string, string> = {
  dashboard: 'LIVE DASHBOARD',
  auto:      'AUTO TRADE — PHASE 1',
  analysis:  'AI MARKET ANALYSIS',
  strategy:  'STRATEGY SETTINGS',
  journal:   'TRADE JOURNAL',
  signals:   'SIGNAL HISTORY',
  advanced:  'ADVANCED TECHNICAL ANALYSIS',
  metals:    'GOLD & SILVER TRADING',
  propfirm:  'PROP FIRM EVALUATION',
  broker:    'BROKER CONNECTIONS',
  // scalp:     '⚡ 5M SCALPING MODE',
  scalper:   '🤖 FOREXAI SCALPER',
  worker:    '📟 WORKER MONITOR',
  admin:     'ADMIN — USER MANAGEMENT',
}

interface ToastItem { id: number; msg: string; color?: string }

export default function AppShell() {
  const { user, loading: authLoading, signOut, isAdmin } = useAuth()
  const [page, setPage] = useState('dashboard')
  const [toasts, setToasts] = useState<ToastItem[]>([])
  const [toastId, setToastId] = useState(0)
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false)
  const [theme, setTheme] = useState<'dark' | 'light'>(() => {
    if (typeof window !== 'undefined') {
      return (localStorage.getItem('forexai_theme') as 'dark' | 'light') || 'dark'
    }
    return 'dark'
  })
  const { strategy: savedStrategy, save: saveStrategy } = useStrategy(user?.id)
  // savedStrategy is initialised from localStorage synchronously, so this is correct on first render.
  // Falls back to DEFAULT_STRATEGY only when the user has never saved (no localStorage entry).
  const strategy = savedStrategy ?? DEFAULT_STRATEGY

  const [scanTimeframe, setScanTimeframe] = useState('5m')
  const [anthropicOk, setAnthropicOk] = useState<boolean | null>(null)
  const [showCreditAlert, setShowCreditAlert] = useState(false)
  const creditCheckRef = useRef<ReturnType<typeof setInterval> | null>(null)

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme)
    localStorage.setItem('forexai_theme', theme)
  }, [theme])

  const pricePairs = METALS_ONLY
  const { prices } = usePriceFeed(pricePairs, 5000)
  const { account, refresh: refreshAccount } = useAccount()
  const news = useNews()
  const { trades, refresh: refreshTrades } = useTrades(user?.id)
  const { signals } = useSignals(user?.id)

  // Poll Anthropic credit status every 5 minutes
  useEffect(() => {
    async function checkCredits() {
      try {
        const res = await fetch('/api/anthropic-status')
        const data = await res.json()
        setAnthropicOk(data.ok)
        if (!data.ok) setShowCreditAlert(true)
      } catch { /* network error — ignore */ }
    }
    checkCredits()
    creditCheckRef.current = setInterval(checkCredits, 5 * 60 * 1000)
    return () => { if (creditCheckRef.current) clearInterval(creditCheckRef.current) }
  }, [])

  const addToast = useCallback((msg: string, color?: string) => {
    const id = toastId + 1
    setToastId(id)
    setToasts(prev => [...prev, { id, msg, color }].slice(-3))
  }, [toastId])

  const removeToast = useCallback((id: number) => {
    setToasts(prev => prev.filter(t => t.id !== id))
  }, [])

  const handleSaveStrategy = useCallback(async (s: StrategySettings) => {
    await saveStrategy(s)   // writes to localStorage → updates savedStrategy → re-renders AppShell
    addToast('Strategy settings saved', '#00ff87')
  }, [saveStrategy, addToast])

  const NAV = buildNav(isAdmin)

  // Keyboard shortcuts
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return
      const item = NAV.find(n => n.shortcut === e.key.toUpperCase())
      if (item) setPage(item.id)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [NAV])

  // Today's P/L
  const today = new Date().toDateString()
  const todayTrades = trades.filter(t => t.closed_at && new Date(t.closed_at).toDateString() === today)
  const todayPL = todayTrades.reduce((s: number, t: any) => s + (t.pl_usd || 0), 0)
  const wins = trades.filter((t: any) => t.result === 'WIN').length
  const winRate = trades.length ? Math.round((wins / trades.length) * 100) : 0

  // Single scanner instance — always metals only, regardless of what's saved in strategy.watchlist
  const rawWatchlist = strategy.watchlist?.length ? strategy.watchlist : FALLBACK_PAIRS
  const watchlist = rawWatchlist.filter(p => METALS_ONLY.includes(p)).length
    ? rawWatchlist.filter(p => METALS_ONLY.includes(p))
    : METALS_ONLY
  const scanner = useScanner(
    strategy,
    {
      newsInWindow: news?.hasHighImpactInWindow || false,
      openPositions: account?.openTradeCount || 0,
      todayPL,
      accountBalance: account?.balance || 10000,
    },
    watchlist,
    scanTimeframe,
  )

  // Show auth screen while loading or when not logged in
  if (authLoading) {
    return (
      <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#020810' }}>
        <div style={{ color: 'var(--text-muted)', fontFamily: 'Rajdhani', fontSize: 16, letterSpacing: 3 }}>LOADING…</div>
      </div>
    )
  }
  if (!user) return <AuthPage />

  return (
    <div className="scanline-bg" style={{ display: 'flex', minHeight: '100vh' }}>
      {/* ─── Sidebar ────────────────────────────────────────────────────── */}
      <aside className="sidebar" style={{
        width: 210, flexShrink: 0,
        background: 'linear-gradient(180deg,#060e1e 0%,#040810 100%)',
        borderRight: '1px solid var(--border)',
        display: 'flex', flexDirection: 'column',
        position: 'sticky', top: 0, height: '100vh', overflowY: 'auto',
      }}>
        {/* Logo */}
        <div style={{ padding: '18px 16px 14px', borderBottom: '1px solid var(--border)' }}>
          <div style={{ fontFamily: 'Rajdhani', fontWeight: 900, fontSize: 20, letterSpacing: 2, lineHeight: 1 }}>
            <span style={{ color: 'var(--text-secondary)' }}>SYBEX </span>
            <span style={{ color: '#0080ff' }}>FOREX</span>
            <span style={{ color: '#00ff87' }}>AI</span>
          </div>
          <div style={{ fontSize: 9, color: 'var(--text-dim)', letterSpacing: 2, marginTop: 3 }}>
            INTELLIGENT TRADING TERMINAL
          </div>
        </div>

        {/* Live status */}
        <div style={{ padding: '8px 16px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 8 }}>
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
              {item.id === 'auto' && scanner.pendingSignals.length > 0 && (
                <span style={{
                  marginLeft: 6, minWidth: 18, height: 18, borderRadius: 9,
                  background: '#ff3056', color: '#fff', fontSize: 10, fontWeight: 700,
                  display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '0 5px',
                }}>
                  {scanner.pendingSignals.length}
                </span>
              )}
              <span style={{ marginLeft: 'auto', fontSize: 9, color: 'var(--text-dim)', background: 'var(--border)', padding: '1px 5px', borderRadius: 2 }}>
                {item.shortcut}
              </span>
            </button>
          ))}
        </nav>

        {/* Account summary */}
        <div style={{ padding: '12px 16px', borderTop: '1px solid var(--border)', fontSize: 12 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
            <span style={{ color: 'var(--text-muted)', fontSize: 10, letterSpacing: 1 }}>ACCOUNT</span>
            {account?.broker && (
              <span style={{ fontSize: 9, color: account.balance > 0 ? '#00ff87' : '#ffb800', letterSpacing: 0.5, maxWidth: 90, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {account.broker}
              </span>
            )}
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
            <span style={{ color: 'var(--text-muted)' }}>
              Balance{account?.simulated ? <span style={{ fontSize: 9, color: '#ffb800', marginLeft: 4 }}>manual</span> : ''}
            </span>
            <span className="mono" style={{ color: account?.simulated ? '#ffb800' : account?.balance ? '#60c0ff' : '#ff6060' }}>
              {account === null
                ? '…'
                : account.balance > 0
                  ? `$${account.balance.toLocaleString('en', { minimumFractionDigits: 2 })}`
                  : <span
                      onClick={() => setPage('broker')}
                      style={{ cursor: 'pointer', textDecoration: 'underline', fontSize: 10 }}
                      title={account.brokerError || 'Go to Broker page to connect your account'}
                    >Not synced</span>
              }
            </span>
          </div>
          {account?.brokerError && (
            <div
              onClick={() => setPage('broker')}
              style={{ fontSize: 9, color: '#ff6060', marginBottom: 4, cursor: 'pointer', lineHeight: 1.4, wordBreak: 'break-word' }}
            >
              ⚠ {account.brokerError}
            </div>
          )}
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

        {/* User + sign out */}
        <div style={{ padding: '10px 16px', borderTop: '1px solid var(--border)' }}>
          <div style={{ fontSize: 10, color: 'var(--text-muted)', marginBottom: 6, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {isAdmin ? '🛡 ' : ''}{user.email}
          </div>
          <button
            onClick={signOut}
            className="signout-btn"
            style={{
              width: '100%', padding: '6px', borderRadius: 3, cursor: 'pointer',
              background: 'rgba(255,255,255,0.03)', border: '1px solid var(--border)',
              color: 'var(--text-muted)', fontSize: 11, letterSpacing: 1,
            }}
          >
            SIGN OUT
          </button>
        </div>
      </aside>

      {/* ─── Main ──────────────────────────────────────────────────────── */}
      <main style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0, overflow: 'hidden' }}>
        {/* Top bar */}
        <header style={{
          background: 'var(--bg-panel)', borderBottom: '1px solid var(--border)',
          padding: '0 14px', height: 48, flexShrink: 0,
          display: 'flex', alignItems: 'center', gap: 12,
        }}>
          {/* Hamburger — tablet + mobile only */}
          <button
            className="hamburger-btn"
            onClick={() => setMobileMenuOpen(true)}
            aria-label="Open navigation menu"
          >
            ☰
          </button>
          {/* Brand — tablet + mobile only (sidebar hidden) */}
          <div className="mobile-logo">
            <span style={{ color: 'var(--text-secondary)' }}>SYBEX </span>
            <span style={{ color: '#0080ff' }}>FOREX</span>
            <span style={{ color: '#00ff87' }}>AI</span>
          </div>
          <span className="header-page-title" style={{ fontFamily: 'Rajdhani', fontWeight: 700, fontSize: 14, color: '#60c0ff', letterSpacing: 2 }}>
            {PAGE_TITLES[page] || page.toUpperCase()}
          </span>
          {news.hasHighImpactInWindow && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11 }}>
              <span className="blink" style={{ color: '#ff3056' }}>⚠</span>
              <span className="header-news-text" style={{ color: '#ff8060' }}>
                {news.events.find(e => e.isInWindow)?.title} in{' '}
                <span className="mono" style={{ color: '#ffb800' }}>{news.events.find(e => e.isInWindow)?.minutesAway}m</span>
              </span>
            </div>
          )}
          {news.simulated && (
            <span title="ForexFactory calendar unavailable — news feed offline, trade blocks disabled" style={{ fontSize: 10, color: '#ff9800', border: '1px solid rgba(255,152,0,0.35)', padding: '1px 6px', borderRadius: 2 }}>
              news: offline
            </span>
          )}
          {/* Theme toggle — always visible */}
          <button
            onClick={() => setTheme(t => t === 'dark' ? 'light' : 'dark')}
            title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
            style={{
              marginLeft: 'auto',
              background: 'transparent',
              border: '1px solid var(--border)',
              borderRadius: 4,
              padding: '4px 9px',
              cursor: 'pointer',
              color: 'var(--text-muted)',
              fontSize: 16,
              lineHeight: 1,
            }}
          >
            {theme === 'dark' ? '☀️' : '🌙'}
          </button>
          <div className="top-bar-meta" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>
              {new Date().toLocaleTimeString('en', { hour12: false })} UTC
            </span>
            {news.hasHighImpactInWindow && (
              <span style={{ background: 'rgba(255,48,86,0.15)', border: '1px solid rgba(255,48,86,0.3)', color: '#ff3056', fontSize: 10, fontWeight: 700, padding: '2px 8px', borderRadius: 2 }}>
                NEWS RISK
              </span>
            )}
            {/* Anthropic credit notification bell */}
            {anthropicOk === false && (
              <div style={{ position: 'relative' }}>
                <button
                  onClick={() => setShowCreditAlert(v => !v)}
                  title="Anthropic API credit alert"
                  style={{
                    background: 'rgba(255,48,86,0.15)', border: '1px solid rgba(255,48,86,0.4)',
                    borderRadius: 4, padding: '3px 8px', cursor: 'pointer',
                    display: 'flex', alignItems: 'center', gap: 5,
                    color: '#ff3056', fontSize: 12, fontWeight: 700,
                  }}
                >
                  <span className="blink">🔔</span>
                  <span style={{ fontSize: 10 }}>AI CREDITS</span>
                </button>
                {showCreditAlert && (
                  <div className="credit-alert-popup" style={{
                    position: 'absolute', top: 36, right: 0, zIndex: 1000,
                    background: 'var(--bg-panel)', border: '1px solid rgba(255,48,86,0.4)',
                    borderRadius: 4, padding: '12px 16px', minWidth: 240,
                    boxShadow: '0 4px 24px rgba(0,0,0,0.5)',
                  }}>
                    <div style={{ fontWeight: 700, color: '#ff3056', fontSize: 13, marginBottom: 6 }}>
                      ⚠ Anthropic API Credits Low
                    </div>
                    <div style={{ fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.6, marginBottom: 10 }}>
                      AI analysis may fail or return inaccurate results. Top up credits at console.anthropic.com to restore full functionality.
                    </div>
                    <a
                      href="https://console.anthropic.com"
                      target="_blank"
                      rel="noopener noreferrer"
                      style={{ fontSize: 11, color: '#60c0ff', textDecoration: 'underline' }}
                    >
                      Open Anthropic Console →
                    </a>
                    <button
                      onClick={() => setShowCreditAlert(false)}
                      style={{
                        display: 'block', marginTop: 10, width: '100%',
                        background: 'transparent', border: '1px solid var(--border)',
                        color: 'var(--text-muted)', borderRadius: 3, padding: '4px', cursor: 'pointer', fontSize: 11,
                      }}
                    >
                      Dismiss
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>
        </header>

        {/* Content */}
        <div className="page-content" style={{ flex: 1, overflowY: 'auto', padding: 20 }}>
          {page === 'dashboard' && <DashboardPage prices={prices} account={account} news={news} trades={trades} onToast={addToast} userId={user?.id} onRefreshAccount={refreshAccount} onRefreshTrades={refreshTrades} />}
          {page === 'auto' && (
            <AutoTradePage
              strategy={strategy} account={account} onToast={addToast}
              onSaveStrategy={handleSaveStrategy}
              newsInWindow={news?.hasHighImpactInWindow || false}
              userId={user?.id} prices={prices}
              onRefreshAccount={refreshAccount} onRefreshTrades={refreshTrades}
              scanner={scanner} timeframe={scanTimeframe}
              setTimeframe={setScanTimeframe} watchlist={watchlist}
            />
          )}
          {page === 'analysis' && (
            <AnalysisPage
              prices={prices} strategy={strategy} news={news} account={account}
              openPositions={account?.openTradeCount || 0} todayPL={todayPL} onToast={addToast}
              userId={user?.id}
              onRefreshAccount={refreshAccount} onRefreshTrades={refreshTrades}
            />
          )}
          {page === 'strategy' && <StrategyPage strategy={strategy} onSave={handleSaveStrategy} />}
          {page === 'journal' && <JournalPage trades={trades} userId={user?.id} onTradeAdded={refreshTrades} account={account} />}
          {page === 'signals' && <SignalsPage signals={signals} />}
          {page === 'advanced' && <AdvancedPage prices={prices} />}
          {page === 'metals' && <MetalsPage prices={prices} strategy={strategy} news={news} account={account} onToast={addToast} userId={user?.id} onRefreshAccount={refreshAccount} onRefreshTrades={refreshTrades} />}
          {page === 'propfirm' && <PropFirmPage trades={trades} onToast={addToast} />}
          {page === 'broker' && <BrokerPage onToast={addToast} onBrokerSaved={refreshAccount} />}
          {/* {page === 'scalp' && <ScalpPage prices={prices} account={account} strategy={strategy} onToast={addToast} userId={user?.id} onRefreshAccount={refreshAccount} onRefreshTrades={refreshTrades} />} */}
          {page === 'scalper' && <ScalperPage prices={prices} account={account} strategy={strategy} onToast={addToast} userId={user?.id} onRefreshAccount={refreshAccount} onRefreshTrades={refreshTrades} />}
          {page === 'worker' && <WorkerPage />}
          {page === 'admin' && isAdmin && <AdminPage onToast={addToast} />}
        </div>
      </main>

      {/* Mobile drawer overlay */}
      <div
        className={`mobile-drawer-overlay${mobileMenuOpen ? ' visible' : ''}`}
        onClick={() => setMobileMenuOpen(false)}
      />

      {/* Mobile drawer — all nav items, account info, sign out */}
      <div className={`mobile-drawer${mobileMenuOpen ? ' open' : ''}`}>
        {/* Header */}
        <div style={{ padding: '16px 16px 12px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexShrink: 0 }}>
          <div style={{ fontFamily: 'Rajdhani', fontWeight: 900, fontSize: 20, letterSpacing: 2, lineHeight: 1 }}>
            <span style={{ color: 'var(--text-secondary)' }}>SYBEX </span>
            <span style={{ color: '#0080ff' }}>FOREX</span>
            <span style={{ color: '#00ff87' }}>AI</span>
          </div>
          <button
            onClick={() => setMobileMenuOpen(false)}
            aria-label="Close menu"
            style={{ background: 'transparent', border: '1px solid var(--border)', borderRadius: 4, color: 'var(--text-muted)', fontSize: 16, width: 32, height: 32, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}
          >
            ✕
          </button>
        </div>

        {/* Live status */}
        <div style={{ padding: '8px 16px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
          <LiveDot />
          <span style={{ fontSize: 11, color: '#00ff87', letterSpacing: 1, fontWeight: 700 }}>LIVE</span>
          <span className="mono" style={{ fontSize: 9, color: 'var(--text-muted)', marginLeft: 'auto' }}>5s FEED</span>
        </div>

        {/* All navigation items */}
        <nav style={{ flex: 1, padding: '6px 0', overflowY: 'auto' }}>
          {NAV.map(item => (
            <button
              key={item.id}
              className={`drawer-nav-btn${page === item.id ? ' active' : ''}`}
              onClick={() => { setPage(item.id); setMobileMenuOpen(false) }}
            >
              <span style={{ fontSize: 16, width: 22, textAlign: 'center', flexShrink: 0 }}>{item.icon}</span>
              <span style={{ flex: 1, textAlign: 'left' }}>{item.label}</span>
              {item.id === 'auto' && scanner.pendingSignals.length > 0 && (
                <span style={{
                  minWidth: 18, height: 18, borderRadius: 9,
                  background: '#ff3056', color: '#fff', fontSize: 10, fontWeight: 700,
                  display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '0 5px',
                }}>
                  {scanner.pendingSignals.length}
                </span>
              )}
              <span style={{ fontSize: 9, color: 'var(--text-dim)', background: 'var(--border)', padding: '1px 5px', borderRadius: 2, marginLeft: 4 }}>
                {item.shortcut}
              </span>
            </button>
          ))}
        </nav>

        {/* Account summary */}
        <div style={{ padding: '12px 16px', borderTop: '1px solid var(--border)', fontSize: 12, flexShrink: 0 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
            <span style={{ color: 'var(--text-muted)', fontSize: 10, letterSpacing: 1 }}>ACCOUNT</span>
            {account?.broker && (
              <span style={{ fontSize: 9, color: account.balance > 0 ? '#00ff87' : '#ffb800', maxWidth: 100, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {account.broker}
              </span>
            )}
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
            <span style={{ color: 'var(--text-muted)' }}>Balance</span>
            <span className="mono" style={{ color: account?.balance ? '#60c0ff' : '#ff6060' }}>
              {account === null ? '…' : account.balance > 0 ? `$${account.balance.toLocaleString('en', { minimumFractionDigits: 2 })}` : 'Not synced'}
            </span>
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

        {/* User + sign out */}
        <div style={{ padding: '10px 16px', borderTop: '1px solid var(--border)', flexShrink: 0 }}>
          <div style={{ fontSize: 10, color: 'var(--text-muted)', marginBottom: 8, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {isAdmin ? '🛡 ' : ''}{user.email}
          </div>
          <button
            onClick={signOut}
            className="signout-btn"
            style={{ width: '100%', padding: '8px', borderRadius: 3, cursor: 'pointer', background: 'rgba(255,255,255,0.03)', border: '1px solid var(--border)', color: 'var(--text-muted)', fontSize: 11, letterSpacing: 1 }}
          >
            SIGN OUT
          </button>
        </div>
      </div>

      {/* Toasts */}
      <div className="toast-container" style={{ position: 'fixed', bottom: 24, right: 16, display: 'flex', flexDirection: 'column', gap: 8, zIndex: 9999 }}>
        {toasts.map(t => (
          <Toast key={t.id} msg={t.msg} color={t.color} onClose={() => removeToast(t.id)} />
        ))}
      </div>
    </div>
  )
}
