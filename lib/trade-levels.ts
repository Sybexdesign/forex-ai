// lib/trade-levels.ts
// Single source of truth for the SL/TP pip transforms applied between a raw
// engine signal and the order the broker actually receives. Both the
// AutoTrade page (display + manual/auto order payloads) and /api/orders
// (min-stop widening) import from here so the card always shows the exact
// stop distance that will be placed.
//
// workers/scalper.mjs is a standalone deployment and cannot import this
// module — it duplicates MIRROR_SL_CAP / MIRROR_TP_CAP. Keep them in sync.

// SL/TP clamp bounds for scalp + mirror paths (Option C — see ATR audit).
// strategy.slPips/tpPips act as the FLOOR (minimum SL/TP). The engine's
// ATR-derived value is allowed to widen up to MIRROR_*_CAP. This stops the
// previous behaviour where strategy.slPips=18 was acting as a ceiling on top
// of an engine that already produces 30-80 pip SLs — placing a tight stop
// inside one bar of XAU/USD noise on every trade.
//
// 35-pip cap chosen because 5-day XAU ATR has a 5th percentile of ~24 pips,
// so even calm-market signals will produce SLs below the cap. Above the cap
// the position size becomes too small to be useful.
// TEMP DIAGNOSTIC 2026-06-11: raised 25 → 35 to test whether retcode 10013 on
// XAU mirror orders is a broker stops-level issue. Revert to 25 once root
// cause confirmed. Mirrored in workers/scalper.mjs — keep in sync.
export const MIRROR_SL_CAP = 35
export const MIRROR_TP_CAP = 70  // unchanged; widening only SL for the test

// Broker min-stop-distance floors. Brokers reject orders where SL/TP sit
// inside their freeze level (MT5 retcode 10016), which can change with spread
// spikes. Conservative per-instrument floors; anything tighter is widened
// with a 10% safety margin before placement.
export const MIN_STOP_PIPS: Record<string, number> = {
  XAU: 35,    // TEMP DIAGNOSTIC 2026-06-11: raised 20 → 35 alongside MIRROR_SL_CAP to test retcode 10013 on XAU. Revert to 20 once root cause confirmed.
  XAG: 10,    // XAG/USD: 0.10 USD = 10 pips at pip=0.01
  JPY: 5,     // *JPY: 5 pips at pip=0.01
  FX:  3,     // major FX: 3 pips at pip=0.0001
}

export function minStopPips(pair: string): number {
  const key = pair.startsWith('XAU') ? 'XAU'
            : pair.startsWith('XAG') ? 'XAG'
            : pair.includes('JPY')   ? 'JPY' : 'FX'
  return MIN_STOP_PIPS[key]
}

export function widenToMinStop(pips: number, pair: string): number {
  const minStop = minStopPips(pair)
  return pips < minStop ? Math.round(minStop * 1.1) : pips
}

// The full display==execution transform: Option C clamp (strategy floor,
// MIRROR_*_CAP ceiling) followed by the broker min-stop widening that
// /api/orders applies before placement. Cards must render SL/TP/lots from
// these values — rendering the raw engine distances showed stops up to 45
// pips away from where the broker actually placed them.
export function execSlTpPips(
  pair: string,
  derivedSlPips: number,
  derivedTpPips: number,
  floorSlPips: number,
  floorTpPips: number,
): { slPips: number; tpPips: number } {
  const clampedSl = Math.min(MIRROR_SL_CAP, Math.max(floorSlPips, derivedSlPips))
  const clampedTp = Math.min(MIRROR_TP_CAP, Math.max(floorTpPips, derivedTpPips))
  return {
    slPips: widenToMinStop(clampedSl, pair),
    tpPips: widenToMinStop(clampedTp, pair),
  }
}
