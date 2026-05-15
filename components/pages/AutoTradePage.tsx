'use client'
// components/pages/AutoTradePage.tsx
// Full-auto + semi-auto trading with prop firm enforcement

import { useState, useEffect, useRef, useCallback } from 'react'
import { Panel, LoadingDots } from '../ui'
import { calcStandardPositionSize, getPipValue, getPipValuePerLot } from '@/lib/brokers/interface'
import { authFetch } from '@/lib/api'
import type { ScanSignal } from '@/hooks/useScanner'
import type { StrategySettings } from '@/lib/supabase'

const TIMEFRAMES = ['1m', '3m', '5m', '15m', '30m', '1H', '4H']
const DIR_COLOR: Record<string, string> = { BUY: 'var(--color-buy)', SELL: 'var(--color-sell)' }
const PAGE_SIZE = 5

function Pager({ page, total, onPage }: { page: number; total: number; onPage: (p: number) => void }) {
  const pages = Math.ceil(total / PAGE_SIZE)
  if (pages <= 1) return null
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 10, paddingTop: 8 }}>
      <button onClick={() => onPage(page - 1)} disabled={page === 0} className="btn btn-ghost" style={{ fontSize: 11, padding: '4px 12px' }}>← Prev</button>
      <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{page + 1} / {pages}</span>
      <button onClick={() => onPage(page + 1)} disabled={page >= pages - 1} className="btn btn-ghost" style={{ fontSize: 11, padding: '4px 12px' }}>Next →</button>
    </div>
  )
}

interface AutoTradePageProps {
  strategy: StrategySettings
  account: any
  onToast: (msg: string, color?: string) => void
  newsInWindow?: boolean
  userId?: string
  prices?: Record<string, any>
  onRefreshAccount?: () => void
  onRefreshTrades?: () => void
  scanner: {
    enabled: boolean
    setEnabled: (v: boolean) => void
    scanning: boolean
    lastScan: Date | null
    countdown: number
    pendingSignals: ScanSignal[]
    error: string | null
    runScan: () => void
    rejectSignal: (s: ScanSignal) => void
    clearAll: () => void
  }
  timeframe: string
  setTimeframe: (tf: string) => void
  watchlist: string[]
}

export default function AutoTradePage({ strategy, account, onToast, newsInWindow = false, userId, prices = {}, onRefreshAccount, onRefreshTrades, scanner, timeframe, setTimeframe, watchlist }: AutoTradePageProps) {
  const [approvingId, setApprovingId] = useState<string | null>(null)
  const [autoExecute, setAutoExecute] = useState(false)
  const [openTrades, setOpenTrades] = useState<any[]>([])
  const [closingId, setClosingId] = useState<string | null>(null)
  const [tradesLoading, setTradesLoading] = useState(false)
  const [openPage, setOpenPage] = useState(0)
  const autoExecutedRef = useRef<Set<string>>(new Set())

  const accountBalance = account?.balance || 10000

  const { enabled, setEnabled, scanning, lastScan, countdown, pendingSignals, error, runScan, rejectSignal, clearAll } = scanner

  const loadOpenTrades = useCallback(async () => {
    if (!userId) return
    setTradesLoading(true)
    try {
      const res = await fetch(`/api/trades?userId=${userId}&result=OPEN`)
      const data = await res.json()
      setOpenTrades(data.trades || [])
    } catch { /* ignore */ } finally {
      setTradesLoading(false)
    }
  }, [userId])

  useEffect(() => { loadOpenTrades() }, [loadOpenTrades])

  async function placeOrder(signal: ScanSignal) {
    // Always use live price at order time; fall back to scan-time price if feed unavailable
    const livePrice = prices[signal.pair]?.bid || signal.currentPrice
    const res = await authFetch('/api/orders', {
      method: 'POST',
      body: JSON.stringify({
        pair: signal.pair,
        direction: signal.direction,
        strategy,
        currentPrice: livePrice,
        newsInWindow,
        aiConfidence: signal.confidence,
        checklistScore: signal.checklistScore,
        userId,
        signalId: signal.id,
      }),
    })
    return res.json()
  }

  async function handleApprove(signal: ScanSignal) {
    if (signal.simulated) {
      onToast('⚠ Simulated data — cannot place real order', '#ffb800')
      return
    }
    setApprovingId(signal.id)
    try {
      const data = await placeOrder(signal)
      if (data.blocked) {
        onToast('Blocked: ' + (data.reasons?.[0] || 'Risk rule'), '#ff3056')
      } else if (data.success) {
        onToast(`✓ ${signal.direction} ${signal.pair} — ${data.lots} lots queued for broker`, DIR_COLOR[signal.direction])
        rejectSignal(signal)
        loadOpenTrades()
        onRefreshTrades?.()
        setTimeout(() => onRefreshAccount?.(), 1500)
      } else {
        onToast('Order failed: ' + (data.error || 'Unknown'), '#ff3056')
      }
    } catch (e: any) {
      onToast('Error: ' + e.message, '#ff3056')
    } finally {
      setApprovingId(null)
    }
  }

  // Auto-execute: fire approved order as soon as signal arrives
  useEffect(() => {
    if (!autoExecute || !enabled) return
    for (const signal of pendingSignals) {
      if (autoExecutedRef.current.has(signal.id)) continue
      if (signal.simulated) {
        autoExecutedRef.current.add(signal.id)
        onToast(`⚠ Skipped ${signal.pair}: simulated data`, '#ffb800')
        continue
      }
      autoExecutedRef.current.add(signal.id)
      placeOrder(signal).then(data => {
        if (data.blocked) {
          onToast(`Auto-blocked ${signal.pair}: ${data.reasons?.[0]}`, '#ff3056')
        } else if (data.success) {
          onToast(`⚡ Auto: ${signal.direction} ${signal.pair} — ${data.lots} lots`, DIR_COLOR[signal.direction])
          rejectSignal(signal)
          loadOpenTrades()
          onRefreshTrades?.()
          setTimeout(() => onRefreshAccount?.(), 1500)
        } else {
          onToast(`Auto failed ${signal.pair}: ${data.error}`, '#ff3056')
        }
      }).catch(e => onToast('Auto error: ' + e.message, '#ff3056'))
    }
  }, [pendingSignals, autoExecute, enabled]) // eslint-disable-line react-hooks/exhaustive-deps

  async function handleClose(trade: any) {
    setClosingId(trade.id)
    try {
      const res = await authFetch('/api/close-trade', {
        method: 'POST',
        body: JSON.stringify({
          tradeId: trade.id,
          userId,
          pair: trade.pair,
          direction: trade.direction,
        }),
      })
      const data = await res.json()
      if (data.success) {
        onToast(`Closed ${trade.pair} — sent to broker`, '#00ff87')
        loadOpenTrades()
        onRefreshTrades?.()
        setTimeout(() => onRefreshAccount?.(), 1500)
      } else {
        onToast('Close failed: ' + (data.error || 'Unknown'), '#ff3056')
      }
    } catch (e: any) {
      onToast('Close error: ' + e.message, '#ff3056')
    } finally {
      setClosingId(null)
    }
  }

  const fmtCountdown = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>

      {/* Header controls */}
      <Panel title="AUTO TRADER" bright>
        <div style={{ padding: '14px 16px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>

            {/* Scanner ON/OFF */}
            <button
              onClick={() => setEnabled(!enabled)}
              style={{
                padding: '10px 24px', borderRadius: 4, cursor: 'pointer',
                fontFamily: 'Rajdhani', fontWeight: 700, fontSize: 15, letterSpacing: 2,
                background: enabled ? 'rgba(255,48,86,0.12)' : 'rgba(0,104,51,0.1)',
                border: `1px solid ${enabled ? 'rgba(255,48,86,0.4)' : 'rgba(0,104,51,0.35)'}`,
                color: enabled ? 'var(--color-sell)' : 'var(--color-buy)',
                transition: 'all 0.2s',
              }}
            >
              {enabled ? '⏹ STOP SCANNER' : '▶ START SCANNER'}
            </button>

            {/* Auto-execute toggle */}
            <button
              onClick={() => setAutoExecute(v => !v)}
              title={autoExecute ? 'Signals auto-execute on your broker instantly' : 'Click to enable fully automatic execution'}
              style={{
                padding: '10px 20px', borderRadius: 4, cursor: 'pointer',
                fontFamily: 'Rajdhani', fontWeight: 700, fontSize: 14, letterSpacing: 1,
                background: autoExecute ? 'rgba(138,98,0,0.1)' : 'rgba(0,85,176,0.07)',
                border: `1px solid ${autoExecute ? 'rgba(138,98,0,0.4)' : 'rgba(0,85,176,0.3)'}`,
                color: autoExecute ? 'var(--color-wait)' : 'var(--color-accent)',
                transition: 'all 0.2s',
              }}
            >
              {autoExecute ? '⚡ AUTO-EXECUTE ON' : '◎ MANUAL APPROVE'}
            </button>

            {/* Timeframe */}
            <div style={{ display: 'flex', gap: 6 }}>
              {TIMEFRAMES.map(tf => (
                <button
                  key={tf}
                  className={`tab-btn ${timeframe === tf ? 'active' : ''}`}
                  onClick={() => setTimeframe(tf)}
                  disabled={enabled}
                >
                  {tf}
                </button>
              ))}
            </div>

            {/* Manual scan */}
            <button
              className="btn btn-ghost"
              onClick={runScan}
              disabled={scanning}
              style={{ padding: '8px 16px', fontSize: 12 }}
            >
              {scanning ? <LoadingDots /> : '⟳ SCAN NOW'}
            </button>

            {/* Status */}
            <div style={{ marginLeft: 'auto', textAlign: 'right' }}>
              {enabled && !scanning && countdown > 0 && (
                <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                  Next scan in <span className="mono" style={{ color: 'var(--color-accent)' }}>{fmtCountdown(countdown)}</span>
                </div>
              )}
              {scanning && (
                <div style={{ fontSize: 11, color: 'var(--color-wait)' }}>Scanning {watchlist.length} pairs…</div>
              )}
              {lastScan && !scanning && (
                <div style={{ fontSize: 10, color: 'var(--text-dim)', marginTop: 2 }}>
                  Last scan: {lastScan.toLocaleTimeString('en', { hour12: false })}
                </div>
              )}
            </div>
          </div>

          {/* Auto-execute warning */}
          {autoExecute && (
            <div style={{
              marginTop: 12, padding: '8px 12px', borderRadius: 3,
              background: 'rgba(138,98,0,0.08)', border: '1px solid rgba(138,98,0,0.28)',
              fontSize: 12, color: 'var(--color-warn-text)',
            }}>
              ⚡ <strong>Full auto-execute active</strong> — signals that pass all risk & prop firm rules will be placed on your broker automatically. No manual approval needed.
            </div>
          )}

          {/* Watchlist pills */}
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 12 }}>
            {watchlist.map(p => (
              <span key={p} style={{
                fontSize: 11, padding: '2px 8px', borderRadius: 2,
                background: 'rgba(0,85,176,0.08)', border: '1px solid rgba(0,85,176,0.2)',
                color: 'var(--color-accent)', fontFamily: 'JetBrains Mono',
              }}>{p}</span>
            ))}
            <span style={{ fontSize: 11, color: 'var(--text-muted)', alignSelf: 'center', marginLeft: 4 }}>
              scanning {timeframe} timeframe
            </span>
          </div>

          {error && (
            <div style={{ marginTop: 10, padding: '8px 12px', background: 'rgba(200,16,46,0.07)', border: '1px solid rgba(200,16,46,0.25)', borderRadius: 3, fontSize: 12, color: 'var(--color-sell)' }}>
              ⚠ {error}
            </div>
          )}
        </div>
      </Panel>

      {/* Open positions */}
      <Panel title={`OPEN POSITIONS${openTrades.length ? ` (${openTrades.length})` : ''}`}>
        <div style={{ padding: '10px 16px' }}>
          {tradesLoading ? (
            <div style={{ fontSize: 12, color: 'var(--text-muted)', textAlign: 'center', padding: '12px 0' }}>
              <LoadingDots />
            </div>
          ) : openTrades.length === 0 ? (
            <div style={{ fontSize: 12, color: 'var(--text-muted)', textAlign: 'center', padding: '12px 0' }}>
              No open positions — trades placed will appear here
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {openTrades.slice(openPage * PAGE_SIZE, (openPage + 1) * PAGE_SIZE).map(trade => {
                const color = DIR_COLOR[trade.direction] || 'var(--color-wait)'
                const pl = trade.unrealized_pl ?? trade.unrealizedPL ?? 0
                return (
                  <div key={trade.id} className="dir-card" data-dir={trade.direction || 'WAIT'} style={{
                    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                    padding: '8px 12px',
                  }}>
                    <div style={{ display: 'flex', gap: 16, alignItems: 'center' }}>
                      <div>
                        <div style={{ fontSize: 13, fontWeight: 700, color, fontFamily: 'Rajdhani', letterSpacing: 1 }}>
                          {trade.direction}
                        </div>
                        <div style={{ fontSize: 12, color: 'var(--text-primary)', fontWeight: 600 }}>{trade.pair}</div>
                      </div>
                      <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                        <div>{trade.lots?.toFixed(2)} lots</div>
                        <div>@ {trade.entry_price?.toFixed(trade.pair?.includes('JPY') ? 3 : 5) ?? '—'}</div>
                      </div>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                      <div style={{
                        fontSize: 14, fontWeight: 700, fontFamily: 'JetBrains Mono',
                        color: pl >= 0 ? 'var(--color-profit)' : 'var(--color-sell)',
                      }}>
                        {pl >= 0 ? '+' : ''}{pl.toFixed(2)}
                      </div>
                      <button
                        className="btn btn-ghost"
                        onClick={() => handleClose({ ...trade, id: trade.oanda_trade_id || trade.id })}
                        disabled={closingId === (trade.oanda_trade_id || trade.id)}
                        style={{ fontSize: 11, padding: '5px 12px', color: 'var(--color-sell)', borderColor: 'rgba(200,16,46,0.3)' }}
                      >
                        {closingId === (trade.oanda_trade_id || trade.id) ? <LoadingDots /> : 'CLOSE'}
                      </button>
                    </div>
                  </div>
                )
              })}
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <button
                  className="btn btn-ghost"
                  onClick={loadOpenTrades}
                  style={{ fontSize: 11, padding: '6px' }}
                >
                  ⟳ Refresh
                </button>
                <Pager page={openPage} total={openTrades.length} onPage={setOpenPage} />
              </div>
            </div>
          )}
        </div>
      </Panel>

      {/* How it works — only when idle */}
      {!enabled && pendingSignals.length === 0 && (
        <div style={{
          padding: '20px 24px',
          background: 'rgba(0,128,255,0.04)', border: '1px solid rgba(0,128,255,0.15)',
          borderRadius: 4, display: 'flex', flexDirection: 'column', gap: 10,
        }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--color-accent)', letterSpacing: 1 }}>HOW IT WORKS</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {[
              ['1', 'Scanner checks all watchlist pairs every 5 minutes using live data + AI'],
              ['2', 'Only signals passing 6/8 checklist rules and all risk guards appear'],
              ['3', 'Manual mode: review each signal and tap APPROVE to place on your broker'],
              ['4', 'Auto-execute mode: qualifying signals execute instantly on your MT5 broker'],
              ['5', 'Prop firm rules (daily loss, drawdown, news) are enforced on every trade'],
            ].map(([n, text]) => (
              <div key={n} style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
                <span style={{
                  width: 20, height: 20, borderRadius: '50%', background: 'rgba(0,85,176,0.12)',
                  border: '1px solid rgba(0,85,176,0.35)', display: 'flex', alignItems: 'center',
                  justifyContent: 'center', fontSize: 10, color: 'var(--color-accent)', flexShrink: 0, fontWeight: 700,
                }}>{n}</span>
                <span style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.5 }}>{text}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Approval queue — only shown in manual mode */}
      {!autoExecute && pendingSignals.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--color-wait)', letterSpacing: 1 }}>
              ⚡ {pendingSignals.length} SIGNAL{pendingSignals.length > 1 ? 'S' : ''} AWAITING APPROVAL
            </div>
            <button
              className="btn btn-ghost"
              onClick={clearAll}
              style={{ fontSize: 11, padding: '4px 12px' }}
            >
              Dismiss all
            </button>
          </div>

          {pendingSignals.map(signal => (
            <SignalCard
              key={signal.id}
              signal={signal}
              strategy={strategy}
              accountBalance={accountBalance}
              livePrice={prices[signal.pair]?.bid}
              approving={approvingId === signal.id}
              onApprove={() => handleApprove(signal)}
              onReject={() => rejectSignal(signal)}
            />
          ))}
        </div>
      )}

      {/* Auto-execute queue notification */}
      {autoExecute && pendingSignals.length > 0 && (
        <div style={{
          padding: '14px 18px', borderRadius: 4,
          background: 'rgba(255,184,0,0.06)', border: '1px solid rgba(255,184,0,0.25)',
        }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--color-wait)' }}>
            ⚡ Auto-executing {pendingSignals.length} signal{pendingSignals.length > 1 ? 's' : ''}…
          </div>
          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4 }}>
            All risk and prop firm rules are checked before each trade is placed.
          </div>
        </div>
      )}

      {/* Empty state when enabled but no signals yet */}
      {enabled && !scanning && pendingSignals.length === 0 && lastScan && (
        <div style={{
          textAlign: 'center', padding: '40px 20px',
          color: 'var(--text-muted)', fontSize: 13,
        }}>
          <div style={{ fontSize: 28, marginBottom: 12 }}>◎</div>
          <div>No actionable signals found in this scan.</div>
          <div style={{ fontSize: 12, marginTop: 6, color: 'var(--text-dim)' }}>
            Next scan in <span className="mono" style={{ color: 'var(--color-accent)' }}>{fmtCountdown(countdown)}</span> — or hit ⟳ SCAN NOW
          </div>
        </div>
      )}

    </div>
  )
}

// ─── Signal Card ───────────────────────────────────────────────────────────────

function SignalCard({
  signal, strategy, accountBalance, livePrice, approving, onApprove, onReject,
}: {
  signal: ScanSignal
  strategy: StrategySettings
  accountBalance: number
  livePrice?: number
  approving: boolean
  onApprove: () => void
  onReject: () => void
}) {
  // Prefer live broker price; fall back to scan-time price
  const price = livePrice || signal.currentPrice
  const color = DIR_COLOR[signal.direction] || 'var(--color-wait)'
  const pip = getPipValue(signal.pair)
  const pipPerLot = getPipValuePerLot(signal.pair)
  const lots = calcStandardPositionSize(accountBalance, strategy.riskPct, strategy.slPips, signal.pair)
  const riskAmt = (accountBalance * strategy.riskPct / 100).toFixed(2)
  const tpProfit = (pipPerLot * lots * strategy.tpPips).toFixed(2)
  const slLoss = (pipPerLot * lots * strategy.slPips).toFixed(2)
  const dp = signal.pair.includes('JPY') ? 3 : signal.pair.startsWith('XAU') ? 2 : signal.pair.startsWith('XAG') ? 3 : 5
  const sign = signal.direction === 'BUY' ? 1 : -1
  const tpPrice = (price + strategy.tpPips * pip * sign).toFixed(dp)
  const slPrice = (price - strategy.slPips * pip * sign).toFixed(dp)

  // Expiry countdown
  const msLeft = new Date(signal.expiresAt).getTime() - Date.now()
  const minsLeft = Math.max(0, Math.floor(msLeft / 60000))
  const secsLeft = Math.max(0, Math.floor((msLeft % 60000) / 1000))

  return (
    <div className="dir-card" data-dir={signal.direction} style={{ padding: 16 }}>
      {/* Top row */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 14 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
          <div>
            <div style={{ fontSize: 22, fontWeight: 900, color, fontFamily: 'Rajdhani', letterSpacing: 2, lineHeight: 1 }}>
              {signal.direction}
            </div>
            <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--text-primary)', fontFamily: 'Rajdhani', marginTop: 1 }}>
              {signal.pair}
            </div>
          </div>
          <div style={{ textAlign: 'center' }}>
            <div style={{ fontSize: 22, fontWeight: 700, color, fontFamily: 'JetBrains Mono', lineHeight: 1 }}>
              {signal.confidence}%
            </div>
            <div style={{ fontSize: 9, color: 'var(--text-muted)', letterSpacing: 1 }}>CONFIDENCE</div>
          </div>
          <div style={{ textAlign: 'center' }}>
            <div style={{ fontSize: 20, fontWeight: 700, color: signal.checklistScore >= 7 ? 'var(--color-buy)' : 'var(--color-wait)', fontFamily: 'JetBrains Mono', lineHeight: 1 }}>
              {signal.checklistScore}/8
            </div>
            <div style={{ fontSize: 9, color: 'var(--text-muted)', letterSpacing: 1 }}>CHECKLIST</div>
          </div>
        </div>
        <div style={{ textAlign: 'right', fontSize: 11, color: 'var(--text-dim)' }}>
          <div style={{ color: minsLeft < 5 ? 'var(--color-sell)' : 'var(--text-muted)' }}>
            Expires in {minsLeft}m {secsLeft}s
          </div>
          <div style={{ marginTop: 2 }}>{signal.timeframe} · {new Date(signal.scannedAt).toLocaleTimeString('en', { hour12: false })}</div>
        </div>
      </div>

      {/* Price levels */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
        {[
          ['LIVE PRICE', price.toFixed(dp), 'var(--color-accent-dim)'],
          ['TAKE PROFIT', tpPrice, 'var(--color-profit)'],
          ['STOP LOSS', slPrice, 'var(--color-loss)'],
        ].map(([label, val, c]) => (
          <div key={label} style={{ flex: 1, background: 'rgba(0,0,0,0.1)', borderRadius: 3, padding: '6px 10px' }}>
            <div style={{ fontSize: 9, color: 'var(--text-muted)', letterSpacing: 1, marginBottom: 2 }}>{label}</div>
            <div className="mono" style={{ fontSize: 11, color: c, fontWeight: 700 }}>{val}</div>
          </div>
        ))}
      </div>

      {/* Reasons */}
      <div style={{ marginBottom: 12 }}>
        {signal.reasons.map((r, i) => (
          <div key={i} style={{ display: 'flex', gap: 8, marginBottom: 5, fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.5 }}>
            <span style={{ color, flexShrink: 0 }}>→</span>
            <span>{r}</span>
          </div>
        ))}
      </div>

      {/* Risk note */}
      <div style={{
        fontSize: 11, color: 'var(--color-warn-text)', lineHeight: 1.5,
        padding: '7px 10px', borderRadius: 3,
        background: 'rgba(138,98,0,0.07)', border: '1px solid rgba(138,98,0,0.22)',
        marginBottom: 14,
      }}>
        <span style={{ fontWeight: 700 }}>⚠ </span>{signal.riskNote}
      </div>

      {/* Position size */}
      <div style={{
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        background: 'rgba(0,85,176,0.07)', border: '1px solid rgba(0,85,176,0.2)',
        borderRadius: 3, padding: '8px 12px', marginBottom: 14,
      }}>
        <div>
          <div style={{ fontSize: 9, color: 'var(--color-accent)', letterSpacing: 1, marginBottom: 2 }}>POSITION SIZE</div>
          <div style={{ fontSize: 22, fontWeight: 900, color: 'var(--color-accent)', fontFamily: 'JetBrains Mono', lineHeight: 1 }}>
            {lots.toFixed(2)} <span style={{ fontSize: 12, fontWeight: 400, color: 'var(--text-muted)' }}>lots</span>
          </div>
          <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 2 }}>
            ${riskAmt} risk ({strategy.riskPct}% of ${accountBalance.toLocaleString()})
          </div>
        </div>
        <div style={{ textAlign: 'right', fontSize: 11, color: 'var(--text-muted)' }}>
          <div>${(pipPerLot * lots).toFixed(2)} / pip</div>
          <div style={{ color: 'var(--color-profit)', marginTop: 3 }}>TP +${tpProfit}</div>
          <div style={{ color: 'var(--color-loss)', marginTop: 2 }}>SL −${slLoss}</div>
        </div>
      </div>

      {/* Simulated data warning */}
      {signal.simulated && (
        <div style={{
          marginBottom: 10, padding: '7px 12px', borderRadius: 3,
          background: 'rgba(255,184,0,0.08)', border: '1px solid rgba(255,184,0,0.3)',
          fontSize: 12, color: '#ffb800',
        }}>
          ⚠ <strong>SIMULATED DATA</strong> — live broker data unavailable. Trade execution blocked.
        </div>
      )}

      {/* Action buttons */}
      <div style={{ display: 'flex', gap: 10 }}>
        <button
          className={`btn ${signal.direction === 'BUY' ? 'btn-buy' : 'btn-sell'}`}
          onClick={onApprove}
          disabled={approving || signal.simulated}
          style={{ flex: 2, padding: '12px', fontSize: 14, letterSpacing: 2, opacity: signal.simulated ? 0.4 : 1 }}
        >
          {approving ? <LoadingDots color={color} /> : `✓ APPROVE & PLACE ${signal.direction}`}
        </button>
        <button
          className="btn btn-ghost"
          onClick={onReject}
          disabled={approving}
          style={{ flex: 1, padding: '12px', fontSize: 13 }}
        >
          ✕ Reject
        </button>
      </div>
    </div>
  )
}
