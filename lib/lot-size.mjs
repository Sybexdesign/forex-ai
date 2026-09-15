// lib/lot-size.mjs
// Validation for the Strategy Settings "Manual lot size" input.
//
// WHY THIS IS A SEPARATE PURE MODULE
//
// The bug it fixes was caused by validation happening on EVERY KEYSTROKE. A
// controlled input bound to a number cannot represent "the user is mid-edit":
// the moment the field is cleared, `parseFloat('')` is NaN, the value collapses
// to "not set", and the rendered `?? 0` slams a literal `0` back into the box.
// That is unfixable in the input handler — it needs a draft-string concept and a
// commit boundary — so the decision logic lives here, where it is testable
// without a DOM.
//
// THE CONTRACT
//
//   '' (or whitespace)  → valid, means "use automatic sizing", value = null
//   '0'                 → INVALID when a positive lot is required, with a
//                         message. It must never silently become 0 or null,
//                         because those mean opposite things: null = auto,
//                         0 = a lot size that cannot be traded.
//   anything else       → numeric, finite, within min/max, on the step grid
//
// Nothing here throws and nothing here coerces a bad value into a plausible one.

/** Mirrors MAX_LOTS in lib/trade-levels.ts — the hard ceiling at every layer. */
export const LOT_MAX_DEFAULT = 10
/** Broker minimum for the traded instruments. */
export const LOT_MIN_DEFAULT = 0.01
/** Lot step increment. */
export const LOT_STEP_DEFAULT = 0.01

/**
 * Lenient, never-throwing check used by the UI to decide whether the *current*
 * text is a complete value. It deliberately does NOT clamp: clamping mid-edit is
 * what made `1` and `1.25` untypable against a hardcoded `max={0.50}`.
 */
export function isPartialLotInput(raw) {
  const t = String(raw ?? '').trim()
  if (t === '') return true
  return /^\d*\.?\d*$/.test(t)
}

/**
 * Validate the committed lot-size text.
 *
 * @param {string|number|null|undefined} raw
 * @param {{min?:number, max?:number, step?:number, required?:boolean}} [opts]
 *   `min`/`max`/`step` let a broker or instrument override the defaults — the
 *   brief requires the saved value to respect broker/instrument limits, so they
 *   are parameters rather than constants baked into the comparison.
 * @returns {{ok:boolean, value:number|null, error:string|null, empty:boolean}}
 */
export function validateLotSize(raw, opts = {}) {
  const min  = Number.isFinite(Number(opts.min))  && Number(opts.min)  > 0 ? Number(opts.min)  : LOT_MIN_DEFAULT
  const max  = Number.isFinite(Number(opts.max))  && Number(opts.max)  > 0 ? Number(opts.max)  : LOT_MAX_DEFAULT
  // Step granularity can never be COARSER than the broker minimum: a broker
  // whose minimum lot is 0.001 obviously accepts 0.001 increments. Defaulting to
  // 0.01 there would reject its own valid minimum, so the step floor follows the
  // min downwards but never moves upwards (a 5-lot minimum does NOT imply a
  // 5-lot step).
  const stepFloor = min < LOT_STEP_DEFAULT ? min : LOT_STEP_DEFAULT
  const step = Number.isFinite(Number(opts.step)) && Number(opts.step) > 0 ? Number(opts.step) : stepFloor

  const t = raw == null ? '' : String(raw).trim()

  // Empty is a legitimate state: it means "fall back to balance x risk%".
  if (t === '') {
    if (opts.required) return { ok: false, value: null, error: 'Enter a lot size', empty: true }
    return { ok: true, value: null, error: null, empty: true }
  }

  if (!/^\d*\.?\d*$/.test(t)) {
    return { ok: false, value: null, error: 'Enter a number, e.g. 0.01', empty: false }
  }

  const n = Number(t)
  if (!Number.isFinite(n)) {
    return { ok: false, value: null, error: 'Enter a valid number', empty: false }
  }
  // Zero must be REJECTED, not coerced. "0 lots" is not tradeable and it is not
  // the same as "auto" — conflating the two is precisely the reported bug.
  if (n <= 0) {
    return { ok: false, value: null, error: 'Must be greater than 0, or leave empty for auto-sizing', empty: false }
  }
  if (n < min) {
    return { ok: false, value: null, error: `Minimum is ${min} lots`, empty: false }
  }
  if (n > max) {
    return { ok: false, value: null, error: `Maximum is ${max} lots`, empty: false }
  }

  // Step grid: allow a hair of float tolerance so 0.07 (0.01 x 7) never fails.
  const steps = Math.round(n / step)
  const snapped = steps * step
  if (Math.abs(snapped - n) > 1e-9) {
    return { ok: false, value: null, error: `Must be a multiple of ${step} lots`, empty: false }
  }

  return { ok: true, value: Number(snapped.toFixed(8)), error: null, empty: false }
}

/** Convenience for display: the text the field should show for a saved value. */
export function lotSizeToText(saved) {
  const n = Number(saved)
  return Number.isFinite(n) && n > 0 ? String(n) : ''
}
