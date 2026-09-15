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
import { profitProtection, profitFloorToSl, shadowDecision, pickMostProtectiveSl } from './profit-protection.mjs'
import { composeProtection } from './protection-candidates.mjs'

/**
 * Does this observation represent a MATERIAL protection gap worth surfacing?
 *
 * PURE and telemetry-only. It classifies; it never acts. Called after the full
 * observation is built, it decides whether to additionally emit the concise
 * `profit_protection_gap_detected` event so abnormal degradation is easy to spot
 * without reading the full event stream.
 *
 * "Materially more" is BOTH an absolute and a proportional bar so it is neither
 * noise on a small trade nor trivially satisfied on a large one. Thresholds are
 * parameters, not constants, so they stay configurable.
 */
export const GAP_MIN_DELTA_R = 0.5          // shadow must protect >= 0.5R more
export const GAP_MIN_PROFIT_R = 1.0         // only for meaningfully profitable trades

export function detectProtectionGap(obs: Record<string, any> | null | undefined, cfg: { minDeltaR?: number; minProfitR?: number } = {}) {
  if (!obs) return null
  const minDeltaR  = Number.isFinite(cfg.minDeltaR)  ? Number(cfg.minDeltaR)  : GAP_MIN_DELTA_R
  const minProfitR = Number.isFinite(cfg.minProfitR) ? Number(cfg.minProfitR) : GAP_MIN_PROFIT_R

  const currentR       = obs.currentR
  const peakR          = obs.peakR
  const liveFinalR     = obs.liveFinalR
  const shadowFinalR   = obs.shadowFinalR
  const delta          = obs.protectionDeltaR
  // `typeof NaN === 'number'` is TRUE, so every numeric guard must use
  // Number.isFinite — otherwise a NaN reaches the comparison and the event fires
  // on garbage. (Caught by the unit tests.)
  const atrUnavailable = obs.liveAtrReason !== 'live-atr-active'

  if (!(Number.isFinite(currentR) && currentR >= minProfitR)) return null
  if (!atrUnavailable) return null
  if (!Number.isFinite(shadowFinalR)) return null
  if (!(Number.isFinite(delta) && delta >= minDeltaR)) return null

  return {
    event: 'profit_protection_gap_detected',
    timestamp: obs.timestamp,
    tradeId: obs.tradeId,
    symbol: obs.symbolRaw,
    symbolNormalized: obs.symbolNormalized,
    peakR,
    currentR,
    liveFinalR,
    shadowFinalR,
    protectionDeltaR: delta,
    liveAtrReason: obs.liveAtrReason,
    atrRefinedReason: obs.atrRefinedReason,
    protectionHealth: obs.protectionHealth,
    keyDiagnosis: obs.keyDiagnosis,
    priceKeyFound: obs.priceKeyFound,
    candleKeyFound: obs.candleKeyFound,
    candleCount: obs.candleCount,
    processUptimeSec: obs.processUptimeSec,
    candleAgeSec: obs.candleAgeSec,
    // Explicitly observational. Nothing in the pipeline acts on this.
    severity: 'COUNTERFACTUAL_ONLY',
  }
}

/** A candle older than this is considered stale for a 10s-sweep scalper. */
export const CANDLE_STALE_SEC = 600
/** Within this many seconds of process start, a thin cache is "warming", not broken. */
export const ATR_WARMUP_SEC = 300

/**
 * Refine WHY ATR is unavailable, so `missing-candles` never collapses four very
 * different operational causes into one string.
 *
 * PURE. OBSERVATION ONLY — this never fabricates an ATR and never influences
 * execution. `processUptimeSec` and `candleAgeSec` are inputs so the function
 * stays deterministic and testable.
 */
export function refineAtrReason(o: {
  liveAtrReason?: string
  candleKeyFound?: boolean
  priceKeyFound?: boolean
  candleCount?: number
  requiredCandles?: number
  candleAgeSec?: number | null
  keyDiagnosis?: string
  processUptimeSec?: number | null
}) {
  // calcATR() needs ATR_PERIOD + 1 candles for a FULL window — it returns a
  // degenerate value from as few as 2, so "2" would be a technically-true but
  // useless bar. Stating ATR_PERIOD + 1 keeps the implementation, the
  // diagnostics, the tests and the operator checklist in agreement.
  const required = Number.isFinite(o.requiredCandles as number) ? Number(o.requiredCandles) : ATR_PERIOD + 1
  const count    = Number.isFinite(o.candleCount as number) ? Number(o.candleCount) : 0

  if (o.liveAtrReason === 'live-atr-active' || o.liveAtrReason === 'atr-available') return 'atr-available'
  if (o.liveAtrReason === 'live-atr-below-profit-gate') return 'atr-available-below-progress-gate'

  // A key present under an ALTERNATE representation is the strongest signal, and
  // must be checked first — otherwise "no data at all" gets mislabelled as a
  // mismatch (which the restart tests caught).
  if (o.keyDiagnosis === 'key-mismatch-suspected') {
    return !o.priceKeyFound ? 'atr-price-key-mismatch' : 'atr-symbol-key-mismatch'
  }

  const uptime = Number(o.processUptimeSec)
  const warming = Number.isFinite(uptime) && uptime < ATR_WARMUP_SEC

  if (!o.candleKeyFound) {
    // No alternate key exists anywhere, so this is genuinely absent data —
    // either a fresh process that has not seen candles yet, or a dead feed.
    return warming ? 'atr-cache-warming' : 'atr-cache-missing-no-alternate'
  }
  if (!o.priceKeyFound) {
    return warming ? 'atr-cache-warming' : 'atr-price-key-mismatch'
  }

  if (count < required) return warming ? 'atr-cache-warming' : 'atr-insufficient-candles'
  const age = Number(o.candleAgeSec)
  if (Number.isFinite(age) && age > CANDLE_STALE_SEC) return 'atr-stale-candles'
  return 'atr-unavailable-other'
}

/**
 * Aggregate protection health for one observation. PURE, observation-only, so
 * real trades can be grouped later without reading the whole event stream.
 */
export function classifyProtectionHealth(obs: Record<string, any> | null | undefined) {
  if (!obs) return 'NO_OBSERVATION'
  const atrHealthy = obs.liveAtrReason === 'live-atr-active'
  const existingR  = Number(obs.existingR ?? obs.liveFinalR)
  const delta      = Number(obs.protectionDeltaR)
  const hasGap     = Number.isFinite(delta) && delta >= GAP_MIN_DELTA_R
                       && Number.isFinite(Number(obs.currentR)) && Number(obs.currentR) >= GAP_MIN_PROFIT_R

  if (hasGap && !atrHealthy) return 'PROTECTION_GAP'
  if (atrHealthy) return 'HEALTHY_ATR'
  if (Number.isFinite(existingR) && existingR > 0.5) return 'HEALTHY_EXISTING_SL'
  if (obs.atrRefinedReason === 'atr-cache-warming') return 'ATR_WARMING'
  if (obs.atrRefinedReason === 'atr-symbol-key-mismatch' || obs.atrRefinedReason === 'atr-price-key-mismatch') {
    return 'ATR_KEY_MISMATCH_SUSPECTED'
  }
  if (obs.atrRefinedReason === 'atr-stale-candles') return 'ATR_STALE'
  if (obs.atrRefinedReason === 'atr-insufficient-candles') return 'ATR_WARMING'
  return 'ATR_UNAVAILABLE_OTHER'
}

/**
 * Build the structured shadow event. ONE canonical object shape, so it can later
 * be written to profit_protection_telemetry without redesign. Contains no
 * credentials, tokens or account-identifying data beyond the ticket.
 */
function buildShadowObservation(d: any): Record<string, unknown> {
  const balanced = (a: number | null, b: number | null) =>
    (a != null && b != null) ? Math.round((a - b) * 10000) / 10000 : null
  // Refined ATR cause + aggregate health, computed AFTER the core fields exist so
  // the classifier sees them. Both are observation-only.
  const atrRefinedReason = refineAtrReason({
    liveAtrReason: d.liveAtrReason,
    candleKeyFound: d.candleKeyFound,
    priceKeyFound: d.priceKeyFound,
    candleCount: d.candleCount,
    requiredCandles: ATR_PERIOD + 1,
    candleAgeSec: d.candleAgeSec,
    keyDiagnosis: d.keyDiagnosis,
    processUptimeSec: d.processUptimeSec,
  })
  const core: Record<string, any> = {
    event: 'profit_protection_shadow_decision',
    timestamp: new Date(d.now).toISOString(),
    tradeId: d.key,
    // ── symbol / lookup keys (the mismatch hypothesis, made observable) ──
    symbolRaw: d.sym,
    symbolNormalized: d.pair,
    priceLookupKey: d.sym,
    priceKeyFound: d.priceKeyFound,
    candleLookupKey: d.candleKey,
    candleKeyFound: d.candleKeyFound,
    candleCount: d.candleCount,
    // Alternate-representation diagnosis (observation only).
    altCandleKeysFound: d.altKeys,
    altPriceKeysFound: d.altPriceKeys,
    keyDiagnosis: d.keyDiagnosis,
    // ── startup / staleness evidence (cache warming vs genuinely broken) ──
    processUptimeSec: d.processUptimeSec,
    candleAgeSec: d.candleAgeSec,
    requiredCandles: ATR_PERIOD + 1,
    // ── market / position ──
    entry: d.entry,
    currentPrice: d.midPx > 0 ? d.midPx : null,
    currentProfit: d.pos.profit,
    // ── planned risk provenance ──
    plannedRisk: d.riskValid ? d.initialRiskUsd : null,
    plannedRiskSource: d.plannedRiskSource,
    currentR: d.riskValid ? d.currentR : null,
    // ── peak provenance ──
    previousPeakProfit: d.previousPeakProfit,
    peakProfit: d.peakProfit,
    establishedNewPeak: d.establishedNewPeak,
    peakR: d.riskValid ? d.peakProfit / d.initialRiskUsd : null,
    // ── LIVE chain (unchanged behaviour, now explained) ──
    liveSl: d.pos.sl,
    liveAtr: d.atr > 0 ? d.atr : null,
    liveAtrReason: d.liveAtrReason,
    liveAtrCandidate: d.liveAtrCandidate,
    liveFinalCandidate: d.newSl ?? d.pos.sl,
    liveModify: d.newSl !== null,
    liveFinalR: d.liveFinalR,
    // ── SHADOW (advisory only) ──
    shadowAtrReason: d.shadow.diagnostics.atrReason,
    shadowAtrCandidate: d.shadow.diagnostics.atrCandidateR,
    shadowMfeCandidate: d.shadow.diagnostics.mfeCandidateR,
    shadowMfeReason: d.shadow.diagnostics.mfeReason ?? null,
    shadowSelectedRule: d.shadow.selectedRule,
    shadowFinalCandidate: d.shadow.finalSl,
    shadowWouldModify: d.shadow.wouldModify,
    shadowFinalR: d.shadowFinalR,
    protectionDeltaR: balanced(d.shadowFinalR, d.liveFinalR),
    retentionTargetPct: d.shadow.diagnostics.peakR > 0 && d.shadowFinalR != null
      ? Math.round((d.shadowFinalR / d.shadow.diagnostics.peakR) * 1000) / 1000
      : null,
    mode: d.shadowProtection ? 'shadow' : 'live',
  }
  core.atrRefinedReason = atrRefinedReason
  core.protectionHealth = classifyProtectionHealth(core)
  return core
}

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
  // Peak-giveback protection (lib/profit-protection.mjs) — persisted so a
  // restart can never reset protection to zero.
  protectionStage?:   string    // DEVELOP | EARLY_GIVEBACK_BE | PROTECT | LOCK | STRONG | EXCEPTIONAL
  retentionFloorUsd?: number    // monotonic dollar floor = % of peak already locked via SL
  telemetryAt?:       number    // last cycle a periodic telemetry line was emitted (ms)
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
  /**
   * SHADOW-ONLY adaptive-protection observations (one per managed profitable
   * position per cycle). Purely advisory: nothing in this array can influence
   * `commands`. Built inside a try/catch so a shadow failure can never suppress
   * existing live protection. Structured so it can later be written to the
   * profit_protection_telemetry table without redesign.
   */
  shadowObservations?: Record<string, unknown>[]
  tradeState: Record<string, TradeState>
  commands:   ManagementCommand[]
  log:        string[]
  /**
   * Profit-protection / giveback telemetry emitted for open profitable trades
   * (on every decision and periodically ~60s otherwise). Consumed by mt5-sync
   * for logging; the fields let an operator see exactly why a trade is still
   * open and what protection is active.
   */
  telemetry:  Array<{
    ticket:        number | string
    tradeId?:      string | null      // DB id — linked in mt5-sync when matched (null here)
    pair:          string
    direction:     'BUY' | 'SELL'
    lots:          number
    openPrice:     number
    initialSl:     number
    currentPrice:  number | null
    currentProfit: number
    peakProfit:    number
    plannedRiskUsd: number            // exact runtime 1R (entry→initialSL × pvpl × lots)
    currentR:      number
    peakR:         number
    retainedPct:   number | null
    givebackPct:   number | null
    protectionStage: string
    targetFloorUsd: number | null
    proposedProtectionSl: number | null
    currentLiveSl: number
    existingManagerAction: string | null
    shadowDecision: string            // NONE | WOULD_MOVE_SL | WOULD_MOVE_SL_TO_BE |
                                      // WOULD_CLOSE | MOVED_SL | BLOCKED_BY_MIN_STOP |
                                      // EXISTING_RULE_MORE_PROTECTIVE | EXISTING_*_CLOSE | SHADOW_ONLY
    action:        string | null
    actionAt:      string | null
    shadow?:       boolean
    floorUsd?:     number
    floorPct?:     number
  }>
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
  // PROFIT_PROTECTION_SHADOW_MODE — when true the NEW peak-giveback ratchet only
  // computes/logs (telemetry) and must never modify SL or close; existing
  // BE/trail/decay behaviour continues normally.
  shadowProtection?:  boolean
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

/**
 * Narrow dependency seam for the SHADOW OBSERVER ONLY.
 *
 * WHY: the observer reads exactly the same inputs the live rules use, so a test
 * cannot vary shadow behaviour without also varying live behaviour — which makes
 * a command-invariance assertion impossible to construct honestly.
 *
 * This seam injects ONLY the pure composition function. The injected value can
 * influence nothing but observation data: it cannot reach `newSl`, `commands`,
 * trade state or close decisions, because the observer block is the sole caller
 * and it only writes to `shadowObservations`.
 *
 * PRODUCTION CALLERS PASS NOTHING — the default is always the real function.
 */
export interface ManageTradesDeps {
  composeProtection?: typeof composeProtection
}

export function manageTrades(
  openPositions: EAPosition[],
  latestPrices:  Record<string, { bid: number; ask: number }>,
  candleCache:   Record<string, { candles: EACandle[]; updatedAt: string }>,
  prevState:     Record<string, TradeState>,
  riskCtx?:      RiskContext,
  deps?:         ManageTradesDeps,
): ManageResult {
  const now      = Date.now()
  const nowSec   = Math.floor(now / 1000)
  // Shadow observer ONLY. Defaults to the real implementation in production.
  const composeShadow = deps && typeof deps.composeProtection === 'function'
    ? deps.composeProtection
    : composeProtection
  const commands: ManagementCommand[] = []
  const log:      string[] = []
  const riskEvents: ManageResult['riskEvents'] = []
  const telemetry: ManageResult['telemetry'] = []
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
  // Shadow mode: new giveback ratchet computes+logs only; existing management
  // rules (BE / partial-lock / ATR trail / decay / time / peak-BE) continue
  // exactly as before. See RiskContext.shadowProtection.
  const shadowProtection = !!(riskCtx && riskCtx.shadowProtection)

  // SHADOW OBSERVATION COLLECTOR — declared OUTSIDE the loop so it accumulates
  // across positions. It is written to by an isolated try/catch and read only at
  // the return; `commands` is never derived from it.
  const shadowObservations: Record<string, unknown>[] = []

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
    // Which existing rule last improved the stop (for shadow telemetry so we can
    // tell EXISTING_RULE_MORE_PROTECTIVE apart from the new ratchet).
    let existingManagerAction: string | null = null

    // Close-telemetry emitter for EXISTING rules (peak-BE / time-exit / decay) so
    // shadow analysis sees every profit-management closure with full runtime R.
    const emitCloseTelemetry = (rule: string): void => {
      telemetry.push({
        ticket: pos.ticket,
        tradeId: null,
        pair,
        direction: dir,
        lots: pos.lots,
        openPrice: pos.openPrice,
        initialSl: originalSl,
        currentPrice: midPx > 0 ? midPx : null,
        currentProfit: pos.profit,
        peakProfit,
        plannedRiskUsd: initialRiskUsd,
        currentR,
        peakR: peakProfit / initialRiskUsd,
        retainedPct: peakProfit > 0 ? pos.profit / peakProfit : null,
        givebackPct: peakProfit > 0 ? (peakProfit - pos.profit) / peakProfit : null,
        protectionStage: state.protectionStage || 'DEVELOP',
        targetFloorUsd: state.retentionFloorUsd ?? null,
        proposedProtectionSl: null,
        currentLiveSl: pos.sl,
        existingManagerAction,
        shadowDecision: `EXISTING_${rule}_CLOSE`,
        action: `${rule.toLowerCase().replace(/_/g, '-')}-close`,
        actionAt: new Date(now).toISOString(),
        shadow: shadowProtection,
      })
    }

    // ── 1. Break-even at +1R ────────────────────────────────────────────────
    if (!state.beApplied && currentR >= BE_TRIGGER_R) {
      const beImproves = dir === 'BUY' ? originalEntry > pos.sl : originalEntry < pos.sl
      if (beImproves) {
        newSl           = originalEntry
        state.beApplied = true
        existingManagerAction = 'BE'
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
        existingManagerAction = 'PARTIAL_LOCK'
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
        existingManagerAction = 'ATR_TRAIL'
        log.push(`[tm] ${sym}#${key} trail: price=${midPx} ATR=${atr.toFixed(dp)} → SL=${trailSl.toFixed(dp)}`)
      }
    }


    // ── 3b. Peak-giveback protection (retention ratchet) ─────────────────────
    // lib/profit-protection.mjs — progressive protection of accumulated profit.
    // Evaluated AFTER BE/partial-lock/trail so each management cycle still yields
    // ONE authoritative SL: this rule only wins when it is the most protective
    // forward-moving candidate. floor/stage are monotonic & persisted.
    if (pos.profit > 0 && peakProfit > 0) {
      const pp = profitProtection({
        dir, entry: originalEntry, currentSl: pos.sl,
        currentProfit: pos.profit, peakProfit,
        riskUsd: initialRiskUsd, lots: pos.lots,
        pipValuePerLot: pvpl, pip,
        stage: state.protectionStage || '',
        retentionFloorUsd: state.retentionFloorUsd || 0,
      })
      if (pp.stage) state.protectionStage = pp.stage
      if (pp.floorUsd > 0) state.retentionFloorUsd = Math.max(state.retentionFloorUsd || 0, pp.floorUsd)
      const g = shadowDecision({ shadowMode: shadowProtection, newSl: pp.newSl, closeRequested: pp.closeRequested })
      const bestSoFar = newSl ?? pos.sl
      const candidate = pp.newSl !== null ? pickMostProtectiveSl(dir, bestSoFar, [pp.newSl]) : bestSoFar
      const adopted = g.modify && candidate === pp.newSl && candidate !== bestSoFar
      if (adopted && pp.newSl !== null) {
        newSl = pp.newSl
        log.push(`[tm] ${sym}#${key} ${pp.action}: peak=$${peakProfit.toFixed(2)} now=$${pos.profit.toFixed(2)} retention=${((pos.profit / peakProfit) * 100).toFixed(0)}% stage=${pp.stage} floor=$${pp.floorUsd.toFixed(2)} → SL=${pp.newSl.toFixed(dp)}`)
      } else if (shadowProtection && (pp.newSl !== null || pp.closeRequested)) {
        // Shadow mode: log what the new rule WOULD have done; do not act.
        log.push(`[tm][shadow] ${sym}#${key} WOULD ${pp.closeRequested ? 'CLOSE' : `modify_sl to ${(pp.newSl ?? 0).toFixed(dp)}`}: stage=${pp.stage} peak=$${peakProfit.toFixed(2)} now=$${pos.profit.toFixed(2)} floor=$${pp.floorUsd.toFixed(2)}`)
      }
    // ── 3a-SHADOW. Adaptive protection OBSERVER (no execution authority) ─────
    //
    // WHY HERE: this is the first point in the cycle where the authoritative
    // values exist — `atr`/`midPx` from the live branch above, `initialRiskUsd`
    // (planned risk), the persisted `peakProfit`/stage/floor, and the live `newSl`
    // selection. Everything below is READ-ONLY with respect to trading: it pushes
    // one structured object into `shadowObservations` and touches no other
    // variable that feeds `commands`.
    //
    // Wrapped in try/catch: a shadow failure must never suppress live protection.
    try {
      const priceKeyFound  = Object.prototype.hasOwnProperty.call(latestPrices || {}, sym)
      const candleKey      = `${sym}_M5`
      const candleKeyFound = Object.prototype.hasOwnProperty.call(candleCache || {}, candleKey)

      /**
       * MALFORMED-KEY DIAGNOSIS (observation only).
       *
       * A symbol-key mismatch currently surfaces as `live-atr-missing-candles`,
       * which is true but useless for telling "this cache is genuinely empty"
       * apart from "the cache holds this instrument under a different string".
       * We probe the canonical alternatives WITHOUT changing which key the live
       * strategy uses — this is diagnosis, not correction.
       */
      const altKeys = []
      const canonical = String(pair)                        // 'XAU/USD'
      const deslashed = canonical.replace(/[^A-Za-z0-9]/g, '')  // 'XAUUSD'
      for (const k of [`${canonical}_M5`, `${deslashed}_M5`]) {
        if (k !== candleKey && Object.prototype.hasOwnProperty.call(candleCache || {}, k)) altKeys.push(k)
      }
      const altPriceKeys = []
      for (const k of [canonical, deslashed]) {
        if (k !== sym && Object.prototype.hasOwnProperty.call(latestPrices || {}, k)) altPriceKeys.push(k)
      }
      // The most likely explanation, stated plainly for the log reader.
      const keyDiagnosis =
        candleKeyFound && priceKeyFound ? 'keys-ok'
        : (altKeys.length || altPriceKeys.length) ? 'key-mismatch-suspected'
        : !candleKeyFound && !priceKeyFound ? 'both-keys-missing-no-alternate'
        : !candleKeyFound ? 'candle-cache-empty-no-alternate'
        : 'price-key-missing-no-alternate'

      // ── STARTUP / STALENESS EVIDENCE ─────────────────────────────────────
      // `candleCache` is NOT persisted (it is rebuilt from each EA sync), so a
      // worker/EA restart re-opens a window where ATR is legitimately absent.
      // Recording uptime and candle age is what lets a real trade distinguish
      // "still warming" from "genuinely broken".
      const processUptimeSec = (() => {
        try { return typeof process !== 'undefined' && typeof process.uptime === 'function' ? process.uptime() : null }
        catch { return null }
      })()
      const latestCandleTs = (() => {
        if (!candleKeyFound) return null
        const entry = (candleCache as any)[candleKey]
        const cs = Array.isArray(entry?.candles) ? entry.candles : []
        const last = cs[cs.length - 1]
        if (last && Number.isFinite(Number(last.t))) {
          const t = Number(last.t)
          return t > 1e12 ? t / 1000 : t            // tolerate ms or s epochs
        }
        if (entry?.updatedAt) {
          const p = new Date(entry.updatedAt).getTime()
          return Number.isFinite(p) ? p / 1000 : null
        }
        return null
      })()
      const candleAgeSec = latestCandleTs == null ? null : Math.max(0, Math.round(now / 1000 - latestCandleTs))
      const candleCount    = candleKeyFound && Array.isArray((candleCache as any)[candleKey]?.candles)
        ? (candleCache as any)[candleKey].candles.length
        : 0

      // Why the LIVE ATR branch did or did not participate. Mirrors its condition
      // in the same order, so a future trade answers "why did the live ATR trail
      // not protect this?" with no silent conjunction.
      const liveAtrReason =
        !candleKeyFound            ? 'live-atr-missing-candles'
        : !(atr > 0)               ? 'live-atr-invalid'
        : !(midPx > 0)             ? 'live-atr-missing-price'
        : !(pos.profit > TRAIL_MIN_PROFIT_USD) ? 'live-atr-below-profit-gate'
        : existingManagerAction === 'ATR_TRAIL' ? 'live-atr-active'
        : 'live-atr-not-better-than-live'

      // The candidate the live branch actually computed (recomputed from the same
      // inputs — the branch may decline it, so it is not always `newSl`).
      const liveAtrMult = pos.profit > PROFIT_TIGHTEN_USD ? TRAIL_ATR_MULT_TIGHT : TRAIL_ATR_MULT_LOOSE
      const liveAtrCandidate = (atr > 0 && midPx > 0)
        ? (dir === 'BUY' ? midPx - atr * liveAtrMult : midPx + atr * liveAtrMult)
        : null

      // PLANNED-RISK PROVENANCE: `initialRiskUsd` is RECONSTRUCTED from the
      // original entry/SL and instrument geometry — never assumed. If that
      // reconstruction is not finite and positive, R is unavailable and the
      // shadow must not invent one.
      const riskValid = Number.isFinite(initialRiskUsd) && initialRiskUsd > 0
      const plannedRiskSource = riskValid ? 'reconstructed-from-initial-sl' : 'unavailable'

      // PEAK PROVENANCE: persisted running max carried in state, updated by this
      // cycle. Recorded so peakR is trusted as lifecycle-wide, not a snapshot.
      const previousPeakProfit = Number(state.peakProfit) || 0
      const establishedNewPeak = pos.profit > previousPeakProfit

      const shadow = composeShadow({
        dir, entry: originalEntry, currentSl: newSl ?? pos.sl,
        lots: pos.lots, pip, pipValuePerLot: pvpl,
        plannedRiskUsd: riskValid ? initialRiskUsd : null,
        currentProfit: pos.profit, peakProfit,
        stage: state.protectionStage || '', retentionFloorUsd: state.retentionFloorUsd || 0,
        riskPrice: Number.isFinite(initialRiskPips) ? initialRiskPips * pip : null,
        lockR: 0.5,
        atr: atr > 0 ? atr : null, atrCandles: candleCount,
        midPx, atrMult: liveAtrMult,
        // Candidate-only R gate for EVALUATION; deliberately NOT applied to the
        // live $15 gate — we want telemetry comparing the two.
        trailMinProfitR: null,
        mode: shadowProtection ? 'shadow' : 'live',
      })

      const rOfSl = (sl: number | null) => (sl == null || !riskValid || !(pip > 0))
        ? null
        : ((dir === 'BUY' ? sl - originalEntry : originalEntry - sl) / pip) * pvpl * pos.lots / initialRiskUsd
      const shadowFinalR = rOfSl(shadow.finalSl)
      const liveFinalR   = rOfSl(newSl ?? pos.sl)
      shadowObservations.push(buildShadowObservation({
        key, sym, pair, entry: originalEntry, midPx, pos, initialRiskUsd, plannedRiskSource,
        currentR, riskValid, previousPeakProfit, peakProfit, establishedNewPeak,
        priceKeyFound, candleKey, candleKeyFound, candleCount,
        altKeys, altPriceKeys, keyDiagnosis,
        processUptimeSec, candleAgeSec,
        liveAtrReason, liveAtrCandidate, atr, newSl, shadow, shadowFinalR, liveFinalR,
        shadowProtection, now,
      }))
    } catch (e: any) {
      // Best-effort and fail-safe: record, then continue existing live management.
      log.push(`[tm][shadow] observation failed for ${sym}#${key} (ignored): ${e?.message}`)
    }

      if (g.close && pp.closeRequested) {
        log.push(`[tm] ${sym}#${key} GIVEBACK-COLLAPSE-CLOSE: peak=$${peakProfit.toFixed(2)} now=$${pos.profit.toFixed(2)} stage=${pp.stage} floor=$${pp.floorUsd.toFixed(2)}`)
        emitCloseTelemetry('GIVEBACK_COLLAPSE')
        commands.push({
          id: crypto.randomUUID(), type: 'close', symbol: sym, ticket: pos.ticket,
          createdAt: new Date(now).toISOString(), expiresAt: nowSec + CMD_TTL_S,
        })
        nextState[key] = state
        continue
      }
      // Telemetry: every protection decision, plus a ~60s periodic line while a
      // trade is in profit, so giveback is observable even between actions.
      const periodicDue = (now - (state.telemetryAt || 0)) > 60_000
      if (pp.action !== null || pp.closeRequested || periodicDue) {
        state.telemetryAt = now
        const ppx = pp.action === 'early-giveback-be'
        const shadowDecisionToken = shadowProtection
          ? (pp.closeRequested ? 'WOULD_CLOSE' : pp.newSl !== null ? (ppx ? 'WOULD_MOVE_SL_TO_BE' : 'WOULD_MOVE_SL') : 'NONE')
          : (adopted ? (ppx ? 'WOULD_MOVE_SL_TO_BE' : 'MOVED_SL')
            : (pp.newSl !== null && !pp.closeRequested ? 'EXISTING_RULE_MORE_PROTECTIVE' : 'NONE'))
        telemetry.push({
          ticket: pos.ticket,
          tradeId: null,
          pair,
          direction: dir,
          lots: pos.lots,
          openPrice: pos.openPrice,
          initialSl: originalSl,
          currentPrice: midPx > 0 ? midPx : null,
          currentProfit: pos.profit,
          peakProfit,
          plannedRiskUsd: initialRiskUsd,
          currentR,
          peakR: peakProfit / initialRiskUsd,
          retainedPct:   pos.profit / peakProfit,
          givebackPct:   (peakProfit - pos.profit) / peakProfit,
          protectionStage: pp.stage || state.protectionStage || 'DEVELOP',
          targetFloorUsd: pp.floorUsd,
          proposedProtectionSl: pp.newSl,
          currentLiveSl: pos.sl,
          existingManagerAction,
          shadowDecision: shadowDecisionToken,
          action: adopted ? pp.action : (shadowProtection ? (pp.action || (pp.closeRequested ? 'shadow-close' : null)) : null),
          actionAt: pp.action ? pp.actionAt : null,
          shadow: shadowProtection,
          floorUsd: pp.floorUsd,
          floorPct: pp.floorPct,
        })
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
      emitCloseTelemetry('PEAK_BE')
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
      emitCloseTelemetry('TIME_EXIT')
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
      emitCloseTelemetry('DECAY')
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

  // Log positions that disappeared (closed naturally at broker) — include the
  // last known peak so MFE evidence is visible even when the EA close event
  // (which writes mfe_usd) arrives later or not at all.
  for (const key of Object.keys(prevState)) {
    if (!openTickets.has(key)) {
      const peak = Number(prevState[key]?.peakProfit) || 0
      log.push(`[tm] ticket ${key} gone from EA — purging state${peak > 0 ? ` (last known peak/MFE $${peak.toFixed(2)})` : ''}`)
    }
  }

  return { tradeState: nextState, commands, log, riskEvents, telemetry, shadowObservations }
}
