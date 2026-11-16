/**
 * SybexForexAI — CRON AUTHORISATION (Phase 4.2.1, defect C-2)
 *
 * WHY THIS IS A MODULE
 * The refresh endpoint's authorisation is the *code half* of C-2, and C-2 cannot
 * be closed by code: the production worker has no `CRON_SECRET` set, so the
 * 10-minute reconciliation has never run (36 × `Outcome reconciliation refresh
 * BLOCKED: CRON_SECRET not set on the worker`). What code CAN do is prove it will
 * behave correctly the moment the secret exists — and prove it by running the
 * same function production runs, not a copy of it.
 *
 * THE THREE DEFECTS THIS ENCODES (all closed in Phase 4.2E, frozen here):
 *   1. The secret was read only from `?secret=` — a query string lands in access
 *      logs, proxy logs, browser history and `Referer` headers, so a valid secret
 *      leaked itself. Headers are the supported transport; the query string stays
 *      only as a hand-typed fallback.
 *   2. With no secret configured, the check fell back to trusting `x-vercel-cron`
 *      — a header any caller can forge, making the "authentication" decorative.
 *      That fallback is GONE: unconfigured in production denies.
 *   3. Comparison used `===`. It is timing-safe now.
 *
 * Pure: no `process` reference, no I/O. The caller supplies headers, search params
 * and env, so this cannot acquire a side effect and is directly testable.
 */

/** Constant-time string comparison. Length mismatch is a fast, safe "no". */
export function timingSafeEqual(a, b) {
  const left = String(a)
  const right = String(b)
  if (left.length !== right.length) return false
  let diff = 0
  for (let i = 0; i < left.length; i++) diff |= left.charCodeAt(i) ^ right.charCodeAt(i)
  return diff === 0
}

/**
 * The value the caller presented, in precedence order.
 *
 * `authorization: Bearer <secret>` first (the scheduler's form), then
 * `x-cron-secret`, then the legacy `?secret=` fallback.
 */
function presentedSecret(headers, searchParams) {
  const header = (name) => (typeof headers?.get === 'function' ? headers.get(name) : null) ?? ''
  const query = (name) => (typeof searchParams?.get === 'function' ? searchParams.get(name) : null) ?? ''

  const bearer = header('authorization').replace(/^Bearer\s+/i, '').trim()
  if (bearer) return bearer
  const direct = header('x-cron-secret').trim()
  if (direct) return direct
  return query('secret').trim()
}

/**
 * Decide whether a cron-style request may proceed.
 *
 * Returns `{ ok, authMode, configured }` — modes rather than a bare boolean, so
 * `/api/production-integrity` can report *why* a refresh was rejected instead of
 * hiding the reason behind `false`.
 *
 *   configured + exact match        → ok,     'cron_secret'
 *   configured + wrong/absent       → denied, 'cron_secret'
 *   unconfigured + production       → denied, 'cron_secret_not_configured'  (503)
 *   unconfigured + non-production   → ok,     'development_open'
 *
 * Note the ordering: a configured secret is ALWAYS required, including in
 * development. Only a *missing* configuration opens the endpoint locally.
 */
export function authoriseCronRequest({ headers, searchParams, env = {} } = {}) {
  const configured = env?.CRON_SECRET
  const presented = presentedSecret(headers, searchParams)

  if (configured) {
    const ok = presented.length > 0 && timingSafeEqual(presented, configured)
    return { ok, authMode: 'cron_secret', configured: true }
  }

  // No secret configured. Never open in production — an unauthenticated endpoint
  // that rewrites derived analytical rows is an open invitation.
  if (env?.NODE_ENV !== 'production') return { ok: true, authMode: 'development_open', configured: false }
  return { ok: false, authMode: 'cron_secret_not_configured', configured: false }
}

/** HTTP status for a rejection: 503 is a deployment fault, 401 is a bad caller. */
export function cronRejectionStatus(authMode) {
  return authMode === 'cron_secret_not_configured' ? 503 : 401
}

/** The message shown for a rejection, matched to its mode. */
export function cronRejectionMessage(authMode) {
  return authMode === 'cron_secret_not_configured'
    ? 'CRON_SECRET is not configured; refusing to refresh unauthenticated'
    : 'Unauthorized'
}
