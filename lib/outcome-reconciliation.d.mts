// lib/outcome-reconciliation.d.mts
export const AGREEMENT: Record<string, string>
export const MISMATCH: Record<string, string>
export const REASON: Record<string, string>

export interface PairComparison {
  agree: boolean | null
  className: string | null
  reasons: string[]
}
export interface LinkedRecord {
  prediction?: string | null
  signalLabel?: string | null
  signalLive?: string | null
  reconciliation?: string | null
  execution?: string | null
  [k: string]: unknown
}
export function comparePair(
  pair: string, outcomeA: string | null, outcomeB: string | null,
  flags?: Record<string, boolean>,
): PairComparison
export function diagnose(rec: LinkedRecord, flags?: Record<string, boolean>): string[]
export function classifyRecord(rec: LinkedRecord, flags?: Record<string, boolean>): string
export function linkKey(userId: string, pair: string, candleCloseIso: string): string
export function summarize(records: LinkedRecord[]): Record<string, unknown>
