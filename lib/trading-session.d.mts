// lib/trading-session.d.mts
// Type surface for lib/trading-session.mjs (saved ACTIVE TRADING HOURS, UTC).
//
// One implementation, imported by the signal route, the worker, the order route
// and the Strategy UI. Semantics: [start, end) in UTC hours, start inclusive,
// end exclusive, wrap when start > end, fail closed on anything unparseable.

export declare const TRADING_SESSION_VERSION: string

export declare const SESSION_REASON: {
  ELIGIBLE: 'within_session'
  OUTSIDE: 'outside_session'
  NOT_CONFIGURED: 'session_not_configured'
  START_INVALID: 'session_start_invalid'
  END_INVALID: 'session_end_invalid'
  EMPTY: 'session_window_empty'
  TIMESTAMP_INVALID: 'timestamp_invalid'
}

export interface SessionWindow {
  ok: boolean
  reason: string
  start: number | null
  end: number | null
  wraps: boolean
  allDay: boolean
  label: string | null
  rawStart?: unknown
  rawEnd?: unknown
  version: string
}

export interface SessionBoundary {
  at: string
  label: string
  utcDate: string
  inMinutes: number
}

export interface SessionEvaluation {
  version: string
  start: number | null
  end: number | null
  wraps: boolean
  allDay: boolean
  label: string | null
  utcTimestamp: string | null
  utcHour: number | null
  eligible: boolean
  active: boolean
  reason: string
  nextOpen: SessionBoundary | null
  nextClose: SessionBoundary | null
}

export interface SessionAudit {
  version: string
  fingerprint: string
  window: string | null
  startHour: number | null
  endHour: number | null
  wraps: boolean
  utcTimestamp: string | null
  utcHour: number | null
  eligible: boolean
  reason: string
  nextOpen: SessionBoundary | null
  nextClose: SessionBoundary | null
}

export declare function parseSessionWindow(settings?: unknown): SessionWindow

export declare function describeSessionWindow(window: Partial<SessionWindow> | null): string | null

export declare function hourIsWithinWindow(window: SessionWindow | null, hour: number): boolean

export declare function evaluateSessionWindow(
  window: SessionWindow | null,
  at: Date | string | number | null | undefined,
  nowMs?: number,
): SessionEvaluation

export declare function evaluateTradingSession(
  settings: unknown,
  at: Date | string | number | null | undefined,
  nowMs?: number,
): SessionEvaluation

export declare function sessionFingerprint(settings: unknown): string

export declare function sessionAudit(
  settings: unknown,
  at: Date | string | number | null | undefined,
  nowMs?: number,
): SessionAudit

export declare function validateSessionSettings(
  settings: unknown,
): { ok: true; start?: number; end?: number } | { ok: false; error: string }
