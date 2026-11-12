// lib/analytics-scope.d.mts
// Type surface for lib/analytics-scope.mjs (Phase 4.2C).

export type PopulationKey =
  | 'NET_CONFIRMED'
  | 'GROSS_ONLY'
  | 'ACCOUNTING_PENDING'
  | 'ACCOUNTING_ERROR'
  | 'SIMULATION'
  | 'OPEN'
  | 'CANCELLED'

export declare const POPULATION: {
  NET_CONFIRMED: 'NET_CONFIRMED'
  GROSS_ONLY: 'GROSS_ONLY'
  ACCOUNTING_PENDING: 'ACCOUNTING_PENDING'
  ACCOUNTING_ERROR: 'ACCOUNTING_ERROR'
  SIMULATION: 'SIMULATION'
  OPEN: 'OPEN'
  CANCELLED: 'CANCELLED'
}

export declare const ANALYTICS_SCOPE_VERSION: string

export interface TradeLike {
  broker_ticket?: string | null
  pl_usd?: number | string | null
  net_realised_pnl?: number | string | null
  commission?: number | string | null
  swap?: number | string | null
  other_fees?: number | string | null
  accounting_complete?: boolean | null
  accounting_missing?: string[] | null
  accounting_status?: string | null
  trade_result?: string | null
  result?: string | null
  trade_status?: string | null
  closed_at?: string | null
  opened_at?: string | null
  [key: string]: unknown
}

export interface TradeVerdict {
  population: PopulationKey
  reason: string
  netPnl: number | null
  grossPnl: number | null
  isGenuineExecution: boolean
  contributesToNet: boolean
  contributesToGross: boolean
  version: string
}

export type PopulationCounts = Record<PopulationKey, number>

export declare function isGenuineExecution(trade?: TradeLike): boolean
export declare function classifyTrade(trade?: TradeLike): TradeVerdict

export declare function partitionTrades(trades?: TradeLike[]): {
  classified: Array<{ trade: TradeLike; verdict: TradeVerdict }>
  buckets: Record<PopulationKey, TradeLike[]>
  counts: PopulationCounts
  totalRows: number
  genuineExecutions: number
  version: string
}

export declare function describeScope(counts?: Partial<PopulationCounts>): string
