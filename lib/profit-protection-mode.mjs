// lib/profit-protection-mode.mjs
// ONE canonical resolver for profit-protection activation.
//
// THE PROBLEM THIS FIXES
//
// Activation was previously decided by two independent flags ANDed together at
// the call site:
//
//   const forceShadow = process.env.PROFIT_PROTECTION_SHADOW_MODE === 'true'
//   const shadowProtection = forceShadow || (process.env.PROFIT_PROTECTION_MODE || 'shadow') !== 'live'
//
// That is a silent-override hazard in both directions:
//
//   * `PROFIT_PROTECTION_SHADOW_MODE=true` (a LEGACY boolean) beats
//     `PROFIT_PROTECTION_MODE=live`. An operator who sets the new flag and
//     watches protection "do nothing" has no diagnostic telling them why.
//   * `PROFIT_PROTECTION_MODE=LIVE` / `'Live'` / `'true'` silently fail the
//     `=== 'live'` comparison and fall back to shadow — a typo or case
//     difference downgrades activation without a word.
//   * Any unrecognised value is treated as shadow with no signal, so
//     `PROFIT_PROTECTION_MODE=liv` looks identical to `=shadow`.
//
// The resolver makes precedence explicit, validates the vocabulary, and FAILS
// SAFE TO SHADOW on anything ambiguous — but never silently: every non-obvious
// decision carries a diagnostic so the health/telemetry path can surface it.

/** The only valid modes. `off` is a hard stop; `shadow` observes; `live` acts. */
export const PP_MODES = ['off', 'shadow', 'live']

/** Safe default whenever anything is missing, malformed or contradictory. */
export const PP_MODE_DEFAULT = 'shadow'

/**
 * Resolve the effective profit-protection mode from the environment.
 *
 * PRECEDENCE (explicit, and the whole point of this module):
 *
 *   1. `PROFIT_PROTECTION_MODE=live` — matched EXACTLY (lowercase, unpadded) — is
 *      the ONLY way to activate live protection.
 *   2. The legacy `PROFIT_PROTECTION_SHADOW_MODE=true` may only pull DOWN to
 *      shadow — it can never pull UP from `off`, because `off` is an explicit
 *      hard stop and honouring a legacy flag over it would re-enable a system an
 *      operator deliberately disabled.
 *   3. Anything else → `shadow`, with a diagnostic. Never live.
 *
 * FAIL-CLOSED: near-miss spellings of `live` (`LIVE`, `Live`, `"live "`) resolve
 * to SHADOW and carry a note naming the exact required value. Tolerance is
 * reserved for directions that move TOWARD safety: case/padded variants of the
 * legacy flag and of `off` are honoured.
 *
 * @param {Record<string,string|undefined>} env
 * @returns {{mode:'off'|'shadow'|'live', shadow:boolean, live:boolean, off:boolean, notes:string[], source:string}}
 */
export function resolveProfitProtectionMode(env = {}) {
  const notes = []
  const rawMode  = env.PROFIT_PROTECTION_MODE
  const rawForce = env.PROFIT_PROTECTION_SHADOW_MODE
  const legacyForceShadow = String(rawForce ?? '').trim().toLowerCase() === 'true'

  if (rawForce != null && String(rawForce).trim() !== '' && !legacyForceShadow) {
    notes.push(
      `PROFIT_PROTECTION_SHADOW_MODE="${rawForce}" is not "true" and has no effect; ` +
      'PROFIT_PROTECTION_MODE is authoritative',
    )
  }

  // ── 1. No explicit mode at all ────────────────────────────────────────────
  if (rawMode == null || String(rawMode).trim() === '') {
    if (legacyForceShadow) {
      notes.push('PROFIT_PROTECTION_MODE unset; legacy PROFIT_PROTECTION_SHADOW_MODE=true → shadow')
    }
    return finish('shadow', 'default', notes)
  }

  const norm = String(rawMode).trim().toLowerCase()

  // ── 2. Validate the vocabulary rather than pattern-matching it ────────────
  if (!PP_MODES.includes(norm)) {
    notes.push(
      `PROFIT_PROTECTION_MODE="${rawMode}" is not one of ${PP_MODES.join('|')} → failing safe to shadow`,
    )
    return finish('shadow', 'invalid', notes)
  }

  // ── 3. `off` is a hard stop that no legacy flag may override ─────────────
  if (norm === 'off') {
    if (legacyForceShadow) {
      notes.push('PROFIT_PROTECTION_MODE=off honoured: legacy SHADOW_MODE cannot re-enable a disabled system')
    }
    return finish('off', 'env', notes)
  }

  // ── 4. LIVE REQUIRES THE EXACT TOKEN — fail closed ───────────────────────
  // `live` is the only value that arms a system which moves real stops on a real
  // account, so it is matched LITERALLY: exact lowercase, no leading/trailing
  // whitespace. Every other spelling — LIVE, Live, "live ", " live " — resolves to
  // SHADOW and says exactly why, rather than arming on an ambiguous value or
  // silently ignoring the operator's intent.
  //
  // NOTE: this also restores the pre-resolver behaviour. The expression this
  // module replaced compared `(MODE || 'shadow') !== 'live'` exactly, so those
  // variants were already shadow. Tolerance is deliberately reserved for
  // directions that move TOWARD safety — case/padding variants of the legacy
  // SHADOW_MODE=true above, and of `off` below.
  if (norm === 'live') {
    // (a) Legacy force-shadow always wins, whatever the exact spelling.
    if (legacyForceShadow) {
      notes.push(
        'CONFLICT: PROFIT_PROTECTION_MODE=live but legacy PROFIT_PROTECTION_SHADOW_MODE=true → ' +
        'shadow wins. Remove PROFIT_PROTECTION_SHADOW_MODE to activate live.',
      )
      return finish('shadow', 'legacy-override', notes)
    }
    // (b) Near-miss spellings never arm live.
    if (rawMode !== 'live') {
      notes.push(
        `PROFIT_PROTECTION_MODE=${JSON.stringify(rawMode)} is not the exact lowercase "live" → ` +
        'staying in shadow. Live activation requires PROFIT_PROTECTION_MODE=live with no ' +
        'leading/trailing whitespace and no case change.',
      )
      return finish('shadow', 'inexact', notes)
    }
    return finish('live', 'env', notes)
  }

  // Everything else that reached here is a valid, non-live mode (`shadow`).
  // `off` returned above, so OFF stays distinct from SHADOW.
  return finish(norm, 'env', notes)
}

function finish(mode, source, notes) {
  return {
    mode,
    source,
    notes,
    shadow: mode === 'shadow',
    live:   mode === 'live',
    off:    mode === 'off',
    // Convenience for the existing call site, which wants a plain boolean.
    shadowProtection: mode !== 'live',
  }
}

/** Single-line diagnostic for logs/heartbeat. */
export function describeProfitProtectionMode(r) {
  const base = `profit-protection mode=${r.mode} (source=${r.source})`
  return r.notes.length ? `${base} — ${r.notes.join(' | ')}` : base
}
