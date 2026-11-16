/**
 * SybexForexAI — INTEGRITY MONITOR THRESHOLDS
 *
 * WHY THIS EXISTS (Phase 4.2.1, defect M-6 / additional finding A-6)
 * `app/api/production-integrity/route.ts` reported `reconciliation_refresh` as
 * HEALTHY while the reconciliation was 4.4 hours stale, because the thresholds
 * were written for a scheduler that does not run: 6 h = WARNING, 48 h = FAILED
 * against a 10-minute design cadence. The health surface therefore could not
 * detect the exact failure it exists to detect.
 *
 * WHY IT IS GATED RATHER THAN FIXED IN PLACE
 * M-6 has a hard dependency on C-2: the cron schedule cannot run until the
 * deployment has CRON_SECRET, so tightening the threshold today would paint the
 * monitor red permanently and teach the reader to ignore it — noise, not safety.
 *
 * So the threshold is environment-controlled, and the default is *exactly*
 * today's behaviour. Nothing changes until the owner sets the variable after C-2
 * is fixed:
 *
 *     RECON_STALE_WARN_HOURS=0.5     # 30 minutes, matching the design cadence
 *
 * An unset, empty, non-numeric, non-finite, zero/negative or absurd value falls
 * back to `DEFAULT_RECON_WARN_HOURS`, so a typo can never silently disable the
 * check (which is what an "infinite" threshold would do).
 *
 * Pure by design: the environment is a parameter, so the test asserts the real
 * parser rather than a copy of it.
 */

/** Today's shipped WARNING threshold — unchanged unless the owner opts in. */
export const DEFAULT_RECON_WARN_HOURS = 6

/** The value to use once C-2 is fixed: 30 minutes, the design cadence. */
export const STRICT_RECON_WARN_HOURS = 0.5

/** The variable the owner sets to opt in. */
export const RECON_WARN_ENV = 'RECON_STALE_WARN_HOURS'

/** Anything below this is meaningless (and looks like an attempted bypass). */
export const MIN_RECON_WARN_HOURS = 0.25

/** Anything above this is indistinguishable from disabling the check. */
export const MAX_RECON_WARN_HOURS = 168

/**
 * Resolve the WARNING threshold in hours.
 *
 * `env` is passed explicitly so this stays pure and testable.
 * A value outside `[MIN_RECON_WARN_HOURS, MAX_RECON_WARN_HOURS]` is rejected
 * rather than clamped: clamping an absurd value would silently accept a
 * misconfiguration, and the safe response to "I cannot tell what you meant" is
 * the shipped default, not the most permissive number in range.
 */
export function reconWarnHours(env = {}) {
  const raw = env?.[RECON_WARN_ENV]
  if (raw === null || raw === undefined) return DEFAULT_RECON_WARN_HOURS
  const text = String(raw).trim()
  if (text === '') return DEFAULT_RECON_WARN_HOURS
  const n = Number(text)
  if (!Number.isFinite(n)) return DEFAULT_RECON_WARN_HOURS
  if (n < MIN_RECON_WARN_HOURS || n > MAX_RECON_WARN_HOURS) return DEFAULT_RECON_WARN_HOURS
  return n
}

/**
 * The FAILED threshold that pairs with a WARNING threshold. Kept as a function so
 * the two can never be edited apart: FAILED is always the larger of eight WARN
 * intervals and the shipped 48 h backstop.
 */
export function reconFailHours(warnHours = DEFAULT_RECON_WARN_HOURS) {
  return Math.max(warnHours * 8, 48)
}

/**
 * Classify a reconciliation age. `null` (no rows / no timestamp) is FAILED, not
 * HEALTHY — an unevaluated monitor must never look calm.
 */
export function reconStatus(ageHours, warnHours = DEFAULT_RECON_WARN_HOURS) {
  if (ageHours === null || ageHours === undefined || !Number.isFinite(ageHours)) return 'FAILED'
  if (ageHours > reconFailHours(warnHours)) return 'FAILED'
  if (ageHours > warnHours) return 'WARNING'
  return 'HEALTHY'
}
