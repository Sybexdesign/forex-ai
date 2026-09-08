// lib/auto-trade-health.d.mts
export function classifyAutoTradeHealth(opts?: {
  nowMs?: number
  configId?: string | null
  accounts?: Array<{ id: string; isActive: boolean; lastSyncMs: number | null }>
  workerLastSeenMs?: number | null
  lastSigCheckMs?: number | null
  marketOpen?: boolean | null
  events?: {
    lastSignalMs?: number | null
    lastActionableMs?: number | null
    lastHoldMs?: number | null
    lastOrderMs?: number | null
  }
  gates?: {
    staleCandleSkip?: number
    staleSignalReject?: number
    duplicateSignalReject?: number
    entryDriftReject?: number
  }
}): Record<string, any>
