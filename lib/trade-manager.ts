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
  originalEntry:      number
  originalSl:         number
  openedAt:           string   // ISO — when manager first saw this ticket
  peakProfit:         number   // highest unrealised P&L seen (account currency)
  beApplied:          boolean
  partialLocked:      boolean
  // True once we've fired the "profit reversal" Telegram alert for this ticket
  // (gate to one alert per trade — see REVERSAL_ALERT_USD / REVERSAL_ALERT_FRAC).
  reversalAlertSent?: boolean
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
   * Risk events emitted this tick — hard-cap, emergency-1.5R closes, or
   * profit-reversal info alerts. mt5-sync routes these to Telegram.
   */
  riskEvents: Array<{
    reason:  'hard-cap' | 'emergency-1.5R' | 'profit-reversal'
    pair:    string
    ticket:  number | string
    pl:      number       // current unrealised P/L when the event fired
    cap?:    number       // for hard-cap: the threshold breached
    peak?:   number       // for profit-reversal: the peak the trade reached
  }>
}

/**
 * Optional risk context. When provided, manageTrades applies a hard USD floor:
 * close any position whose unrealised P/L drops below
 *   -(balance × riskPct/100 × hardCapMultiplier).
 * hardCapMultiplier is now user-configurable via strategies.settings; falls back
 * to 1.25 when not supplied (catches cases where MT5 SL gap-throughs make the
 * -1.5R MAX_LOSS_R R-based check fire late).
 */
export interface RiskContext {
  accountBalance:     number    // live balance from broker (USD)
  riskPct:            number    // user's risk per trade (%) e.g. 0.5
  hardCapMultiplier?: number    // multiplier on 1R for the hard USD cap (default 1.25)
}

// ─── Config ───────────────────────────────────────────────────────────────────

const MAX_HOLD_MS     = 20 * 60_000  // 20-minute scalp window
const MIN_PROFIT_R    = 0.2          // must reach 0.2R within MAX_HOLD_MS
// BE_TRIGGER_R lowered from 1.0 → 0.5 after a +$20 → -$1.65 reversal proved that
// 1R BE was leaving too much profit at risk. Trade-off is more $0 exits but
// avoids "round-trip" losses where a clear winner fully reverses.
const BE_TRIGGER_R    = 0.5
const PARTIAL_LOCK_R  = 1.5          // lock SL at +0.5R level when profit hits 1.5R
// DECAY_THRESHOLD raised from 0.4 → 0.5 so a trade peaking at +$20 closes at +$10
// (50% of peak) instead of being allowed to fall to +$8 before triggering.
const DECAY_THRESHOLD = 0.5
// DECAY_MIN_PEAK_USD added 2026-06-08 after a +$14 → -$2.13 fill: decay-exit fired
// at the 50% threshold ($7) but executed below zero due to ~2s queue lag. Only
// activate decay when the trade has built a meaningful cushion (peak ≥ $20) so
// the $10-decay-target is robust against typical XAU execution slippage of $1-3.
const DECAY_MIN_PEAK_USD = 20
const TRAIL_ATR_MULT_LOOSE = 1.0     // default trail distance when profit small
const TRAIL_ATR_MULT_TIGHT = 0.5     // tighter trail when profit > PROFIT_TIGHTEN_USD
const PROFIT_TIGHTEN_USD   = 15      // $-threshold to switch to tight trail
// TRAIL_MIN_PROFIT_USD added 2026-06-16. Previously the only gate on the ATR
// trail was `trailSl > entry`, so trail tightened SL into +5-7 pips of profit
// before the EA's fixed-USD target ($37.50 trigger at 50×75%) could fire. A
// +$9.63/100s exit on 2026-06-16 12:02 confirmed the bypass. Trail now waits
// for the trade to clear $15 unrealised so the fixed-target ladder has a
// chance to bind on shallow wins. Mirror EA gate: input TrailMinUsd in
// SybexForexAI_EA_v9.3.mq5 — both layers must agree or whichever fires first
// wins the per-tick SL race.
const TRAIL_MIN_PROFIT_USD = 15
// PEAK_BE_THRESHOLD_USD added 2026-06-16. The $15 trail floor (above) closed a
// gap where shallow wins got squeezed by the trail, but opened a new one: a
// trade can peak below $15 (e.g. +$14.02 / +$9.43 on 2026-06-16 13:45) and
// fully round-trip to -$55 with nothing engaging — BE only fires at 0.5R, trail
// is gated at $15, decay-exit gated at peak ≥ $20. Peak-BE catches the mid-band:
// if peak reached this much profit then the trade returned to break-even or
// below, close at the current price (≈ entry) to lock zero rather than ride
// the full reversal to SL.
const PEAK_BE_THRESHOLD_USD = 8
const REVERSAL_ALERT_USD   = 10      // peak must exceed this before reversal alert can fire
const REVERSAL_ALERT_FRAC  = 0.30    // alert when profit falls below 30% of peak (i.e. pulled back >70%? — see comment)
// REVERSAL_ALERT_FRAC interpretation: alert when current profit drops below
// (1 - REVERSAL_ALERT_FRAC) × peak. With 0.30 that means: alert when profit
// has pulled back 30% from the peak (e.g. peak $20 → profit $14 = -30%).
// One alert per trade — gated by tradeState.reversalAlertSent.
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

  // Hard USD cap = balance × riskPct/100 × hardCapMultiplier.
  // Multiplier is now user-configurable via strategies.settings.hardCapMultiplier
  // (default 1.25). Tightened from 1.5× after a -$71.48 gap-through that hit
  // 1.46R nearly maxed the previous cap. Allowing per-user tuning so prop-firm
  // accounts with tighter risk policy can set, say, 1.10 without a code change.
  // Computed once per tick; falsy/zero when riskCtx is not provided, which disables the check.
  const hardCapMult = (riskCtx && typeof riskCtx.hardCapMultiplier === 'number' && riskCtx.hardCapMultiplier > 0)
    ? riskCtx.hardCapMultiplier
    : 1.25
  const hardCapUsd = (riskCtx && riskCtx.accountBalance > 0 && riskCtx.riskPct > 0)
    ? riskCtx.accountBalance * (riskCtx.riskPct / 100) * hardCapMult
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

    // Profit-reversal alert (one-shot per ticket). Fires when a trade reached
    // a meaningful peak ($10+) AND has pulled back >30% from that peak but
    // hasn't yet hit the decay-exit threshold. Operator sees the warning
    // before the close fires.
    if (!state.reversalAlertSent
        && peakProfit > REVERSAL_ALERT_USD
        && pos.profit < peakProfit * (1 - REVERSAL_ALERT_FRAC)) {
      state.reversalAlertSent = true
      riskEvents.push({ reason: 'profit-reversal', pair, ticket: pos.ticket, pl: pos.profit, peak: peakProfit })
      log.push(`[tm] ${sym}#${key} PROFIT-REVERSAL ALERT: peak=$${peakProfit.toFixed(2)} now=$${pos.profit.toFixed(2)} (${Math.round((1 - pos.profit / peakProfit) * 100)}% pullback)`)
    }

    // ── 0a. Hard USD cap (Fix 8) ─────────────────────────────────────────────
    // Belt-and-braces above MAX_LOSS_R. Catches gap-through cases where the
    // R-based check fires late because the MT5 SL was already breached at a
    // worse price than expected. Cap = balance × riskPct/100 × 2 (2× target risk).
    // Only enabled when riskCtx is provided by the caller.
    if (hardCapUsd > 0 && pos.profit < -hardCapUsd) {
      log.push(`[tm] ${sym}#${key} HARD-CAP-CLOSE: pl=$${pos.profit.toFixed(2)} < -$${hardCapUsd.toFixed(2)} (${hardCapMult}× user risk)`)
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
    // Multiplier switches from 1.0×ATR (loose, room to run) to 0.5×ATR (tight,
    // protect profit) once the trade exceeds PROFIT_TIGHTEN_USD = $15 unrealised.
    const trailMult = pos.profit > PROFIT_TIGHTEN_USD ? TRAIL_ATR_MULT_TIGHT : TRAIL_ATR_MULT_LOOSE
    if (atr > 0 && midPx > 0 && pos.profit > TRAIL_MIN_PROFIT_USD) {
      const trailSl = dir === 'BUY'
        ? midPx - atr * trailMult
        : midPx + atr * trailMult
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

    // ── 4. Peak-BE close (mid-band protection) ───────────────────────────────
    // Catches trades that reached a meaningful peak then reversed back to or
    // below entry. BE/trail/decay-exit all have higher activation thresholds,
    // leaving an unprotected band where peak $8-$19 + full round-trip ate the
    // entire 1R loss (real fills 2026-06-16 13:45: peaks +$14 and +$9 closed
    // at -$55 and -$60). Fires only when the trade is now at or below entry
    // so it never closes a still-winning position.
    if (peakProfit >= PEAK_BE_THRESHOLD_USD && pos.profit <= 0) {
      log.push(`[tm] ${sym}#${key} PEAK-BE-CLOSE: peak=$${peakProfit.toFixed(2)} → profit=$${pos.profit.toFixed(2)} (≤0) — close at current to lock BE`)
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

    // ── 5. Time-based exit ───────────────────────────────────────────────────
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

    // ── 6. Profit decay exit ─────────────────────────────────────────────────
    // Activation gate: peak must reach DECAY_MIN_PEAK_USD ($20). Below that the
    // 50% threshold is too small a cushion — a +$14 → +$7 trigger has historically
    // filled at -$2 after the ~2s queue lag (real fill 2026-06-08).
    // Floor = 1.5 pips of profit (capped at $0.25) to survive execution slippage.
    const decayCloseFloor = Math.min(1.5 * pvpl * pos.lots, 0.25)
    if (peakProfit >= DECAY_MIN_PEAK_USD && pos.profit < peakProfit * DECAY_THRESHOLD && pos.profit >= decayCloseFloor) {
      log.push(`[tm] ${sym}#${key} DECAY-EXIT: profit=$${pos.profit.toFixed(2)} < 50% of peak $${peakProfit.toFixed(2)} (peak≥$${DECAY_MIN_PEAK_USD}, floor=$${decayCloseFloor.toFixed(2)})`)
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
