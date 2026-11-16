// lib/api-query.d.mts
// Type surface for lib/api-query.mjs (Phase 4.2.1, M-4 / A-5).

export declare const DEFAULT_LIMIT: number
export declare const MAX_LIMIT: number

export interface LimitOptions {
  defaultLimit?: number
  max?: number
}

export declare function parseLimit(raw?: unknown, options?: LimitOptions): number

export interface WindowDescription {
  limit: number
  rows: number
  requested: number | null
  truncated: boolean
}

export declare function describeWindow(input: {
  limit: number
  rows: number
  requested?: number | null
}): WindowDescription
