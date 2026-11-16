/**
 * SybexForexAI — EA BUILD IDENTITY (Phase 4.2.1)
 *
 * The Broker Connection page used to hard-code one EA version into its setup
 * copy. When the payload contract moved (v9.4 separate cost terms, v9.5
 * ticket-stamped closes) the page kept advertising the old build, so an
 * operator following it was told to install an EA that cannot produce the
 * accounting the rest of the product shows. This module is the single place
 * that answers two questions:
 *
 *   1. which build does this product require?  -> EA_BUILD
 *   2. which build is the terminal actually running? -> describeEaBuild()
 *
 * (2) is answered ONLY from evidence the EA itself wrote. v9.5 stamps
 * `eaVersion` + `executionPayloadVersion` into every position entry, and the
 * sync RPC persists those entries into broker_configs.config.openPositions
 * (see supabase/migrations/20261113_phase42_rpc_broker_deal_accounting.sql,
 * "Write back"). Nothing here probes the terminal, and nothing here guesses:
 * an absent stamp is reported as UNKNOWN, never as "up to date".
 *
 * WHY UNKNOWN IS NOT A FAILURE: a v9.5 terminal with no position entry since
 * the upgrade still carries the previous array, which has no stamp. The page
 * must not claim "current" from silence, and must not claim "outdated" from it
 * either — both would be invented facts about the running build.
 */

/** The build this product ships, and therefore requires. */
export const EA_BUILD = Object.freeze({
  /** Human/display version. */
  version: '9.5',
  label: 'v9.5',
  /** Exact string the EA writes into payloads (`eaVersion`). */
  buildStamp: '9.50',
  /** File served from public/ — asserted to exist by tests/ea-version.test.mjs. */
  fileName: 'SybexForexAI_EA_v9.5.mq5',
  downloadPath: '/SybexForexAI_EA_v9.5.mq5',
  /** Line the EA prints at init; the operator's proof of the attached EX5. */
  expertsLogLine: 'SybexForexAI EA v9.5 started',
  /** Contract marker the EA puts in every closed/position entry. */
  executionPayloadVersion: 2,
})

/**
 * The first build that reports commission, swap and fees SEPARATELY, which is
 * what makes net P&L broker-provable. Older builds fold them into one number,
 * so those closes can only ever render gross.
 */
export const REQUIRED_FOR_NET_ACCOUNTING = EA_BUILD.buildStamp

/**
 * The first build that puts `ticket` on a closed position, which is what lets
 * a close be matched to its broker deal by identity instead of by price.
 */
export const REQUIRED_FOR_TICKET_CLOSES = EA_BUILD.buildStamp

export const BUILD_STATUS = Object.freeze({
  CURRENT: 'CURRENT',
  OUTDATED: 'OUTDATED',
  UNKNOWN: 'UNKNOWN',
})

/**
 * Compare-friendly integer for a version string.
 *
 * Accepts '9.5', '9.50', 'v9.5', '9.3.1', 9.5. A single-digit minor is scaled
 * by 10 so that '9.5' and '9.50' — the same build, written two ways — compare
 * equal. Anything else returns null rather than a made-up number.
 *
 * @param {unknown} raw
 * @returns {{ reported: string, build: number } | null}
 */
export function parseEaBuild(raw) {
  if (raw === null || raw === undefined) return null
  if (typeof raw === 'object') raw = /** @type {any} */ (raw).version
  const text = String(raw).trim().replace(/^[vV]/, '')
  if (!/^\d+(\.\d+){0,2}$/.test(text)) return null
  const [maj, minRaw = '0', patchRaw = '0'] = text.split('.')
  const minor = minRaw.length === 1 ? Number(minRaw) * 10 : Number(minRaw)
  const patch = Number(patchRaw)
  if (![Number(maj), minor, patch].every(Number.isFinite)) return null
  return { reported: text, build: Number(maj) * 10_000 + minor * 100 + patch }
}

const REQUIRED_BUILD = parseEaBuild(EA_BUILD.buildStamp).build

/**
 * Read the build stamp out of a stored `openPositions` array.
 *
 * The array is whatever the last sync wrote, so the newest stamped entry wins.
 * Entries without a usable stamp are skipped (pre-v9.5 payloads, or a stale
 * array from before an upgrade). Returns null when no entry is stamped.
 *
 * @param {unknown} openPositions
 * @returns {{ version: string, build: number, payloadVersion: number|null, symbol: string|null } | null}
 */
export function extractReportedBuild(openPositions) {
  if (!Array.isArray(openPositions) || openPositions.length === 0) return null
  for (let i = openPositions.length - 1; i >= 0; i--) {
    const entry = openPositions[i]
    if (!entry || typeof entry !== 'object') continue
    const parsed = parseEaBuild(entry.eaVersion)
    if (!parsed) continue
    const pv = Number(entry.executionPayloadVersion)
    return {
      version: parsed.reported,
      build: parsed.build,
      payloadVersion: Number.isFinite(pv) ? pv : null,
      symbol: entry.symbol ? String(entry.symbol).slice(0, 24) : null,
    }
  }
  return null
}

/**
 * Turn "what the terminal reported" into a verdict for the Broker page.
 *
 * @param {unknown} reported  raw eaVersion, or the result of extractReportedBuild()
 * @returns {{ status: string, reported: string|null, required: string,
 *             isCurrent: boolean, headline: string, detail: string }}
 */
export function describeEaBuild(reported) {
  const parsed = parseEaBuild(reported)
  const required = EA_BUILD.label

  if (!parsed) {
    return {
      status: BUILD_STATUS.UNKNOWN,
      reported: null,
      required,
      isCurrent: false,
      headline: `Running build not reported — ${required} required`,
      detail:
        `No build stamp is present in the last position state the terminal sent, so the running build ` +
        `cannot be proven from the server. That is expected before ${required} is attached, and it is ` +
        `also what a flat account shows immediately after an upgrade. Confirm the Experts tab prints ` +
        `"${EA_BUILD.expertsLogLine}".`,
    }
  }

  if (parsed.build >= REQUIRED_BUILD) {
    return {
      status: BUILD_STATUS.CURRENT,
      reported: parsed.reported,
      required,
      isCurrent: true,
      headline: `EA build ${parsed.reported} reported — meets ${required}`,
      detail:
        `Closes from this build carry a broker ticket and separate commission, swap and fee terms, ` +
        `so each close can be matched to its broker deal and shown as net P&L.`,
    }
  }

  return {
    status: BUILD_STATUS.OUTDATED,
    reported: parsed.reported,
    required,
    isCurrent: false,
    headline: `EA build ${parsed.reported} reported — ${required} required`,
    detail:
      `This build folds commission and swap into one profit figure and does not put a ticket on a ` +
      `closed position. Closes stay gross-only in Recent Trades until ${required} is compiled and ` +
      `attached, and the figures are labelled as such rather than guessed.`,
  }
}

