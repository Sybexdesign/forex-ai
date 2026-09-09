// lib/profit-protection.mjs
// Peak-Profit Giveback Protection — pure decision module (audit 2026-09-09).
//
// Problem (confirmed on production data 2026-09-08/09): 7/15 closed Auto Trades
// peaked at +$7..+$12.5 then realised a LOSS (-$0.33..-$32) — those peaks sat
// below the 0.5R break-even trigger and below the $15 ATR-trail gate, so price
// round-tripped to the original SL. Separately, trades peaking +$21..+$35
// realised only 22-45% because protection only acted via market-close decay at
// the 50%-of-peak line, with execution lag during sharp reversals.
//
// Design: a PROGRESSIVE RETENTION RATCHET driven by peak R-multiple (scales with
// position size/risk, not arbitrary dollars):
//   meaningful peak reached → if giveback would round-trip a winner, move SL to
//                             entry EARLY (protect ~0)
//   peakR ≥ 0.5 (PROTECT)    → target protection floor = 55% of peak profit
//   peakR ≥ 1.0 (LOCK)       → target protection floor = 65% of peak
//   peakR ≥ 1.7 (STRONG)     → target protection floor = 75% of peak
//   peakR ≥ 3.0 (EXCEPTIONAL)→ target protection floor = 85% of peak
//   retention collapsed through the floor between cycles → market-close backstop
//
// "Target protection floor" is INTENT — spread, slippage, gaps, broker rejection
// and modification latency can produce a different realised result. The floor is
// a monotonic ratchet (never backwards) expressed in dollars and converted to an
// SL price from the ORIGINAL entry (profit pips × pip-value × lots), so it works
// identically for BUY/SELL and any lot size. A noise margin keeps the SL below
// price enough that normal pullbacks do NOT trip it.
//
// Pure + testable. lib/trade-manager.ts decides WHEN to call it (one authoritative
// SL per cycle; most-protective forward-moving stop wins). No execution here.
// ─────────────────────────────────────────────────────────────────────────────

// Config — calibrated to production evidence (2026-09-08/09, XAU 0.14 lots):
// full-SL losses ≈ -$32 ⇒ 1R ≈ $35 (25-pip SL). Round-trip peaks $7.05-$12.56
// were only 0.20-0.36R; the $21-$35 giveback cluster was 0.6-1.0R. Bands below
// are set so those real R multiples reach protection. Do not change without
// fresh telemetry (shadow mode → live) — no aggressive unseen tuning.
export const PROTECTION_CONFIG = {
  // Peak must exceed this USD cushion before early giveback-BE engages. $7 (not
  // $8) because the worst single round-trip (2026-09-08 22:01, peak $7.05 →
  // -$32.09) sat below the old $8 gate.
  earlyGivebackMinPeakUsd: 7,
  // Trigger SL→entry when a winner above the cushion has given back >65% of its
  // peak AND profit has fallen to ≤ $4.
  earlyGivebackRetention: 0.35,
  earlyGivebackProfitCeilingUsd: 4,
  // R-multiple ladder (actual-R calibrated; 1R ≈ $35 on the observed account):
  //   peakR 0.5+ ($17+ peak)  → PROTECT    floor 55% of peak
  //   peakR 1.0+ ($35+ peak)  → LOCK       floor 65%
  //   peakR 1.7+ ($60+ peak)  → STRONG     floor 75%
  //   peakR 3.0+ ($105+ peak) → EXCEPTIONAL floor 85%
  // Strong historical runners (peaks $59.82-$146.43 realised $55.85-$127.74)
  // all closed ABOVE these floors, so none would have been clipped.
  bands: [
    { minPeakR: 3.0, floor: 0.85, stage: 'EXCEPTIONAL' },
    { minPeakR: 1.7, floor: 0.75, stage: 'STRONG' },
    { minPeakR: 1.0, floor: 0.65, stage: 'LOCK' },
    { minPeakR: 0.5, floor: 0.55, stage: 'PROTECT' },
  ],
  // Noise margin above the floor before ratcheting the SL up: max($3, 12% of peak).
  noiseUsd: 3,
  noiseFractionOfPeak: 0.12,
  // Never set an SL closer to price than this many dollars of profit.
  minStopGapUsd: 2,
  // Retention already below floor between cycles → market-close backstop.
  closeRequestMinUsd: 2,
}

export const STAGE_RANK = {
  DEVELOP: 0, EARLY_GIVEBACK_BE: 1, PROTECT: 2, LOCK: 3, STRONG: 4, EXCEPTIONAL: 5,
}

/**
 * Evaluate giveback protection for ONE open trade this cycle.
 * @param {object} o
 * @param {'BUY'|'SELL'} o.dir
 * @param {number} o.entry              — original entry price
 * @param {number} o.currentSl          — current broker SL
 * @param {number} o.currentProfit      — unrealised P&L (account currency)
 * @param {number} o.peakProfit         — highest unrealised P&L seen
 * @param {number} o.riskUsd            — initial risk (1R) in account currency
 * @param {number} o.lots
 * @param {number} o.pipValuePerLot     — $ per pip per lot
 * @param {number} o.pip                — pip size in price terms
 * @param {string} o.stage              — persisted protection stage ('' default)
 * @param {number} o.retentionFloorUsd  — persisted dollar floor (0 default)
 * @param {object} [o.config]           — override PROTECTION_CONFIG
 */
export function profitProtection(o) {
  const cfg = { ...PROTECTION_CONFIG, ...(o.config || {}) }
  const dir = o.dir === 'BUY' ? 'BUY' : 'SELL'
  const riskUsd = Number(o.riskUsd)
  const peak = Number(o.peakProfit) || 0
  const cur = Number(o.currentProfit) || 0
  const nowIso = new Date().toISOString()
  const none = () => ({
    newSl: null, closeRequested: false, action: null, actionAt: nowIso, stage: '',
    floorUsd: 0, floorPct: 0, proposedFloorUsd: 0,
    peakR: riskUsd > 0 ? peak / riskUsd : 0,
    givebackPct: peak > 0 ? Math.max(0, (peak - cur) / peak) : null,
    retentionPct: peak > 0 ? Math.max(0, cur / peak) : null,
  })

  if (peak <= 0 || cur >= peak) return none() // no peak yet / making new high
  if (!(riskUsd > 0) || !(o.lots > 0) || !(o.pipValuePerLot > 0)) return none()

  const peakR = peak / riskUsd
  const givebackPct = (peak - cur) / peak
  const retentionPct = cur / peak
  const out = { ...none(), peakR, givebackPct, retentionPct }
  const dollarsToPrice = (usd) => {
    const pips = usd / (o.pipValuePerLot * o.lots)
    return dir === 'BUY' ? o.entry + pips * o.pip : o.entry - pips * o.pip
  }
  const improves = (candidate) => (dir === 'BUY' ? candidate > o.currentSl : candidate < o.currentSl)

  // ── EARLY GIVEBACK BE — rescue sub-BE peaks that would otherwise round-trip
  //    to the original SL (the +$7..+$12.5 → −$0.3..−$32 production cluster).
  const prevEarly = (STAGE_RANK[o.stage] ?? 0) >= STAGE_RANK.EARLY_GIVEBACK_BE
  if (!prevEarly
    && peak >= cfg.earlyGivebackMinPeakUsd
    && cur <= cfg.earlyGivebackProfitCeilingUsd
    && retentionPct <= cfg.earlyGivebackRetention) {
    const entrySl = o.entry
    if (improves(entrySl)) {
      return {
        ...out, newSl: entrySl, action: 'early-giveback-be',
        actionAt: nowIso, stage: 'EARLY_GIVEBACK_BE', floorUsd: 0,
      }
    }
  }

  // ── R-BAND RETENTION RATCHET ─────────────────────────────────────────────
  // Highest stage whose minPeakR the PEAK has reached. Stage + dollar floor are
  // monotonic and persisted, so a strong peak protects even as profit falls.
  const band = cfg.bands.find((b) => peakR >= b.minPeakR) || null
  const prevIdx = STAGE_RANK[o.stage] ?? 0
  const stageIdx = band ? Math.max(prevIdx, STAGE_RANK[band.stage]) : prevIdx
  const stage = Object.keys(STAGE_RANK).find((k) => STAGE_RANK[k] === stageIdx) || 'DEVELOP'
  const floorPct = band ? band.floor : 0
  const proposedFloorUsd = band ? peak * floorPct : 0
  const floorUsd = Math.max(Number(o.retentionFloorUsd) || 0, proposedFloorUsd)
  out.floorPct = floorPct
  out.floorUsd = floorUsd
  out.proposedFloorUsd = proposedFloorUsd
  out.stage = stage

  if (floorUsd <= 0) return out

  // Noise margin — keep the SL this far below current profit, or wait.
  const noiseUsd = Math.max(cfg.noiseUsd, peak * cfg.noiseFractionOfPeak)
  if (cur > floorUsd + noiseUsd) return out

  if (cur < floorUsd - cfg.closeRequestMinUsd) {
    // Retention collapsed through the floor between management cycles → request
    // a market close while some profit remains (backstop; never at a loss).
    if (cur >= cfg.closeRequestMinUsd && floorPct >= 0.5) {
      return { ...out, closeRequested: true, action: 'giveback-collapse-close', actionAt: nowIso }
    }
    return out
  }

  // Normal ratchet: profit near-but-above the floor → move SL to the floor
  // level (most-protective forward stop), respecting the broker min gap.
  const gapUsd = cur - floorUsd
  if (gapUsd < cfg.minStopGapUsd) return out
  const floorSl = dollarsToPrice(floorUsd)
  if (improves(floorSl)) {
    return { ...out, newSl: floorSl, action: `ratchet-${stage.toLowerCase()}`, actionAt: nowIso }
  }
  return out
}

/**
 * Convert a dollar "target protection floor" into an SL price at the same
 * profit level for the original entry (BUY/SELL symmetric). Exposed separately
 * so the price conversion is independently unit-testable.
 * @returns {number} SL price that locks ≈ floorUsd of profit under normal
 *                   execution (spread/slippage/gaps can still move the fill).
 */
export function profitFloorToSl({ dir, entry, floorUsd, lots, pipValuePerLot, pip }) {
  const usd = Math.max(0, Number(floorUsd) || 0)
  const pips = usd / (Number(pipValuePerLot) * Number(lots))
  return dir === 'BUY'
    ? Number(entry) + pips * Number(pip)
    : Number(entry) - pips * Number(pip)
}

/**
 * Shadow-mode gate. When PROFIT_PROTECTION_SHADOW_MODE=true the NEW giveback
 * rule must calculate + log but never modify/close. Existing BE/trail/decay
 * logic is NOT routed through this gate.
 * @returns {{ modify: boolean, close: boolean }}
 */
export function shadowDecision({ shadowMode, newSl, closeRequested }) {
  return {
    modify: !shadowMode && newSl !== null,
    close:  !shadowMode && !!closeRequested,
  }
}

/**
 * One authoritative SL per cycle — return the most protective valid candidate.
 * Used to prove no rule can loosen another rule's protection.
 * @returns {number|null} candidates reduce to the most protective, else current.
 */
export function pickMostProtectiveSl(dir, current, candidates = []) {
  const side = dir === 'BUY' ? 1 : -1
  let best = Number.isFinite(Number(current)) ? Number(current) : null
  for (const c of candidates) {
    if (c === null || c === undefined || !Number.isFinite(Number(c))) continue
    const v = Number(c)
    if (best === null || (v - best) * side > 0) best = v
  }
  return best
}

