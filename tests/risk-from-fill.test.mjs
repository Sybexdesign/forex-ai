// tests/risk-from-fill.test.mjs
// Phase 4.1E — actual filled-stop risk and realised R.
// Covers: fill differs from request (entry and SL), different contract specs,
// different volumes, stop moved to breakeven, partial close, missing tick value,
// missing initial SL, invalid risk denominator.
// Run: npm run test:risk-from-fill
import assert from 'node:assert/strict'
import {
  INSTRUMENT_SPECS, RISK_CALC_VERSION,
  aggregateRealisedR, correctRisk, realisedRFromFill, resolveSpec, riskFromFill,
} from '../lib/risk-from-fill.mjs'

// ── A — THE production pair: identical stored risk, different actual stops ──
{
  // Stored planned_risk_amount for BOTH tickets was $1,748.50.
  const t1 = riskFromFill({ pair: 'XAU/USD', filledEntry: 3988.692, initialSl: 3992.28, volume: 5 })
  const t2 = riskFromFill({ pair: 'XAU/USD', filledEntry: 3987.047, initialSl: 3990.81, volume: 5 })

  assert.equal(t1.status, 'OK', 'A')
  assert.equal(t2.status, 'OK', 'A')
  assert.equal(t1.riskAmount, 1794, 'A: ticket 3454451953 actual stop risk = $1,794.00')
  assert.equal(t2.riskAmount, 1881.5, 'A: ticket 3454458505 actual stop risk = $1,881.50')
  assert.notEqual(t1.riskAmount, t2.riskAmount, 'A: different actual stops cannot inherit identical risk')
  console.log('PASS A: actual-filled risk differs per ticket ($1,794.00 vs $1,881.50)')
}

// ── B — realised R uses the correct denominator ─────────────────────────────
{
  // Stored production value: 3368.50 / 1748.50 = 1.9265 (wrong denominator).
  const stored = Math.round((3368.5 / 1748.5) * 10000) / 10000
  assert.equal(stored, 1.9265, 'B: reproduces the stored figure')

  const correct = realisedRFromFill({ netPnl: 3368.5, initialRisk: 1881.5 })
  assert.equal(correct, 1.7903, 'B: correct R with the actual filled-stop risk')
  assert.notEqual(correct, stored, 'B: the correction is material')

  const loser = realisedRFromFill({ netPnl: -175.5, initialRisk: 1794 })
  assert.equal(loser, -0.0978, 'B: losing trade R')
  console.log('PASS B: realised R corrected from +1.9265 to +1.7903 for ticket 3454458505')
}

// ── C — requested entry differing from the fill ─────────────────────────────
{
  const c = riskFromFill({
    pair: 'XAU/USD', requestedEntry: 3987.05, filledEntry: 3988.692,
    requestedSl: 3990.81, initialSl: 3992.28, volume: 5,
  })
  assert.equal(c.riskAmount, 1794, 'C: the FILL governs, not the request')
  assert.equal(c.distance, 3.588, 'C')
  assert.equal(c.pips, 35.88, 'C: XAU pip size 0.1')
  console.log('PASS C: a re-anchored fill changes the risk, and the fill wins')
}

// ── D — instrument-specific contract specifications ─────────────────────────
{
  const gold = riskFromFill({ pair: 'XAU/USD', filledEntry: 2000, initialSl: 1990, volume: 1 })
  const silver = riskFromFill({ pair: 'XAG/USD', filledEntry: 25, initialSl: 24.5, volume: 1 })
  const eur = riskFromFill({ pair: 'EUR/USD', filledEntry: 1.1, initialSl: 1.095, volume: 1 })

  assert.equal(gold.riskAmount, 1000, 'D: XAU 100 pips x $10')
  assert.equal(silver.riskAmount, 2500, 'D: XAG 50 pips x $50')
  assert.equal(eur.riskAmount, 500, 'D: EUR 50 pips x $10')
  assert.notEqual(gold.riskAmount, eur.riskAmount, 'D: specs are not interchangeable')
  assert.equal(resolveSpec('USD/JPY').valuePerPip, 6.8, 'D: JPY spec')
  assert.equal(resolveSpec('NAS100').valuePerPip, 1, 'D: index spec')
  console.log('PASS D: contract specifications are per-instrument')
}

// ── E — volume scales risk linearly ─────────────────────────────────────────
{
  const one = riskFromFill({ pair: 'XAU/USD', filledEntry: 2000, initialSl: 1990, volume: 1 }).riskAmount
  const five = riskFromFill({ pair: 'XAU/USD', filledEntry: 2000, initialSl: 1990, volume: 5 }).riskAmount
  assert.equal(one, 1000, 'E')
  assert.equal(five, 5000, 'E')
  assert.equal(five, one * 5, 'E: linear in volume')
  console.log('PASS E: risk scales with executed volume')
}

// ── F — a stop moved to breakeven must not rewrite initial risk ─────────────
{
  const initial = riskFromFill({ pair: 'XAU/USD', filledEntry: 3987.047, initialSl: 3990.81, volume: 5 })
  const afterMove = riskFromFill({ pair: 'XAU/USD', filledEntry: 3987.047, initialSl: 3987.047, volume: 5 })
  assert.equal(initial.riskAmount, 1881.5, 'F: initial risk captured at fill')
  assert.equal(afterMove.status, 'INCOMPLETE', 'F: a zero-distance current SL is not a valid risk anchor')
  assert.equal(afterMove.reason, 'ZERO_STOP_DISTANCE', 'F')
  assert.notEqual(afterMove.riskAmount, 0, 'F: never silently becomes zero risk')
  console.log('PASS F: a moved stop cannot masquerade as the initial risk anchor')
}

// ── G — explicit incompleteness instead of invented numbers ─────────────────
{
  assert.equal(riskFromFill({ pair: 'XAU/USD', filledEntry: 2000, volume: 1 }).reason, 'MISSING_INITIAL_STOP', 'G')
  assert.equal(riskFromFill({ pair: 'XAU/USD', initialSl: 1990, volume: 1 }).reason, 'MISSING_FILLED_ENTRY', 'G')
  assert.equal(riskFromFill({ pair: 'XAU/USD', filledEntry: 2000, initialSl: 1990 }).reason, 'MISSING_OR_INVALID_VOLUME', 'G')
  assert.equal(riskFromFill({ filledEntry: 2000, initialSl: 1990, volume: 1 }).reason, 'MISSING_INSTRUMENT_SPEC', 'G')
  assert.equal(
    riskFromFill({ pair: 'XAU/USD', filledEntry: 2000, initialSl: 1990, volume: 1, spec: { pipSize: 0, valuePerPip: 10 } }).reason,
    'INVALID_INSTRUMENT_SPEC', 'G: missing tick value is explicit')
  console.log('PASS G: every missing input produces a named INCOMPLETE, never a guess')
}

// ── H — invalid denominators yield NULL, never a fallback estimate ─────────
{
  assert.equal(realisedRFromFill({ netPnl: 100, initialRisk: 0 }), null, 'H')
  assert.equal(realisedRFromFill({ netPnl: 100, initialRisk: null }), null, 'H')
  assert.equal(realisedRFromFill({ netPnl: null, initialRisk: 500 }), null, 'H')
  assert.equal(realisedRFromFill({ netPnl: 100, initialRisk: -50 }), null, 'H')
  console.log('PASS H: invalid risk denominator returns NULL (no requested-risk substitution)')
}

// ── I — realised R aggregates across partial closes on ONE risk ────────────
{
  const agg = aggregateRealisedR({ dealNetPnls: [100, -20, 40], initialRisk: 200 })
  assert.equal(agg, 0.6, 'I: (100-20+40)/200')
  // Averaging per-deal R would have produced (0.5 -0.1 +0.2)/3 = 0.2 — wrong.
  assert.notEqual(agg, 0.2, 'I: risk is counted once, not per deal')
  assert.equal(aggregateRealisedR({ dealNetPnls: [100], initialRisk: 0 }), null, 'I')
  console.log('PASS I: partial-close R divides the summed P&L by the single initial risk')
}

// ── J — historical correction preserves the original value ─────────────────
{
  const j = correctRisk({ stored: 1748.5, computed: 1881.5, source: 'mt5_deal_open_price', ticket: '3454458505' })
  assert.equal(j.originalRiskAmount, 1748.5, 'J: original preserved')
  assert.equal(j.correctedRiskAmount, 1881.5, 'J')
  assert.equal(j.corrected, true, 'J')
  assert.equal(j.correctedVersion, RISK_CALC_VERSION, 'J')
  assert.equal(j.originalVersion, 'orders_requested_pips_v0', 'J: provenance of the old value recorded')

  const same = correctRisk({ stored: 100, computed: 100 })
  assert.equal(same.corrected, false, 'J: no spurious correction')
  console.log('PASS J: corrections are additive evidence, never an in-place overwrite')
}

console.log('\nrisk-from-fill: 10/10 groups passed')

