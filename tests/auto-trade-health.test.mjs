// tests/auto-trade-health.test.mjs
// Phase I — account-specific Data Health classifier (pure, deterministic).
// Run: npm run test:auto-trade-health
import assert from 'node:assert/strict'
import { classifyAutoTradeHealth } from '../lib/auto-trade-health.mjs'

const NOW = 1_800_000_000_000
const S = 1000, M = 60 * S, H = 3600 * S, D = 24 * H
const cfg = (id, opts = {}) => ({
  id,
  isActive: opts.isActive !== undefined ? opts.isActive : true,
  lastSyncMs: opts.ageSec !== undefined ? NOW - opts.ageSec * S : NOW - 60 * S,
})
const base = (over = {}) => classifyAutoTradeHealth({
  nowMs: NOW,
  accounts: over.accounts,
  workerLastSeenMs: NOW - 10 * S,
  lastSigCheckMs: NOW - 30 * S,
  marketOpen: true,
  events: { lastSignalMs: NOW - 120 * S, lastActionableMs: null, lastHoldMs: NOW - 120 * S, lastOrderMs: null },
  gates: { staleCandleSkip: 0, staleSignalReject: 0, duplicateSignalReject: 0, entryDriftReject: 0 },
  ...over,
})

// 1 fresh active account → HEALTHY
{
  const h = base({ accounts: [cfg('fresh-1', { ageSec: 60 })] })
  assert.equal(h.status, 'HEALTHY')
  assert.equal(h.marketData.fresh, true)
  assert.equal(h.marketData.accountCount, 1)
  assert.equal(h.accounts[0].account, 'acct-1')
  console.log('PASS : 1 fresh active account → HEALTHY')
}

// 1 fresh + 1 stale active account → WARNING (fresh primary must not mask sibling)
{
  const h = base({ accounts: [cfg('fresh-1', { ageSec: 60 }), cfg('stale-1', { ageSec: 3600 })] })
  assert.equal(h.status, 'WARNING')
  assert.equal(h.marketData.fresh, true, 'primary is fresh')
  assert.equal(h.marketData.staleActiveAccounts, 1)
  assert.equal(h.accounts.length, 2)
  console.log('PASS : 1 fresh + 1 stale active account → WARNING (sibling not masked)')
}

// selected stale configId → MARKET DATA STALE
{
  const h = base({ configId: 'stale-1', accounts: [cfg('fresh-1', { ageSec: 60 }), cfg('stale-1', { ageSec: 3600 })] })
  assert.equal(h.status, 'MARKET DATA STALE')
  assert.equal(h.marketData.fresh, false)
  assert.equal(h.scope.mode, 'config')
  assert.equal(h.marketData.account, 'acct-2', 'selected stale account is the primary')
  console.log('PASS : selected stale configId → MARKET DATA STALE for that account')
}

// selected fresh configId → account-specific healthy status
{
  const h = base({ configId: 'fresh-1', accounts: [cfg('fresh-1', { ageSec: 45 }), cfg('stale-1', { ageSec: 3600 })] })
  assert.equal(h.status, 'HEALTHY')
  assert.equal(h.marketData.account, 'acct-1')
  console.log('PASS : selected fresh configId → HEALTHY for that account')
}

// inactive stale account must NOT degrade active-account trading health
{
  const h = base({ accounts: [cfg('fresh-1', { ageSec: 60 }), cfg('old-inactive', { isActive: false, ageSec: 7 * D })] })
  assert.equal(h.status, 'HEALTHY', 'inactive stale account must not degrade health')
  assert.equal(h.marketData.accountCount, 2)
  assert.equal(h.marketData.activeAccountCount, 1)
  assert.equal(h.marketData.staleActiveAccounts, 0)
  assert.equal(h.marketData.staleInactiveAccounts, 1)
  assert.equal(h.accounts[1].isActive, false)
  console.log('PASS : inactive stale account does not degrade active-account health (still listed)')
}

// multiple active accounts → each returned independently in accounts[]
{
  const h = base({ accounts: [cfg('a', { ageSec: 30 }), cfg('b', { ageSec: 60 }), cfg('c', { ageSec: 90 })] })
  assert.equal(h.accounts.length, 3)
  assert.deepEqual(h.accounts.map((a) => a.account), ['acct-1', 'acct-2', 'acct-3'])
  assert.ok(h.accounts.every((a) => a.fresh && a.isActive))
  assert.ok(h.accounts[2].feedAgeSec > h.accounts[0].feedAgeSec, 'independent per-account feed ages')
  console.log('PASS : multiple active accounts listed independently in accounts[]')
}

// Worker offline takes precedence
{
  const h = base({ accounts: [cfg('fresh-1', { ageSec: 60 })], workerLastSeenMs: NOW - 400 * S })
  assert.equal(h.status, 'WORKER OFFLINE')
  console.log('PASS : stale worker heartbeat → WORKER OFFLINE (even with fresh feed)')
}

// Engine stalled only when no signal evaluation during open market
{
  const h = base({ accounts: [cfg('fresh-1', { ageSec: 60 })], lastSigCheckMs: NOW - 400 * S })
  assert.equal(h.status, 'SIGNAL ENGINE STALLED')
  console.log('PASS : no signal check >300s during open market → SIGNAL ENGINE STALLED')
}

// HOLD evaluation is healthy, never a stall
{
  const h = base({ accounts: [cfg('fresh-1', { ageSec: 60 })], events: { lastSignalMs: NOW - 10 * S, lastHoldMs: NOW - 10 * S, lastActionableMs: null, lastOrderMs: null } })
  assert.equal(h.status, 'HEALTHY')
  assert.equal(h.signals.engineRunning, true)
  assert.equal(h.signals.lastActionableAt, null)
  console.log('PASS : engine evaluating → HOLD is healthy (engineRunning true, status HEALTHY)')
}

// Market closed is not a stall
{
  const h = base({ accounts: [cfg('fresh-1', { ageSec: 60 })], marketOpen: false, lastSigCheckMs: NOW - 10 * M })
  assert.equal(h.status, 'HEALTHY')
  assert.ok(/Market closed/.test(h.signals.note))
  console.log('PASS : market closed → no signal evaluation is expected, not a stall')
}

// Distinct observable counters pass through (Phase J split)
{
  const h = base({ accounts: [cfg('fresh-1', { ageSec: 60 })], gates: { staleCandleSkip: 9, staleSignalReject: 1, duplicateSignalReject: 0, entryDriftReject: 2 } })
  assert.equal(h.execution.staleCandleSkipCount, 9)
  assert.equal(h.execution.staleSignalRejectCount, 1)
  assert.equal(h.execution.duplicateSignalRejectCount, 0)
  assert.equal(h.execution.entryDriftRejectCount, 2)
  console.log('PASS : stale candle skips and order-level rejections are distinct counters')
}

// PII — raw config/user ids never leak to clients
{
  const h = base({ configId: 'raw-fresh-1', accounts: [cfg('raw-fresh-1', { ageSec: 60 }), cfg('raw-stale-1', { ageSec: 2 * H })] })
  const json = JSON.stringify(h)
  assert.ok(!json.includes('raw-fresh-1') === false || h.scope.configId === 'raw-fresh-1', 'selector echoed only when caller supplied it')
  assert.equal(h.scope.configId, 'raw-fresh-1', 'explicit selector is echoed (caller already knows it)')
  const body = JSON.stringify({ accounts: h.accounts, marketData: h.marketData, worker: h.worker })
  assert.ok(!body.includes('raw-fresh-1') && !body.includes('raw-stale-1'), 'raw ids not leaked in public blocks')
  assert.ok(!body.includes('user_id') && !body.includes('lastSyncMs'), 'internal raw fields not leaked')
  console.log('PASS : account rows are anonymised (acct-<n>); no raw config/user ids exposed')
}

console.log('\nAll auto-trade-health classifier tests passed.')

