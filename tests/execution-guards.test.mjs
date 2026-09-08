// tests/execution-guards.test.mjs
// Production hardening — pre-execution guards + Fixed-USD independence.
// Run: npm run test:execution-guards
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  signalMaxAgeSeconds, entryDriftPctLimit, computeDriftPct, evaluateExecutionGuards,
} from '../lib/execution-guards.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const T0 = 1_800_000_000_000  // fixed "now" for determinism
const run = (over) => evaluateExecutionGuards({ nowMs: T0, ...over })

// Fresh signal → accepted
{
  const g = run({ signalAtMs: T0 - 10_000, referencePrice: 4400, livePrice: 4401 })
  assert.equal(g.ok, true)
  console.log('PASS : fresh signal accepted by freshness layer')
}

// Signal older than TTL → stale_signal
{
  const g = run({ signalAtMs: T0 - (signalMaxAgeSeconds() + 5) * 1000, referencePrice: 4400, livePrice: 4400 })
  assert.equal(g.ok, false)
  assert.equal(g.gate, 'stale_signal')
  console.log('PASS : stale_signal rejected with exact reason')
}

// Duplicate OPEN signal → duplicate_signal
{
  const g = run({ signalAtMs: T0 - 1000, referencePrice: 4400, livePrice: 4400, signalRef: 'worker-x-1', openTradeExists: true })
  assert.equal(g.ok, false)
  assert.equal(g.gate, 'duplicate_signal')
  console.log('PASS : duplicate_signal rejected when an OPEN trade exists for the signal')
}

// Entry within drift tolerance → accepted
{
  const ref = 4400
  const limit = entryDriftPctLimit()
  const g = run({ signalAtMs: T0 - 1000, referencePrice: ref, livePrice: ref * (1 + (limit / 100) * 0.5) })
  assert.equal(g.ok, true)
  console.log('PASS : entry within drift tolerance accepted')
}

// Entry beyond drift tolerance → entry_drift
{
  const ref = 4400
  const limit = entryDriftPctLimit()
  const g = run({ signalAtMs: T0 - 1000, referencePrice: ref, livePrice: ref * (1 + (limit / 100) * 2) })
  assert.equal(g.ok, false)
  assert.equal(g.gate, 'entry_drift')
  console.log('PASS : entry_drift rejected with exact reason')
}

// Missing optional freshness metadata → backward compatible (accepted)
{
  const g = run({})  // no signal_at, no prices, no signalRef
  assert.equal(g.ok, true)
  console.log('PASS : missing optional freshness metadata is backward compatible (accepted)')
}

// BUY/SELL drift calculation — symmetric (sign-independent)
{
  const ref = 4400
  const up = ref * 1.002
  const down = ref * 0.998
  assert.ok(Math.abs(computeDriftPct(ref, up) - computeDriftPct(ref, down)) < 1e-9,
    'BUY and SELL drift magnitudes identical')
  console.log('PASS : BUY/SELL drift calculation symmetric (absolute % drift)')
}

// TTL config: shared authoritative env/default = 150s, drift default = 0.25%
{
  assert.equal(signalMaxAgeSeconds(), 150)
  assert.equal(entryDriftPctLimit(), 0.25)
  console.log('PASS : SIGNAL_MAX_AGE_SECONDS=150 and SIGNAL_ENTRY_DRIFT_PCT=0.25 defaults')
}

// Fixed USD Target independence: guards never consider fixedUsd
{
  const base = run({ signalAtMs: T0 - 1000, referencePrice: 4400, livePrice: 4400.2 })
  const withFixed = run({ signalAtMs: T0 - 1000, referencePrice: 4400, livePrice: 4400.2, fixedUsdTarget: 0 })
  const withFixedSet = run({ signalAtMs: T0 - 1000, referencePrice: 4400, livePrice: 4400.2, fixedUsdTarget: 50 })
  assert.deepEqual(base, withFixed, 'fixedUsdTarget=0 does not block execution')
  assert.deepEqual(base, withFixedSet, 'fixedUsdTarget>0 does not alter signal eligibility')
  const guardSrc = readFileSync(path.join(root, 'lib', 'execution-guards.mjs'), 'utf8')
  assert.ok(!guardSrc.includes('fixedUsd'), 'guard module never references fixed USD')
  const ordersSrc = readFileSync(path.join(root, 'app', 'api', 'orders', 'route.ts'), 'utf8')
  const guardBlock = ordersSrc.slice(ordersSrc.indexOf('evaluateExecutionGuards'), ordersSrc.indexOf('Account protection'))
  assert.ok(!guardBlock.includes('fixedProfitUsd'), 'fixed-USD is not consulted inside the execution guard')
  console.log('PASS : FIXED USD TARGET=0 does NOT block orders; >0 does not change eligibility (management-only feature)')
}

console.log('\nAll execution-guard (production hardening) tests passed.')
