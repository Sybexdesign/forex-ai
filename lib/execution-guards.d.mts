// lib/execution-guards.d.mts
export function signalMaxAgeSeconds(): number
export function entryDriftPctLimit(): number
export function computeDriftPct(referencePrice: number | string | null, livePrice: number | string | null): number | null
export function evaluateExecutionGuards(opts?: {
  nowMs?: number
  ttlSeconds?: number
  driftPctLimit?: number
  signalAtMs?: number | string | null
  referencePrice?: number | string | null
  livePrice?: number | string | null
  signalRef?: string | null
  openTradeExists?: boolean
}): { ok: boolean; gate: string | null; reason: string | null }
