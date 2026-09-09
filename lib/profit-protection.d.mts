// lib/profit-protection.d.mts
export const PROTECTION_CONFIG: {
  earlyGivebackMinPeakUsd: number
  earlyGivebackRetention: number
  earlyGivebackProfitCeilingUsd: number
  bands: Array<{ minPeakR: number; floor: number; stage: string }>
  noiseUsd: number
  noiseFractionOfPeak: number
  minStopGapUsd: number
  closeRequestMinUsd: number
}
export const STAGE_RANK: Record<string, number>
export function isProtectionStageName(s: string): boolean
export function profitProtection(o: {
  dir: 'BUY' | 'SELL'
  entry: number
  currentSl: number
  currentProfit: number
  peakProfit: number
  riskUsd: number
  lots: number
  pipValuePerLot: number
  pip: number
  stage?: string
  retentionFloorUsd?: number
  config?: Partial<typeof PROTECTION_CONFIG>
}): {
  newSl: number | null
  closeRequested: boolean
  action: string | null
  actionAt: string
  stage: string
  floorUsd: number
  floorPct: number
  proposedFloorUsd: number
  peakR: number
  givebackPct: number | null
  retentionPct: number | null
}
export function profitFloorToSl(o: {
  dir: 'BUY' | 'SELL'
  entry: number
  floorUsd: number
  lots: number
  pipValuePerLot: number
  pip: number
}): number
export function shadowDecision(o: {
  shadowMode: boolean
  newSl: number | null
  closeRequested: boolean
}): { modify: boolean; close: boolean }
export function pickMostProtectiveSl(
  dir: 'BUY' | 'SELL',
  current: number | null,
  candidates?: Array<number | null>,
): number | null
