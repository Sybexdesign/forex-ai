/**
 * SybexForexAI — DIAGNOSTICS ENDPOINT AUTHORISATION (SEC-1)
 *
 * WHY THIS EXISTS
 * `GET /api/production-integrity` was reachable by anyone who knew the URL. It
 * is not a health check: it returned the firm's entire trading performance over
 * a 120-day window (per-UK-hour win rate, net, profit factor, max drawdown, max
 * consecutive losses, sensitivity excluding the largest winner), the accounting
 * completeness counts, the reconciliation layer's age and linked-row count,
 * order-authority lane/decision tallies, and `cronSecretConfigured` — i.e.
 * whether the scheduler is currently blocked. None of that is PII, and none of it
 * is secret in the credential sense, but all of it is proprietary and
 * operationally revealing. It also echoed raw PostgREST error text on failure,
 * which leaks schema detail.
 *
 * There is no anonymous consumer: no UI page calls it, no cron entry in
 * `vercel.json` calls it, and no worker calls it. It is an operator evidence
 * tool. So the decision is not "trim a field or two" — it is: authenticate the
 * whole payload, and answer unauthenticated callers with a body that contains
 * nothing derived from data.
 *
 * TWO ACCEPTED CREDENTIALS
 *   1. `Authorization: Bearer <CRON_SECRET>` — the same operator secret the
 *      reconciliation scheduler already holds. Timing-safe comparison, reusing
 *      `lib/cron-auth.mjs` rather than a second implementation.
 *   2. `Authorization: Bearer <supabase user JWT>` — a signed-in admin, exactly
 *      the convention `/api/admin/users` already uses. The JWT is only a
 *      CANDIDATE here: verifying it needs a database round trip, so the route
 *      performs that and this module stays pure and synchronous.
 *
 * The point of the split is that a forged or expired token cannot be accepted by
 * accident: an unrecognised credential classifies as `none`, and `admin_jwt`
 * means "go and verify", never "approved".
 */

import { timingSafeEqual } from './cron-auth.mjs'

/** Any `Bearer …` value, trimmed, or `''`. */
export function bearerToken(headers) {
  const raw = typeof headers?.get === 'function' ? (headers.get('authorization') ?? '') : ''
  const match = /^Bearer\s+(\S.*)$/i.exec(String(raw).trim())
  return match ? match[1].trim() : ''
}

/**
 * A JWT has three dot-separated segments. This is deliberately a SHAPE check,
 * not a validity check — signature and expiry are the database's job.
 *
 * The 8-character floor per segment is NOT cosmetic. Accepting any `a.b.c` would
 * let an anonymous caller make every request trigger a `supabase.auth.getUser()`
 * round trip, turning this endpoint into an amplifier aimed at the auth service.
 * A real Supabase HS256 token is ~40+ characters in the signature alone, so the
 * floor costs nothing legitimate. Do not relax it while "simplifying" this check.
 */
const JWT_SHAPE = /^[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}$/

/**
 * Classify the caller without touching the database.
 *
 * @returns {{ method: 'operator_secret'|'admin_jwt'|'none', token: string, authorised: boolean, reason: string }}
 *   `authorised` is only ever true for `operator_secret`. `admin_jwt` is a
 *   candidate that still has to be resolved to an admin user.
 */
export function classifyDiagnosticsCaller({ headers, env = {} } = {}) {
  const token = bearerToken(headers)
  if (!token) {
    return { method: 'none', token: '', authorised: false, reason: 'no credentials presented' }
  }

  const configured = env?.CRON_SECRET
  if (configured && timingSafeEqual(token, configured)) {
    return { method: 'operator_secret', token, authorised: true, reason: 'operator secret' }
  }

  if (JWT_SHAPE.test(token)) {
    return {
      method: 'admin_jwt',
      token,
      authorised: false,
      reason: 'session token presented — admin role must be verified',
    }
  }

  // A wrong secret falls here too, and is told nothing about which part was
  // wrong: distinguishing "no such credential" from "wrong secret" would turn
  // the endpoint into an oracle for guessing the secret.
  return { method: 'none', token, authorised: false, reason: 'unrecognised credential' }
}

/**
 * The body an unauthenticated caller receives.
 *
 * It carries NO status, NO counts, NO figures and NO deployment state — only the
 * fact that authentication is required, so a human hitting the URL in a browser
 * understands what they are looking at. Everything an attacker could learn from
 * a 200 (is the scheduler blocked, how many trades, is the account profitable)
 * is absent.
 */
export function restrictedDiagnosticsBody() {
  return {
    readOnly: true,
    authenticationRequired: true,
    error: 'Unauthorized',
    note:
      'Production diagnostics are not public. Send Authorization: Bearer <CRON_SECRET> or an ' +
      'authenticated admin session token. No counts, financial figures or deployment state are ' +
      'returned to an unauthenticated caller.',
  }
}
