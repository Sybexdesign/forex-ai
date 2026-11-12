// lib/analytics-metrics.d.mts
// Type surface for lib/analytics-metrics.mjs (Phase 4.2C).

import type { PopulationCounts, PopulationKey, TradeLike } from './analytics-scope.mjs'

export declare const METRICS_VERSION: string

export interface Stats {
  basis: 'NET' | 'GROSS'
  n: number
  net: number | null
  grossWin: number | null
  grossLoss: number | null
  wins?: number
  losses?: number
  breakevens?: number
  winRate: number | null
  lossRate: number | null
  profitFactor: number | null
  expectancy: number | null
  avg: number | null
  median: number | null
  largestWin: number | null
  largestLoss: number | null
  maxDrawdown: number | null
  maxConsecutiveLosses: number | null
  version: string
}

export interface ScopedAnalytics {
  scope: {
    counts: PopulationCounts
    totalRows: number
    genuineExecutions: number
    disclosure: string
    version: string
  }
  net: Stats & { population: PopulationKey; confirmed: true }
  gross: Stats & { population: PopulationKey; confirmed: false }
  netComplete: boolean
  excluded: {
    simulations: number
    cancelled: number
    open: number
    accountingPending: number
    accountingError: number
  }
  version: string
}

export declare function computeStats(values?: number[], basis?: 'NET' | 'GROSS'): Stats
export declare function buildScopedAnalytics(trades?: TradeLike[]): ScopedAnalytics

export declare function scopedEquityCurve(
  trades?: TradeLike[],
  startingBalance?: number,
  population?: PopulationKey,
): {
  points: Array<{ i: number; day: string; balance: number | null }>
  basis: 'NET' | 'GROSS'
  population: PopulationKey
}
