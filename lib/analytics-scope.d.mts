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

export type BrokerTicketKind = 'MT5_POSITION' | 'OTHER_BROKER_REF' | 'NONE'

export declare const BROKER_TICKET_KIND: {
  MT5_POSITION: 'MT5_POSITION'
  OTHER_BROKER_REF: 'OTHER_BROKER_REF'
  NONE: 'NONE'
}

export interface TradeVerdict {
  population: PopulationKey
  reason: string
  netPnl: number | null
  grossPnl: number | null
  isGenuineExecution: boolean
  /** Phase 4.2.1 (M-1): what KIND of broker reference the row carries. An
   *  "MT5-confirmed" claim may only rest on `MT5_POSITION`. */
  brokerEvidence: BrokerTicketKind
  contributesToNet: boolean
  contributesToGross: boolean
  version: string
}

export type PopulationCounts = Record<PopulationKey, number>

export declare function isGenuineExecution(trade?: TradeLike): boolean
export declare function isUuidRef(value?: unknown): boolean
export declare function brokerTicketKind(trade?: TradeLike, internalId?: string | null): BrokerTicketKind
export declare function isMt5TicketBacked(trade?: TradeLike): boolean

export interface KnownPLSum {
  /** `null` when ANY considered row has no finite `pl_usd` — a partially known
   *  total is not a total. */
  pl: number | null
  known: number
  unknown: number
  rows: number
}

export declare function sumKnownPL(trades?: TradeLike[]): KnownPLSum
export declare function classifyTrade(trade?: TradeLike): TradeVerdict

export declare function partitionTrades(trades?: TradeLike[]): {
  classified: Array<{ trade: TradeLike; verdict: TradeVerdict }>
  buckets: Record<PopulationKey, TradeLike[]>
  counts: PopulationCounts
  ticketKinds: Record<BrokerTicketKind, number>
  totalRows: number
  genuineExecutions: number
  mt5TicketExecutions: number
  otherBrokerExecutions: number
  version: string
}

/**
 * The populations that represent a closed broker execution. Exported so tests
 * and callers can assert the definition instead of restating it.
 */
export declare const EXECUTION_POPULATIONS: PopulationKey[]

/** Rows a risk limit or a performance figure may be computed over. */
export declare function closedExecutions(trades?: TradeLike[]): TradeLike[]

export declare function describeScope(counts?: Partial<PopulationCounts>): string

// ── Row presentation (Phase 4.2.1 — RECENT TRADES) ───────────────────────────
// `describeTradeRow` is the ONLY mapping from a stored row to what a human may be
// shown. It reuses classifyTrade(), so the table and the headline statistics
// cannot drift apart.

export declare const ROW_RESULT: {
  WIN: 'WIN'
  LOSS: 'LOSS'
  BREAKEVEN: 'BREAKEVEN'
  PENDING: 'RESULT PENDING'
  OPEN: 'OPEN'
  CANCELLED: 'CANCELLED'
  SIMULATED: 'SIMULATED'
}

export interface DescribedTradeRow {
  id: string | number | null
  population: PopulationKey
  isOpen: boolean
  isCancelled: boolean
  isSimulated: boolean
  isGenuineExecution: boolean
  brokerEvidence: BrokerTicketKind
  pair: string | null
  direction: string | null
  lots: number | null
  entryPrice: number | null
  exitPrice: number | null
  openedAt: string | null
  closedAt: string | null
  grossPnl: number | null
  commission: number | null
  swap: number | null
  otherFees: number | null
  netPnl: number | null
  pnl: number | null
  pnlBasis: 'NET' | 'GROSS' | 'NONE' | 'ERROR'
  result: string
  provisional: boolean
  accountingStatus: string
  accountingComplete: boolean
  missingCosts: string[]
  ticket: string | null
  source: string | null
  sortTimestamp: string | null
  reason: string
  version: string
}

export declare function describeTradeRow(trade?: TradeLike): DescribedTradeRow

export declare function sortDescribedRows(rows?: DescribedTradeRow[]): DescribedTradeRow[]

export declare function utcDayKey(at: Date | string | number): string | null

export interface UtcDayRealised {
  day: string | null
  total: number | null
  rows: number
  netComplete: boolean
  excluded: { grossOnly: number; accountingPending: number }
}

export declare function realisedPnlForUtcDay(trades?: TradeLike[], at?: Date | string | number): UtcDayRealised

