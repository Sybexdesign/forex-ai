export const MANUAL_MAX_RISK_PCT_DEFAULT: number
export const MANUAL_MAX_RISK_PCT_CEILING: number

export const MANUAL_REJECT: {
  LOTS_INVALID: string
  LOTS_ABOVE_MAX: string
  GEOMETRY_INVALID: string
  BALANCE_INVALID: string
  RISK_BUDGET_ZERO: string
  RISK_PCT_MISSING: string
  SL_BELOW_BROKER_MIN: string
}

/** Returns null when the strategy layer supplied no usable budget — never a fallback. */
export function resolveManualRiskPct(raw: unknown): number | null

export interface ManualPlanOk {
  ok: true
  reason: null
  lots: number
  riskPct: number
  permittedRiskUsd: number
  slPips: number
  rawSlPips: number
  slClampedToCap: boolean
  tpPips: number | null
  riskUsd: number
  accountRiskPct: number
}

export interface ManualPlanRejected {
  ok: false
  reason: string
  message: string
}

export function planManualSizing(o: {
  manualLots: unknown
  balance: unknown
  manualRiskPct?: unknown
  pipValuePerLot: unknown
  minStopPips: unknown
  maxSlPips: unknown
  rr?: number | null
}): ManualPlanOk | ManualPlanRejected
