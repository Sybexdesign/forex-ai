// lib/threshold-calibration.ts
// Audit Phase 2 (item 7): derive the NO-TRADE minStrength threshold per market
// regime from calibrated historical evidence instead of the original heuristic
// (chop=100, ranging=78, weak-trend=75, trending=72, strong-trend=100).
//
// Method: pool resolved `signals` rows (outcome WIN/LOSS) that carry a regime
// tag in `indicator_snapshot._regime.marketRegime`, grouped by regime and
// sorted by confidence. For each regime, walk confidence downward from 100 and
// find the HIGHEST threshold at which the pooled win rate of all samples at or
// above that confidence still clears the breakeven bar. Any signal below that
// threshold is historically a net loser for that regime → NO-TRADE.
//
// The result is cached for CALIBRATION_TTL_MS. If the query fails or a regime
// has too few samples, that regime is omitted and the caller falls back to the
// heuristic `classifyRegime()` thresholds.
import { getAdminClient } from '@/lib/supabase'

export type RegimeName = 'chop' | 'ranging' | 'weak-trend' | 'trending' | 'strong-trend'

export type CalibratedMap = Partial<Record<RegimeName, number>>

const CALIBRATION_TTL_MS   = 10 * 60_000  // recompute every 10 minutes
const MIN_SAMPLES_PER_REGIME = 20         // need ≥20 resolved signals per regime
const BREAKEVEN_WIN_RATE    = 0.55        // require ≥55% pooled win rate to trade
const CONF_STEP             = 5           // walk confidence in 5-point steps
const FLOOR                 = 60          // never let calibration lower the gate below 60

let _cache: { at: number; value: CalibratedMap } | null = null

/** Clear the in-memory calibration cache (used by admin cache-reset endpoints). */
export function clearCalibrationCache(): void {
  _cache = null
}

/** Latest calibrated min-strength per regime. Falls back to {} on any error. */
export async function getCalibratedMinStrengths(): Promise<CalibratedMap> {
  if (_cache && Date.now() - _cache.at < CALIBRATION_TTL_MS) return _cache.value
  const value = await computeCalibration()
  _cache = { at: Date.now(), value }
  return value
}

async function computeCalibration(): Promise<CalibratedMap> {
  const out: CalibratedMap = {}
  try {
    const admin = getAdminClient()
    const { data, error } = await admin
      .from('signals')
      .select('confidence, outcome, indicator_snapshot')
      .in('outcome', ['WIN', 'LOSS'])
      .limit(5000)

    if (error) throw error

    const byRegime: Record<string, { confidence: number; win: boolean }[]> = {}
    for (const row of data || []) {
      const regime = row?.indicator_snapshot?._regime?.marketRegime as RegimeName | undefined
      if (!regime) continue
      const conf = Number(row?.confidence)
      if (!Number.isFinite(conf)) continue
      ;(byRegime[regime] ??= []).push({ confidence: conf, win: row.outcome === 'WIN' })
    }

    for (const [regime, rows] of Object.entries(byRegime)) {
      if (rows.length < MIN_SAMPLES_PER_REGIME) continue
      rows.sort((a, b) => a.confidence - b.confidence)

      // Walk from high confidence down. `threshold` = the highest confidence at
      // which every pooled band at-or-above it still shows ≥ breakeven win rate.
      let threshold: number | null = null
      for (let c = 100; c >= 0; c -= CONF_STEP) {
        const above = rows.filter(r => r.confidence >= c)
        if (above.length < MIN_SAMPLES_PER_REGIME) continue
        const winRate = above.filter(r => r.win).length / above.length
        if (winRate >= BREAKEVEN_WIN_RATE) {
          threshold = c
          break
        }
      }

      if (threshold !== null) {
        out[regime as RegimeName] = Math.max(FLOOR, threshold)
        console.log(`[threshold-calibration] ${regime}: ${rows.length} resolved signals → calibrated minStrength ${Math.max(FLOOR, threshold)}`)
      }
    }
  } catch (e: any) {
    console.warn(`[threshold-calibration] calibration failed — heuristics remain in effect: ${e?.message}`)
  }
  return out
}
