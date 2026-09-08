// lib/trade-state.d.mts
export function mergeTradeState(
  prev: Record<string, any> | null,
  next: Record<string, any> | null,
): Record<string, any>
export function assertNoStateRegression(
  prev: Record<string, any> | null,
  next: Record<string, any> | null,
): { ok: boolean; issues: string[] }
