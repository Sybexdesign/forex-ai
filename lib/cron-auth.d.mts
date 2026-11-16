// lib/cron-auth.d.mts
// Type surface for lib/cron-auth.mjs (Phase 4.2.1, C-2).

export type CronAuthMode = 'cron_secret' | 'development_open' | 'cron_secret_not_configured'

export interface CronAuthResult {
  ok: boolean
  authMode: CronAuthMode
  configured: boolean
}

export interface CronAuthInput {
  headers?: { get(name: string): string | null } | null
  searchParams?: { get(name: string): string | null } | null
  env?: Record<string, string | undefined>
}

export declare function timingSafeEqual(a: string, b: string): boolean
export declare function authoriseCronRequest(input?: CronAuthInput): CronAuthResult
export declare function cronRejectionStatus(authMode: CronAuthMode | string): 401 | 503
export declare function cronRejectionMessage(authMode: CronAuthMode | string): string
