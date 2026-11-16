// tests/ea-version.test.mjs
// EA build identity — the Broker Connection page must advertise the build the
// accounting actually requires, and must report the running build only from
// evidence the EA wrote.
//
// The defect this locks down: the page hard-coded "EA v9.3.1" in its setup copy
// and download link while the payload contract had already moved to v9.5, so an
// operator following the page installed a build that cannot produce the
// commission/swap/fee terms or the close ticket that Recent Trades needs.
//
// Run: npm run test:ea-version
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import {
  EA_BUILD, REQUIRED_FOR_NET_ACCOUNTING, REQUIRED_FOR_TICKET_CLOSES, BUILD_STATUS,
  parseEaBuild, extractReportedBuild, describeEaBuild,
} from '../lib/ea-version.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (p) => readFileSync(join(ROOT, p), 'utf8')

let groups = 0
const group = (name) => { groups++; console.log(`  ✓ ${name}`) }

// ── A — the shipped build is a real, downloadable file ──────────────────────
{
  assert.equal(EA_BUILD.version, '9.5')
  assert.equal(EA_BUILD.buildStamp, '9.50', 'A: the stamp matches what the EA writes')
  assert.equal(REQUIRED_FOR_NET_ACCOUNTING, '9.50', 'A: net accounting requires the stamped build')
  assert.equal(REQUIRED_FOR_TICKET_CLOSES, '9.50', 'A: so does ticket-stamped closes')
  assert.equal(existsSync(join(ROOT, 'public', EA_BUILD.fileName)), true,
    `A: public/${EA_BUILD.fileName} exists — the download link cannot 404`)
  assert.equal(EA_BUILD.downloadPath, '/' + EA_BUILD.fileName, 'A: link is derived from the file name')

  const ea = read(join('public', EA_BUILD.fileName))
  assert.ok(ea.includes('eaVersion'), 'A: the shipped EA stamps eaVersion')
  assert.ok(ea.includes('9.50'), 'A: with the 9.50 build number')
  assert.ok(ea.includes('executionPayloadVersion'), 'A: and the payload contract marker')
  assert.ok(ea.includes('ea_observed'), 'A: live closes are labelled witnessed')
  assert.ok(ea.includes('ea_recovered'), 'A: rebuilt closes are labelled recovered')

  // Top-level `eaVersion` is NOT the evidence the page can use: the sync RPC's
  // fixed-key write-back drops unknown payload fields, so a root-level stamp is
  // lost. Only the copy inside a position entry survives into
  // broker_configs.config.openPositions — which is why the page reads
  // openPositions and not the payload root.
  const prev = read('public/SybexForexAI_EA_v9.4.mq5')
  assert.ok(prev.includes('9.40'), 'A: v9.4 identifies itself at the payload root only')
  assert.equal(prev.includes('9.50'), false, 'A: v9.4 never reports 9.50')

  const count = (text) => (text.match(/eaVersion/g) || []).length
  assert.equal(count(prev), 1, 'A: v9.4 stamps eaVersion exactly once (payload root)')
  assert.ok(count(ea) >= 3, `A: v9.5 stamps every position/close entry too (found ${count(ea)})`)

  group('A — required build is the file we actually ship')
}

// ── B — version comparison is exact and refuses to invent a number ──────────
{
  const eq = (a, b) => assert.equal(parseEaBuild(a).build, parseEaBuild(b).build, `${a} === ${b}`)
  eq('9.5', '9.50')
  eq('v9.5', '9.50')
  eq(9.5, '9.50')

  assert.equal(parseEaBuild('9.3.1').build < parseEaBuild('9.50').build, true, 'B: 9.3.1 sorts below 9.5')
  assert.equal(parseEaBuild('9.4').build < parseEaBuild('9.50').build, true, 'B: 9.4 sorts below 9.5')
  assert.equal(parseEaBuild('9.6').build > parseEaBuild('9.50').build, true, 'B: a future build sorts above')

  for (const junk of [null, undefined, '', '   ', 'abc', 'v', '9.5.1.2', 'latest', {}, []]) {
    assert.equal(parseEaBuild(junk), null, `B: ${JSON.stringify(junk)} yields null, never a guess`)
  }

  group('B — comparison is exact; junk yields null')
}

// ── C — the verdict never claims more than the evidence supports ────────────
{
  assert.equal(describeEaBuild('9.50').status, BUILD_STATUS.CURRENT)
  assert.equal(describeEaBuild('9.50').isCurrent, true)
  assert.equal(describeEaBuild('9.40').status, BUILD_STATUS.OUTDATED)
  assert.equal(describeEaBuild('9.3.1').status, BUILD_STATUS.OUTDATED)
  assert.equal(describeEaBuild(null).status, BUILD_STATUS.UNKNOWN)
  assert.equal(describeEaBuild('garbage').status, BUILD_STATUS.UNKNOWN)

  // Silence is never "up to date".
  assert.equal(describeEaBuild(null).isCurrent, false, 'C: absent stamp is not current')
  assert.equal(describeEaBuild(undefined).reported, null, 'C: nothing is reported')

  const outdated = describeEaBuild('9.40')
  assert.match(outdated.detail, /gross-only|gross only/i, 'C: it says what is lost, not just "old"')
  assert.match(outdated.headline + outdated.detail, /9\.50|v9\.5/, 'C: it names the required build')

  const unknown = describeEaBuild(null)
  assert.match(unknown.detail, /cannot be proven/, 'C: unknown says why it is unknown')
  assert.match(unknown.detail, /Experts tab/, 'C: and how an operator settles it')

  group('C — CURRENT / OUTDATED / UNKNOWN, silence never reads as current')
}

// ── D — the reported build comes from the EA's own stored stamp ─────────────
{
  const fresh = extractReportedBuild([
    { symbol: 'EURUSD', eaVersion: '9.50', executionPayloadVersion: 2 },
    { symbol: 'GBPUSD', eaVersion: '9.50', executionPayloadVersion: 2 },
  ])
  assert.equal(fresh.version, '9.50')
  assert.equal(fresh.payloadVersion, 2)
  assert.equal(fresh.symbol, 'GBPUSD', 'D: the newest entry wins')

  // A stale array written by a pre-v9.5 build carries no entry-level stamp.
  assert.equal(extractReportedBuild([{ symbol: 'EURUSD', type: 'BUY' }]), null,
    'D: pre-v9.5 entries produce no build claim')
  assert.equal(extractReportedBuild([]), null, 'D: empty array produces no build claim')
  assert.equal(extractReportedBuild(undefined), null)
  assert.equal(extractReportedBuild({ eaVersion: '9.50' }), null, 'D: a non-array is not trusted')
  assert.equal(extractReportedBuild(['9.50', null, 42]), null, 'D: primitive entries are skipped')

  // Unstamped entries mixed with a stamped one: the stamp is still found.
  const mixed = extractReportedBuild([
    { symbol: 'EURUSD', eaVersion: '9.50', executionPayloadVersion: 2 },
    { symbol: 'GBPUSD' },
  ])
  assert.equal(mixed.version, '9.50', 'D: an unstamped tail does not hide the stamp')

  assert.equal(extractReportedBuild([{ symbol: 'XAUUSD', eaVersion: '9.40' }]).version, '9.40',
    'D: an older stamp is reported as-is, not corrected')
  assert.equal(describeEaBuild(extractReportedBuild([{ eaVersion: '9.40' }])).status, BUILD_STATUS.OUTDATED,
    'D: and it flows straight into the verdict')

  group('D — the stamp is read from stored state, nothing is inferred')
}

// ── E — the Broker Connection page reflects the required build ─────────────
{
  const page = read('components/pages/BrokerPage.tsx')

  assert.equal(/v9\.3\.1/.test(page), false, 'E: the stale build no longer appears anywhere on the page')
  assert.equal(/SybexForexAI_EA_v9\.3\.1\.mq5/.test(page), false, 'E: no download link to the old build')

  assert.match(page, /from '@\/lib\/ea-version\.mjs'/, 'E: the page uses the shared build identity')
  assert.match(page, /EA_BUILD\.downloadPath/, 'E: the download link is data, not a literal')
  assert.match(page, /EA_BUILD\.fileName/, 'E: the file name is data, not a literal')
  assert.match(page, /EA_BUILD\.expertsLogLine/, 'E: the Experts-tab proof line is data')
  assert.match(page, /describeEaBuild\(/, 'E: the page asks for a verdict')
  assert.match(page, /extractReportedBuild\(/, 'E: and derives it from the stored stamp')

  // The live row indicator and the accounting panel both exist.
  assert.match(page, /EA build not reported — gross-only/, 'E: an unstamped terminal is visible in the list')
  assert.match(page, /closes gross-only/, 'E: an outdated build is flagged in the list')
  assert.match(page, /BROKER-DEAL ACCOUNTING — EA BUILD/, 'E: the accounting panel is rendered')
  assert.match(page, /RESULT PENDING/, 'E: it names what Recent Trades shows meanwhile')

  // The page states the consequence rather than implying an optional upgrade.
  assert.match(page, /is <strong>required<\/strong>/, 'E: v9.5 is stated as required')

  group('E — the page advertises and reports the build the product requires')
}

// ── F — no EA verdict is shown for brokers that do not use the EA ──────────
{
  const page = read('components/pages/BrokerPage.tsx')
  // Both the panel and the row chip are gated on the MT5/Exness bridge, so an
  // OANDA / Capital / Alpaca config never shows an EA verdict.
  const gates = page.match(/broker_type === 'mt5direct' \|\| (activeConfig|cfg)\.broker_type === 'exness'/g) || []
  assert.ok(gates.length >= 2, `F: panel and row chip are both EA-gated (found ${gates.length})`)

  assert.match(page, /describeEaBuild\(isMt5 \?/, 'F: the row chip short-circuits for non-EA brokers')

  group('F — no EA verdict is shown for brokers that do not use the EA')
}

console.log(`\nea-version: ${groups} groups passed`)

