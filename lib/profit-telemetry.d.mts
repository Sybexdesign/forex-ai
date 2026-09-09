// lib/profit-telemetry.d.mts
export function rowKind(item: any): 'snapshot' | 'decision' | 'close'
export function toRow(
  item: any,
  ctx?: { protectionMode?: 'shadow' | 'live'; stateSeq?: number | null; marketRegime?: string | null; session?: string | null },
): Record<string, any>
export function snapshotSignature(row: Record<string, any>): string
export function dedupeRows(rows: Array<Record<string, any>>): Array<Record<string, any>>
export function zoneOf(peakR: number | null | undefined): 'A' | 'B' | 'C' | 'SR'
export const ZONE_LABEL: Record<string, string>
export const EARLY_MIN_PEAK_USD: number
export const EARLY_RESCUE_EST_USD: number
export function closeSummaryFromRows(
  rows: Array<Record<string, any>>,
  over?: { actualRealisedPnlUsd?: number | null; actualMfeUsd?: number | null },
): Record<string, any>
export function aggregateTrades(summaries: Array<Record<string, any>>): Record<string, any>
export function bestEffort(write: () => Promise<any>, log?: (e: any) => void): Promise<boolean>
