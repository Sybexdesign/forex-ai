// lib/trade-manager.ts
// Post-entry trade management layer — called on every MT5 EA sync.
// Applies break-even, partial-lock, trailing stop, time exit, and profit-decay
// exit rules to open positions.
//
// CONTRACT: This module NEVER touches signal generation, AI direction, entry
// logic, initial SL/TP placement, or any indicator.  It only decides whether
// to move a live SL or close a live trade that was already opened.
//
// EA REQUIREMENTS — to support modify_sl commands the EA must handle:
//   pending order type "modify_sl" fields: { symbol, ticket, newSl }
//   e.g.  if(order.type == "modify_sl") { PositionModify(order.ticket, order.newSl, 0); }
// Close commands (type "close") are already supported by the existing EA.

import { getPipValue, getPipValuePerLot } from './brokers/interface'

// ─── Types ────────────────────────────────────────────────────────────────────

export interface EAPosition {
  ticket:    number | string
  symbol:    string          // MT5 symbol, e.g. "XAUUSD"
  type:      string          // "BUY" | "SELL"
  lots:      number
  openPrice: number
  sl:        number
  tp:        number
  profit:    number          // unrealised P&L in account currency
}

interface EACandle { t: number; o: number; h: number; l: number; c: number; v: number }

export interface TradeState {
  originalEntry: number
  originalSl:    number
  openedAt:      string   // ISO — when manager first saw this ticket
  peakProfit:    number   // highest unrealised P&L seen (account currency)
  beApplied:     boolean
  partialLocked: boolean
}

export interface ManagementCommand {
  id:        string
  type:      'close' | 'modify_sl'
  symbol:    string
  ticket?:   number | string
  newSl?:    number
  createdAt: string
  expiresAt: number        // unix seconds
}

export interface ManageResult {
  tradeState: Record<string, TradeState>
  commands:   ManagementCommand[]
  log:        string[]
  /**
   * Risk events emitted this tick — hard-cap or emergency-1.5R closes.
   * mt5-sync routes these to Telegram. Empty array = nothing breaching.
   */
  riskEvents: Array<{
    reason:  'hard-cap' | 'emergency-1.5R'
    pair:    string
    ticket:  number | string
    pl:      number
    cap?:    number
  }>
}

/**
 * Optional risk context. When provided, manageTrades applies a hard USD floor:
 * close any position whose unrealised P/L drops below -(balance × riskPct/100 × 1.5).
 * This is a belt-and-braces second layer on top of the -1.5R MAX_LOSS_R check —
 * catches cases where MT5 SL gap-throughs make the R-based check fire late.
 */
export interface RiskContext {
  accountBalance: number   // live balance from broker (USD)
  riskPct:        number   // user's risk per trade (%) e.g. 0.5
}

// ─── Config ───────────────────────────────────────────────────────────────────

const MAX_HOLD_MS     = 20 * 60_000  // 20-minute scalp window
const MIN_PROFIT_R    = 0.2          // must reach 0.2R within MAX_HOLD_MS
const BE_TRIGGER_R    = 1.0          // move SL to break-even when profit hits 1R (was 0.5R — was causing 73% of wins to exit at $0–3 via premature BE)
const PARTIAL_LOCK_R  = 1.5          // lock SL at +0.75R level when profit hits 1.5R (was 1.0R)
const TRAIL_ATR_MULT  = 1.0          // SL = price ± ATR * 1.0 (wider trail gives room to run)
const DECAY_THRESHOLD = 0.4          // close if profit falls below 40% of peak (was 50%)
const MAX_LOSS_R      = -1.5         // emergency close if loss exceeds 1.5× initial risk
const ATR_PERIOD      = 14
const CMD_TTL_S       = 120          // pending command expires after 2 minutes

// ─── Helpers ──────────────────────────────────────────────────────────────────

function calcATR(candles: EACandle[]): number {
  if (candles.length < 2) return 0
  const slice = candles.slice(-(ATR_PERIOD + 1))
  let sum = 0, count = 0
  for (let i = 1; i < slice.length; i++) {
    const c = slice[i], prev = slice[i - 1]
    sum += Math.max(c.h - c.l, Math.abs(c.h - prev.c), Math.abs(c.l - prev.c))
    count++
  }
  return count > 0 ? sum / count : 0
}

function slDecimals(sym: string): number {
  if (sym.startsWith('XAU')) return 2
  if (sym.startsWith('XAG')) return 3
  if (sym.includes('JPY'))   return 3
  return 5
}

function mt5Pair(sym: string): string {
  return sym.length === 6 ? `${sym.slice(0, 3)}/${sym.slice(3)}` : sym
}

// ─── Core ─────────────────────────────────────────────────────────────────────

export function manageTrades(
  openPositions: EAPosition[],
  latestPrices:  Record<string, { bid: number; ask: number }>,
  candleCache:   Record<string, { candles: EACandle[]; updatedAt: string }>,
  prevState:     Record<string, TradeState>,
  riskCtx?:      RiskContext,
): ManageResult {
  const now      = Date.now()
  const nowSec   = Math.floor(now / 1000)
  const commands: ManagementCommand[] = []
  const log:      string[] = []
  const riskEvents: ManageResult['riskEvents'] = []
  const nextState: Record<string, TradeState> = {}
  const openTickets = new Set(openPositions.map(p => String(p.ticket)))

  // Hard USD cap = balance × riskPct/100 × 1.5 (i.e. 1.5× the user's per-trade risk).
  // Tightened from 2× — historical worst loss of $82.20 would have been caught at the
  // 1.5× threshold (~$71 on a $9.5k account at 0.5%). 2× would have let it through.
  // Computed once per tick; falsy/zero when riskCtx is not provided, which disables the check.
  const hardCapUsd = (riskCtx && riskCtx.accountBalance > 0 && riskCtx.riskPct > 0)
    ? riskCtx.accountBalance * (riskCtx.riskPct / 100) * 1.5
    : 0

  for (const pos of openPositions) {
    const key   = String(pos.ticket)
    const sym   = pos.symbol
    const pair  = mt5Pair(sym)
    const dir   = pos.type === 'BUY' ? 'BUY' : 'SELL'
    const pip   = getPipValue(pair)
    const pvpl  = getPipValuePerLot(pair)
    const dp    = slDecimals(sym)

    // Initialise state on first tick for this ticket
    const state: TradeState = prevState[key]
      ? { ...prevState[key] }
      : {
          originalEntry: pos.openPrice,
          originalSl:    pos.sl,
          openedAt:      new Date(now).toISOString(),
          peakProfit:    0,
          beApplied:     false,
          partialLocked: false,
        }

    const { originalEntry, originalSl } = state
    const initialRiskPips = Math.abs(originalEntry - originalSl) / pip

    // Skip positions with degenerate or zero SL (can't calculate R)
    if (initialRiskPips < 0.1) {
      nextState[key] = state
      continue
    }

    const initialRiskUsd = initialRiskPips * pvpl * pos.lots

    // Update peak profit
    state.peakProfit = Math.max(state.peakProfit, pos.profit)
    const { peakProfit } = state
    const currentR = pos.profit / initialRiskUsd

    // ── 0a. Hard USD cap (Fix 8) ─────────────────────────────────────────────
    // Belt-and-braces above MAX_LOSS_R. Catches gap-through cases where the
    // R-based check fires late because the MT5 SL was already breached at a
    // worse price than expected. Cap = balance × riskPct/100 × 2 (2× target risk).
    // Only enabled when riskCtx is provided by the caller.
    if (hardCapUsd > 0 && pos.profit < -hardCapUsd) {
      log.push(`[tm] ${sym}#${key} HARD-CAP-CLOSE: pl=$${pos.profit.toFixed(2)} < -$${hardCapUsd.toFixed(2)} (1.5× user risk)`)
      commands.push({
        id:        crypto.randomUUID(),
        type:      'close',
        symbol:    sym,
        ticket:    pos.ticket,
        createdAt: new Date(now).toISOString(),
        expiresAt: nowSec + CMD_TTL_S,
      })
      riskEvents.push({ reason: 'hard-cap', pair, ticket: pos.ticket, pl: pos.profit, cap: hardCapUsd })
      nextState[key] = state
      continue
    }

    // ── 0b. Hard catastrophic-loss cutoff (R-based) ──────────────────────────
    // Emergency close when MT5 SL fails to execute (bad tick, broker lag, XAG gap).
    // Fires before all rule-1-5 logic so we exit immediately regardless of state.
    if (currentR < MAX_LOSS_R) {
      log.push(`[tm] ${sym}#${key} EMERGENCY-CLOSE: R=${currentR.toFixed(2)} < ${MAX_LOSS_R} — runaway loss`)
      commands.push({
        id:        crypto.randomUUID(),
        type:      'close',
        symbol:    sym,
        ticket:    pos.ticket,
        createdAt: new Date(now).toISOString(),
        expiresAt: nowSec + CMD_TTL_S,
      })
      riskEvents.push({ reason: 'emergency-1.5R', pair, ticket: pos.ticket, pl: pos.profit })
      nextState[key] = state
      continue
    }

    // ATR from M5 candles for the trailing stop
    const m5 = candleCache[`${sym}_M5`]
    const atr = m5 ? calcATR(m5.candles) : 0

    // Best current bid/ask for trailing reference
    const px   = latestPrices[sym]
    const midPx = px ? (dir === 'BUY' ? px.bid : px.ask) : 0

    let newSl: number | null = null

    // ── 1. Break-even at +1R ────────────────────────────────────────────────
    if (!state.beApplied && currentR >= BE_TRIGGER_R) {
      const beImproves = dir === 'BUY' ? originalEntry > pos.sl : originalEntry < pos.sl
      if (beImproves) {
        newSl           = originalEntry
        state.beApplied = true
        log.push(`[tm] ${sym}#${key} BE: R=${currentR.toFixed(2)} → SL to entry ${originalEntry}`)
      }
    }

    // ── 2. Partial profit lock at +1.5R (SL advances to +0.75R level) ───────
    if (!state.partialLocked && currentR >= PARTIAL_LOCK_R) {
      state.partialLocked = true
      const lockSl = dir === 'BUY'
        ? originalEntry + 0.5 * initialRiskPips * pip
        : originalEntry - 0.5 * initialRiskPips * pip
      const lockImproves = dir === 'BUY'
        ? lockSl > (newSl ?? pos.sl)
        : lockSl < (newSl ?? pos.sl)
      if (lockImproves) {
        newSl = lockSl
        log.push(`[tm] ${sym}#${key} partial-lock: R=${currentR.toFixed(2)} → SL to +0.5R=${lockSl.toFixed(dp)}`)
      }
    }

    // ── 3. ATR trailing stop (only advances in profit direction) ─────────────
    if (atr > 0 && midPx > 0) {
      const trailSl = dir === 'BUY'
        ? midPx - atr * TRAIL_ATR_MULT
        : midPx + atr * TRAIL_ATR_MULT
      // Must be: (a) better than current live SL, (b) better than any SL from rules 1/2,
      // (c) strictly in profit territory (beyond original entry)
      const inProfit   = dir === 'BUY' ? trailSl > originalEntry : trailSl < originalEntry
      const betterLive = dir === 'BUY' ? trailSl > pos.sl : trailSl < pos.sl
      const betterPrev = dir === 'BUY' ? trailSl > (newSl ?? pos.sl) : trailSl < (newSl ?? pos.sl)
      if (inProfit && betterLive && betterPrev) {
        newSl = trailSl
        log.push(`[tm] ${sym}#${key} trail: price=${midPx} ATR=${atr.toFixed(dp)} → SL=${trailSl.toFixed(dp)}`)
      }
    }

    // ── Queue single SL modification if any rule improved the stop ───────────
    if (newSl !== null) {
      commands.push({
        id:        crypto.randomUUID(),
        type:      'modify_sl',
        symbol:    sym,
        ticket:    pos.ticket,
        newSl:     +newSl.toFixed(dp),
        createdAt: new Date(now).toISOString(),
        expiresAt: nowSec + CMD_TTL_S,
      })
    }

    // ── 4. Time-based exit ───────────────────────────────────────────────────
    const durationMs = now - new Date(state.openedAt).getTime()
    if (durationMs > MAX_HOLD_MS && currentR < MIN_PROFIT_R) {
      log.push(`[tm] ${sym}#${key} TIME-EXIT: ${Math.round(durationMs / 60000)}m elapsed, R=${currentR.toFixed(2)} < ${MIN_PROFIT_R}`)
      commands.push({
        id:        crypto.randomUUID(),
        type:      'close',
        symbol:    sym,
        ticket:    pos.ticket,
        createdAt: new Date(now).toISOString(),
        expiresAt: nowSec + CMD_TTL_S,
      })
      nextState[key] = state
      continue
    }

    // ── 5. Profit decay exit ─────────────────────────────────────────────────
    // Floor = 1.5 pips of profit (capped at $0.25) to survive execution slippage.
    // A queued close takes ~2s to fill in MT5; without this floor a positive-profit
    // trigger can fill negative after price moves during the execution delay.
    const decayCloseFloor = Math.min(1.5 * pvpl * pos.lots, 0.25)
    if (peakProfit > 0 && pos.profit < peakProfit * DECAY_THRESHOLD && pos.profit >= decayCloseFloor) {
      log.push(`[tm] ${sym}#${key} DECAY-EXIT: profit=$${pos.profit.toFixed(2)} < 50% of peak $${peakProfit.toFixed(2)} (floor=$${decayCloseFloor.toFixed(2)})`)
      commands.push({
        id:        crypto.randomUUID(),
        type:      'close',
        symbol:    sym,
        ticket:    pos.ticket,
        createdAt: new Date(now).toISOString(),
        expiresAt: nowSec + CMD_TTL_S,
      })
      nextState[key] = state
      continue
    }

    nextState[key] = state
  }

  // Log positions that disappeared (closed naturally at broker)
  for (const key of Object.keys(prevState)) {
    if (!openTickets.has(key)) {
      log.push(`[tm] ticket ${key} gone from EA — purging state`)
    }
  }

  return { tradeState: nextState, commands, log, riskEvents }
}
