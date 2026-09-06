// lib/execution-truth.d.mts
export const TRADE_STATUS: Record<string, string>
export const TRADE_RESULT: Record<string, string>
export const EXECUTION_BE_EPSILON_USD: number
export const EXECUTION_CONTRACT_VERSION: string
export const EXECUTION_SOURCES: Record<string, string>

export interface NormalisedExecution {
  trade_status: string | null
  trade_result: string
  normalizedResult: string | null
}
export function normaliseExecution(input: Record<string, unknown>): NormalisedExecution
export function executionResult(netPnl: number | string | null, epsilon?: number): string
export function realisedR(netPnl: number | string | null, plannedRiskAmount: number | string | null): number | null
export function crossDomainClass(prediction: string | null, execution: string | null): string
export function sampleConfidenceLabel(n: number, thresholds?: { low: number; moderate: number; strong: number }): string
export function conversionEfficiency(
  executionExpectancyR: number | null, predictionExpectancyR: number | null,
  executionSample?: number, thresholds?: { low: number },
): { efficiency: number | null; reason: string | null }
export function edgeLeakage(predictionExpectancyR: number | null, executionExpectancyR: number | null): number | null
export function executionQualityScore(input: Record<string, unknown>): number
export function diffRefresh(
  derivedRows: Array<Record<string, unknown>>,
  existingRows: Array<Record<string, unknown>>,
): { inserted: string[]; updated: string[]; unchanged: string[]; deleted: string[] }
export function executionExpectancy(
  executions: Array<Record<string, unknown>>,
  options?: Record<string, unknown>,
): {
  n: number; avgRealisedR: number; medianR: number; winRate: number
  avgWinR: number | null; avgLossR: number | null; profitFactor: number | null
  sampleConfidence: string
} | null
