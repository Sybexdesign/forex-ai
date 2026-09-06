// lib/outcome-linkage.d.mts
export interface LinkPoolRow {
  id?: string
  user_id?: string | null
  pair?: string
  direction?: string
  outcome?: string | null
  created_at?: string
  candle_close_time?: string | null
  entry?: number | string | null
  outcome_source?: string | null
  signal_label_outcome?: string | null
  signal_label_source?: string | null
  signal_label_resolved_at?: string | null
  entry_price?: number | string | null
  generated_at?: string
  resolved_at?: string | null
  result?: string | null
  opened_at?: string
  closed_at?: string | null
  pl_usd?: number | null
}
export interface LinkPools {
  predictions?: LinkPoolRow[]
  signals?: LinkPoolRow[]
  reconciliations?: LinkPoolRow[]
  trades?: LinkPoolRow[]
}
export interface LinkedRecord {
  setupKey: string
  user_id: string
  pair: string
  direction: string | null
  prediction: string | null
  signalLabel: string | null
  signalLabelSource: string | null
  reconciliation: string | null
  execution: string | null
  executionPnl: number | null
  [k: string]: unknown
}
export function linkRecords(
  pools: LinkPools,
  options?: Record<string, unknown>,
): { records: LinkedRecord[]; ambiguousSkipped: Record<string, number>; linkedCounts: Record<string, number> }
