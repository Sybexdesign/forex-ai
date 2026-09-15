// tests/lot-size.test.mjs
// Manual lot size input — the reported "reverts to 0" bug and its validation.
//
// The bug was a controlled numeric input that normalised on every keystroke:
// `parseFloat('')` -> NaN -> "not set" -> `?? 0` -> the box slammed a literal 0
// back, and `Math.min(0.50, v)` made 1 and 1.25 untypable. The fix separates the
// editing draft (a string) from the committed value (number|null), which is what
// these tests exercise.
import assert from 'node:assert/strict'
import {
  validateLotSize, isPartialLotInput, lotSizeToText,
  LOT_MIN_DEFAULT, LOT_MAX_DEFAULT, LOT_STEP_DEFAULT,
} from '../lib/lot-size.mjs'

let failed = 0
const t = (name, fn) => {
  try { fn(); console.log('  ok   ' + name) }
  catch (e) { failed++; console.error('  FAIL ' + name + '\n        ' + e.message) }
}

console.log('lot-size')

// ── 1-5. Editing ergonomics (the reported bug) ───────────────────────────────
t('1. delete the existing 0 → field stays empty (does NOT revert to 0)', () => {
  const res = validateLotSize('')
  assert.equal(res.ok, true, 'empty is a legitimate state')
  assert.equal(res.empty, true)
  assert.equal(res.value, null, 'empty commits as null (use auto), never 0')
  // The rendered text for that committed value must itself be empty, so the
  // `?? 0` regression cannot reappear.
  assert.equal(lotSizeToText(res.value), '')
})

t('2. type 0.5 from an empty field', () => {
  // Every keystroke of the sequence must be accepted as partial input, or the
  // handler would reject/normalise mid-edit.
  for (const partial of ['0', '0.', '0.5']) assert.equal(isPartialLotInput(partial), true, partial)
  const res = validateLotSize('0.5')
  assert.equal(res.ok, true)
  assert.equal(res.value, 0.5)
})

t('3. replace 0.5 with 1 (and 1.25) without the UI restoring 0', () => {
  assert.equal(validateLotSize('').value, null)
  const one = validateLotSize('1')
  assert.equal(one.ok, true, '1 must be allowed — the old max={0.50} blocked it')
  assert.equal(one.value, 1)
  for (const partial of ['1', '1.', '1.2', '1.25']) assert.equal(isPartialLotInput(partial), true, partial)
  assert.equal(validateLotSize('1.25').value, 1.25)
})

t('4. backspace works normally (every prefix of a value is valid partial input)', () => {
  for (const s of ['1.25', '1.2', '1.', '1', '', '0', '0.5']) {
    assert.equal(isPartialLotInput(s), true, `prefix "${s}"`)
  }
})

t('5. decimal input works, including values that used to be clamped away', () => {
  for (const [text, want] of [['0.01', 0.01], ['0.10', 0.1], ['0.50', 0.5], ['2.75', 2.75], ['10', 10]]) {
    const res = validateLotSize(text)
    assert.equal(res.ok, true, `${text} should be valid`)
    assert.equal(res.value, want, `${text} -> ${want}`)
  }
})

// ── 6-8. Validation must reject loudly, never silently become 0 ──────────────
t('6. invalid text cannot be saved and says why', () => {
  for (const bad of ['abc', '1.2.3', '1,5', '-1', '1e3', '+2']) {
    const res = validateLotSize(bad)
    assert.equal(res.ok, false, `"${bad}" must be rejected`)
    assert.ok(res.error, `"${bad}" must carry a message`)
    assert.equal(res.value, null)
  }
})

t('7. zero is REJECTED, never silently coerced to auto', () => {
  const res = validateLotSize('0')
  assert.equal(res.ok, false, '0 lots is not tradeable and is not the same as auto')
  assert.equal(res.value, null)
  assert.match(res.error, /greater than 0/)
  assert.equal(validateLotSize('0.00').ok, false)
  assert.equal(validateLotSize('0.0').ok, false)
})

t('8. min / max / step are enforced, and are overridable per instrument', () => {
  assert.equal(validateLotSize('0.001').ok, false, 'below minimum')
  assert.match(validateLotSize('0.001').error, /Minimum/)
  assert.equal(validateLotSize('10.01').ok, false, 'above maximum')
  assert.match(validateLotSize('10.01').error, /Maximum/)
  assert.equal(validateLotSize('0.015').ok, false, 'off the step grid (above min)')
  assert.match(validateLotSize('0.015').error, /multiple of/)

  // Broker/instrument override — the brief requires respecting those limits.
  assert.equal(validateLotSize('0.001', { min: 0.001 }).ok, true, 'a broker with a 0.001 min')
  assert.equal(validateLotSize('100', { max: 100 }).ok, true)
  assert.equal(validateLotSize('0.1', { step: 0.1 }).ok, true)
  assert.equal(validateLotSize('0.15', { step: 0.1 }).ok, false)

  // Step tolerance: exact multiples must not fail on float error.
  for (const v of ['0.01', '0.02', '0.03', '0.07', '1.25', '9.99']) {
    assert.equal(validateLotSize(v).ok, true, `${v} is an exact 0.01 multiple`)
  }
})

t('8b. constants match the platform ceilings', () => {
  assert.equal(LOT_MIN_DEFAULT, 0.01)
  assert.equal(LOT_MAX_DEFAULT, 10, 'must mirror MAX_LOTS in lib/trade-levels.ts')
  assert.equal(LOT_STEP_DEFAULT, 0.01)
})

// ── 9-10. Persistence round-trip ─────────────────────────────────────────────
t('9. existing saved values load into the field correctly', () => {
  assert.equal(lotSizeToText(0.5), '0.5')
  assert.equal(lotSizeToText(1), '1')
  assert.equal(lotSizeToText(1.25), '1.25')
  // auto / unset / garbage all render as an EMPTY field, never "0".
  for (const v of [null, undefined, 0, NaN, -1, '']) {
    assert.equal(lotSizeToText(v), '', `${String(v)} must render empty, not 0`)
  }
})

t('10. save and reopen preserves the value (draft -> committed -> draft)', () => {
  for (const text of ['0.01', '0.5', '1', '1.25', '10']) {
    const committed = validateLotSize(text)
    assert.equal(committed.ok, true, text)
    const reopened = lotSizeToText(committed.value)
    const again = validateLotSize(reopened)
    assert.equal(again.ok, true, `round-trip ${text}`)
    assert.equal(again.value, committed.value, `round-trip ${text} must be stable`)
  }
  const cleared = validateLotSize('')
  assert.equal(cleared.value, null)
  assert.equal(lotSizeToText(cleared.value), '')
})

t('required=true rejects empty (when manual sizing must be present)', () => {
  const res = validateLotSize('', { required: true })
  assert.equal(res.ok, false)
  assert.match(res.error, /Enter a lot size/)
})

t('whitespace-only is treated as empty, not invalid', () => {
  const res = validateLotSize('   ')
  assert.equal(res.ok, true)
  assert.equal(res.empty, true)
})

if (failed) { console.error(`\n${failed} failed`); process.exit(1) }
console.log('lot-size: all tests passed')

