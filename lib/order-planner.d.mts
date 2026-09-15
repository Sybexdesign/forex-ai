export const PLAN_REJECT: {
  LOTS_NOT_POSITIVE: string
  LOTS_ABOVE_MAX: string
  GEOMETRY_INVALID: string
}

export const MANUAL_REJECT: {
  LOTS_INVALID: string
  LOTS_ABOVE_MAX: string
  GEOMETRY_INVALID: string
  BALANCE_INVALID: string
  RISK_BUDGET_ZERO: string
  RISK_PCT_MISSING: string
  SL_BELOW_BROKER_MIN: string
}

export interface ManualRiskSummary {
  riskPct: number
  permittedRiskUsd: number
  riskUsd: number
  accountRiskPct: number
  slClampedToCap: boolean
}

export interface PlanOk {
  ok: true
  /** AUTHORITATIVE size. Manual mode echoes the user's request unchanged. */
  lots: number
  lotSource: 'manual' | 'auto'
  /** The stop/target distances actually sent to the broker. */
  slPips: number
  tpPips: number
  requestedLots: number | null
  rawSlPips: number | null
  slClampedToCap: boolean
  slWidenedToMinStop: boolean
  pipValuePerLot: number
  minStopPips: number
  slCapPips: number
  manualRisk: ManualRiskSummary | null
}

export interface PlanRejected {
  ok: false
  reason: string
  message: string
  stage: string
  requestedLots: number | null
}

export function planOrder(o: {
  strategy: {
    manualLots?: number | null
    manualRiskPct?: number | null
    riskPct: number
    slPips: number
    tpPips: number
  }
  pair: string
  balance: number
  /** The broker's AUTO sizing function — the single injected dependency. */
  calcPositionSize: (balance: number, riskPct: number, slPips: number, pair: string) => number
  defaultManualRiskPct?: number | null
  pipValuePerLot?: number | null
  minStop?: number | null
  slCap?: number | null
}): PlanOk | PlanRejected

/** The last transformation before execution — the broker boundary. */
export function buildBrokerRequest(o: {
  pair: string
  direction: string
  plan: PlanOk
  currentPrice: number
}): {
  pair: string
  direction: string
  lots: number
  takeProfitPips: number
  stopLossPips: number
  currentPrice: number
}
