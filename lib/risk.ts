// lib/risk.ts
// Hard risk guards — enforced before every trade action

import type { StrategySettings } from './supabase'
import type { OpenTrade } from './brokers/interface'

export interface RiskCheck {
  allowed: boolean
  reason?: string
  severity?: 'BLOCK' | 'WARN'
}

export interface RiskGuardOptions {
  strategy: StrategySettings
  openTrades: OpenTrade[]
  accountBalance: number
  /** Realised P&L for today, or `null` when it is not known. */
  todayRealizedPL: number | null
  newsInWindow: boolean
  newsEvent?: string
}

export function runRiskGuards(options: RiskGuardOptions): RiskCheck[] {
  const checks: RiskCheck[] = []
  const { strategy, openTrades, accountBalance, todayRealizedPL, newsInWindow, newsEvent } = options

  // 1. Max open positions
  if (openTrades.length >= strategy.maxPositions) {
    checks.push({
      allowed: false,
      severity: 'BLOCK',
      reason: `Maximum open positions reached (${openTrades.length}/${strategy.maxPositions}). Close an existing position before opening a new one.`,
    })
  }

  // 2. Daily loss limit — skip entirely if balance not yet synced (0)
  //
  // Phase 4.2.1 (defect H-2): an UNKNOWN daily P&L used to pass this guard by
  // accident. `null <= -maxLossUSD` is `false` (null coerces to 0), so a day
  // whose realised losses were never recorded looked like a zero-loss day and
  // trading continued. Unknown is now a BLOCK, not a pass. The percentage
  // thresholds below are untouched.
  if (strategy.hardDailyStop && accountBalance > 0) {
    const maxLossUSD = accountBalance * (strategy.maxLoss / 100)
    // Narrow once, explicitly: `null`/`NaN`/`undefined` all mean "unknown".
    const dailyPL = typeof todayRealizedPL === 'number' && Number.isFinite(todayRealizedPL)
      ? todayRealizedPL
      : null
    if (dailyPL === null) {
      checks.push({
        allowed: false,
        severity: 'BLOCK',
        reason: 'Daily realised P&L is not known yet, so the daily loss limit cannot be evaluated. Trading is blocked until closed-trade accounting completes.',
      })
    } else if (maxLossUSD > 0 && dailyPL <= -maxLossUSD) {
      checks.push({
        allowed: false,
        severity: 'BLOCK',
        reason: `Daily loss limit hit: -$${Math.abs(dailyPL).toFixed(2)} exceeds ${strategy.maxLoss}% of balance ($${maxLossUSD.toFixed(2)}). Trading is locked for today.`,
      })
    } else if (dailyPL <= -maxLossUSD * 0.75) {
      checks.push({
        allowed: true,
        severity: 'WARN',
        reason: `Approaching daily loss limit: $${Math.abs(dailyPL).toFixed(2)} of $${maxLossUSD.toFixed(2)} used (${Math.round(Math.abs(dailyPL) / maxLossUSD * 100)}%). Trade with reduced size.`,
      })
    }
  }

  // 3. High-impact news
  if (strategy.hardNews && newsInWindow) {
    checks.push({
      allowed: false,
      severity: 'BLOCK',
      reason: `High-impact news event within 30 minutes${newsEvent ? `: ${newsEvent}` : ''}. No trades allowed per risk rules.`,
    })
  }

  // 4. Demo mode lock
  if (strategy.demoLock) {
    checks.push({
      allowed: true,
      severity: 'WARN',
      reason: 'Demo/practice mode active — orders are being placed on your connected demo account.',
    })
  }

  // 5. Session hours check
  const now = new Date()
  const currentHour = now.getUTCHours()
  if (currentHour < strategy.sessionStart || currentHour >= strategy.sessionEnd) {
    checks.push({
      allowed: true,
      severity: 'WARN',
      reason: `Outside configured trading hours (${strategy.sessionStart}:00–${strategy.sessionEnd}:00 UTC). Signal may be unreliable.`,
    })
  }

  // If no blocks found, add a pass
  const hasBlock = checks.some(c => c.severity === 'BLOCK')
  if (!hasBlock && checks.length === 0) {
    checks.push({ allowed: true })
  }

  return checks
}

export function isTradeAllowed(checks: RiskCheck[]): boolean {
  return !checks.some(c => c.severity === 'BLOCK' && !c.allowed)
}

export function getBlockReasons(checks: RiskCheck[]): string[] {
  return checks.filter(c => c.severity === 'BLOCK' && !c.allowed).map(c => c.reason!)
}

export function getWarnings(checks: RiskCheck[]): string[] {
  return checks.filter(c => c.severity === 'WARN').map(c => c.reason!)
}
