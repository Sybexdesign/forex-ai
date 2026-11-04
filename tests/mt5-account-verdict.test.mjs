// tests/mt5-account-verdict.test.mjs
// The "EA is online but the account shows $0" report.
//
// Live evidence from the reported account (login 134374547 @ Exness-MT5Real9):
// the EA pushes every ~30s with prices for 11 pairs and 44 candle sets, while
// balance and equity are both "0.00". The old wording guessed at a demo account
// and read `updatedAt` from the page-load snapshot, so it could call a dead EA
// "online". These assertions pin the two claims that matter:
//   1. a stale push is NEVER called online;
//   2. a fresh push with zero balance says WHICH account reported zero, and does
//      not blame the EA for a problem the EA is demonstrably not having.
import assert from 'node:assert/strict'
import {
  diagnoseBrokerConnection, describeAge, ACCOUNT_VERDICT, EA_STALE_AFTER_MS,
} from '../lib/mt5-account-verdict.mjs'

let failed = 0
const t = (name, fn) => {
  try { fn(); console.log('  ok   ' + name) }
  catch (e) { failed++; console.error('  FAIL ' + name + '\n        ' + e.message) }
}

const NOW = Date.parse('2026-11-03T23:50:00.000Z')
const pushAgo = (ms) => new Date(NOW - ms).toISOString()

// The reported account, exactly as it appears in broker_configs.config.
const REPORTED = {
  isMt5: true,
  brokerName: 'MT5 Direct',
  balance: 0,
  equity: 0,
  currency: 'GBP',
  login: '134374547',
  server: 'Exness-MT5Real9',
  lastSyncAt: pushAgo(6_000),
  priceSymbols: 11,
  candleSets: 44,
  nowMs: NOW,
}

console.log('mt5 account verdict')

t('zero balance on a fresh push is a WARNING, not "connected"', () => {
  const v = diagnoseBrokerConnection(REPORTED)
  assert.equal(v.level, ACCOUNT_VERDICT.WARN)
  assert.ok(!v.message.startsWith('✓'), 'must not be reported as connected')
})

t('zero balance names the account that reported it', () => {
  const { message } = diagnoseBrokerConnection(REPORTED)
  assert.match(message, /login 134374547 @ Exness-MT5Real9/)
  assert.match(message, /balance GBP 0\.00/)
})

t('zero balance does not blame the EA when market data is arriving', () => {
  const { message } = diagnoseBrokerConnection(REPORTED)
  assert.match(message, /EA is online \(synced 6s ago\)/)
  assert.match(message, /prices for 11 pairs/)
  assert.match(message, /44 candle sets/)
  assert.match(message, /account-side, not EA-side/)
})

t('zero balance no longer claims the account is a demo', () => {
  const { message } = diagnoseBrokerConnection(REPORTED)
  assert.doesNotMatch(message, /demo/i)
})

t('market data unknown → still says the EA is online, without inventing feeds', () => {
  const { message } = diagnoseBrokerConnection({ ...REPORTED, priceSymbols: 0, candleSets: 0 })
  assert.match(message, /EA is online \(synced 6s ago\)\./)
  assert.doesNotMatch(message, /pushing/)
})

t('equity differs from balance → both are shown', () => {
  const { message } = diagnoseBrokerConnection({ ...REPORTED, equity: -12.5 })
  assert.match(message, /equity GBP -12\.50/)
})

t('a stale push is NEVER called online', () => {
  const v = diagnoseBrokerConnection({ ...REPORTED, lastSyncAt: pushAgo(EA_STALE_AFTER_MS + 60_000) })
  assert.equal(v.level, ACCOUNT_VERDICT.WARN)
  assert.match(v.message, /last synced 6m ago and appears offline/)
  assert.doesNotMatch(v.message, /online/)
})

t('a funded account on a fresh push is OK and carries the account label', () => {
  const v = diagnoseBrokerConnection({ ...REPORTED, balance: 12.36, equity: 12.36 })
  assert.equal(v.level, ACCOUNT_VERDICT.OK)
  assert.match(v.message, /^✓ Connected — GBP 12\.36 via MT5 Direct/)
  assert.match(v.message, /login 134374547 @ Exness-MT5Real9/)
})

t('never-synced EA gets the setup checklist', () => {
  const v = diagnoseBrokerConnection({ ...REPORTED, lastSyncAt: null, login: '', server: '' })
  assert.equal(v.level, ACCOUNT_VERDICT.WARN)
  assert.match(v.message, /has not synced yet/)
  assert.match(v.message, /Allow WebRequest/)
})

t('unreadable timestamp is offline, not online', () => {
  const v = diagnoseBrokerConnection({ ...REPORTED, lastSyncAt: 'not-a-date' })
  assert.equal(v.level, ACCOUNT_VERDICT.WARN)
  assert.match(v.message, /unreadable timestamp/)
})

t('api error short-circuits everything else', () => {
  const v = diagnoseBrokerConnection({ ...REPORTED, error: 'boom' })
  assert.equal(v.level, ACCOUNT_VERDICT.ERROR)
  assert.equal(v.message, '✕ Error: boom')
})

t('non-mt5 broker with zero balance still points at credentials', () => {
  const v = diagnoseBrokerConnection({ isMt5: false, brokerName: 'OANDA', balance: 0 })
  assert.equal(v.level, ACCOUNT_VERDICT.WARN)
  assert.match(v.message, /check your broker API credentials/)
})

t('describeAge: seconds under 90s, then minutes', () => {
  assert.equal(describeAge(6_000), '6s ago')
  assert.equal(describeAge(89_000), '89s ago')
  assert.equal(describeAge(90_000), '2m ago')
  assert.equal(describeAge(6 * 60_000), '6m ago')
  assert.equal(describeAge(NaN), 'just now')
})

t('a push that died days ago says days, not thousands of minutes', () => {
  const v = diagnoseBrokerConnection({ ...REPORTED, lastSyncAt: pushAgo(6 * 24 * 3_600_000) })
  assert.equal(v.level, ACCOUNT_VERDICT.WARN)
  assert.match(v.message, /last synced 6d ago and appears offline/)
})

t('hours are used between 90 minutes and 48 hours', () => {
  assert.match(diagnoseBrokerConnection({ ...REPORTED, lastSyncAt: pushAgo(5 * 3_600_000) }).message, /5h ago/)
})

if (failed) {
  console.error(`\n${failed} failed`)
  process.exit(1)
}
console.log('\nall mt5-account-verdict assertions passed')
