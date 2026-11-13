// lib/journal-stats.d.mts
// Type surface for lib/journal-stats.mjs (Phase 4.2D).

import type { PopulationCounts, TradeLike } from './analytics-scope.mjs'

export declare const JOURNAL_STATS_VERSION: string
export declare const CANCELLED_RESULTS: ReadonlySet<string>

export interface JournalPairStat {
  pair: string
  wins: number
  losses: number
  n: number
  pl: number
}

export interface JournalEquityPoint {
  trade: number
  balance: number | null
  pl: number
}

export interface JournalStats {
  version: string
  scopeVersion: string
  /** 'NET' only when every genuine execution is net-derived. */
  basis: 'NET' | 'GROSS'
  netComplete: boolean
  n: number
  net: number | null
  /** Percentage (0-100, one decimal), null when undecidable. */
  winRate: number | null
  profitFactor: number | null
  expectancy: number | null
  wins: number
  losses: number
  breakevens: number
  largestWin: number | null
  largestLoss: number | null
  maxDrawdown: number | null
  avgWinPips: number | null
  avgLossPips: number | null
  pairStats: JournalPairStat[]
  bestPair: string | null
  worstPair: string | null
  streaks: { maxWin: number; maxLoss: number }
  equityCurve: JournalEquityPoint[]
  equityBasis: 'NET' | 'GROSS'
  /** Genuine executions only — never simulation/cancelled/open rows. */
  genuineRows: TradeLike[]
  counts: PopulationCounts
  totalRows: number
  genuineExecutions: number
  disclosure: string
  excluded: {
    simulations: number
    cancelled: number
    open: number
    accountingPending: number
    accountingError: number
  }
}

/** Best honest realised value for one row: net when confirmed, else gross, else null. */
export declare function realisedValue(trade?: TradeLike): number | null

export declare function buildJournalStats(
  trades?: TradeLike[],
  opts?: { startingBalance?: number },
): JournalStats
