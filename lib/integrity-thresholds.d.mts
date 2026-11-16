// lib/integrity-thresholds.d.mts
// Type surface for lib/integrity-thresholds.mjs (Phase 4.2.1, M-6 / A-6).

export declare const DEFAULT_RECON_WARN_HOURS: number
export declare const STRICT_RECON_WARN_HOURS: number
export declare const RECON_WARN_ENV: string
export declare const MIN_RECON_WARN_HOURS: number
export declare const MAX_RECON_WARN_HOURS: number

export declare function reconWarnHours(env?: Record<string, string | undefined>): number
export declare function reconFailHours(warnHours?: number): number
export declare function reconStatus(ageHours?: number | null, warnHours?: number): 'HEALTHY' | 'WARNING' | 'FAILED'
