export const ACCOUNT_VERDICT: {
  OK: 'ok'
  WARN: 'warn'
  ERROR: 'error'
}

/** Matches BALANCE_TTL (adapter) and the order-route staleness guard. */
export const EA_STALE_AFTER_MS: number

export type AccountVerdictLevel = 'ok' | 'warn' | 'error'

export interface AccountVerdict {
  level: AccountVerdictLevel
  message: string
}

export interface DiagnoseBrokerConnectionInput {
  isMt5?: boolean
  brokerName?: string
  error?: string | null
  balance?: number
  equity?: number
  currency?: string
  login?: string
  server?: string
  lastSyncAt?: string | null
  priceSymbols?: number
  candleSets?: number
  nowMs?: number
}

/** "12s ago" under 90s, then "3m ago". */
export function describeAge(ageMs: number): string

export function diagnoseBrokerConnection(input?: DiagnoseBrokerConnectionInput): AccountVerdict
