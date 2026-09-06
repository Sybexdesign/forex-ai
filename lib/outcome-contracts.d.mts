export const O_PREDICTION: { WIN: 'WIN'; LOSS: 'LOSS'; INCONCLUSIVE: 'INCONCLUSIVE'; PENDING: 'PENDING' }
export const O_SIGNAL_LABEL: { WIN: 'WIN'; LOSS: 'LOSS'; PENDING: 'PENDING' }
export const O_RECONCILIATION: { WIN: 'WIN'; LOSS: 'LOSS'; INCONCLUSIVE: 'INCONCLUSIVE'; PENDING: 'PENDING' }
export const O_EXECUTION: { WIN: 'WIN'; LOSS: 'LOSS'; BREAKEVEN: 'BREAKEVEN'; OPEN: 'OPEN' }

export const OUTCOME_SOURCES: Record<string, string>
export const CONTRACT_VERSIONS: Record<string, string>
export const SIGNALS_OUTCOME_WRITERS: string[]
export interface OutcomeContract {
  purpose: string
  horizonMinutes: number | null
  sampling: string
  timeout: string | null
  version: string | null
  writers: string[]
  question?: string
  resolution?: string
}
export const OUTCOME_CONTRACTS: Record<string, OutcomeContract>
export function sameQuestion(aKey: string, bKey: string): boolean
export const OUTCOME_LABELS: Record<string, string>
