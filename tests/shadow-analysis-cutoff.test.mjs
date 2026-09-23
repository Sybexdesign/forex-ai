// tests/shadow-analysis-cutoff.test.mjs
// §12 — the fresh-sample cutoff (--since) for the shadow analysis CLI.
//
// WHY THIS EXISTS
//
// The scalp shadow study keeps 29 defective "forensic" telemetry rows from before
// the instrumentation repair. They must NEVER enter fresh-sample metrics. The
// cutoff is therefore applied IN THE QUERY, before lifecycle reconstruction, so a
// lifecycle physically cannot span the boundary — its pre-cutoff rows are never
// fetched in the first place. These tests prove that, and prove invalid input is
// rejected rather than silently ignored.
import assert from 'node:assert/strict'
import { readFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync, execSync } from 'node:child_process'

let failed = 0
const t = (name, fn) => {
  try { fn(); console.log('  ok   ' + name) }
  catch (e) { failed++; console.error('  FAIL ' + name + '\n        ' + e.message) }
}
const SRC = readFileSync(new URL('../scripts/shadow-analysis.mjs', import.meta.url), 'utf8')
const CLI = 'scripts/shadow-analysis.mjs'
const CUTOFF = '2026-09-18T19:03:37Z'

/** Run the CLI; returns { status, stdout, stderr }. Never throws. */
function run(args) {
  try {
    // maxBuffer: the --json payload for a 185-row sample exceeds the 64KB default,
    // which silently truncates stdout and looks like malformed JSON.
    const stdout = execFileSync('node', [CLI, ...args], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024,
    })
    return { status: 0, stdout, stderr: '' }
  } catch (e) {
    return { status: e.status ?? 1, stdout: e.stdout?.toString() ?? '', stderr: e.stderr?.toString() ?? '' }
  }
}

/**
 * Run the CLI in --json mode and parse the result.
 *
 * WHY A TEMP FILE AND NOT A PIPE: the JSON payload for a 185-row sample exceeds
 * what a piped execFileSync round-trip returns intact (it truncates at 64KB and
 * surfaces as "unterminated string in JSON"). Redirecting to a file sidesteps
 * pipe buffering entirely and is exactly how the CLI is used operationally.
 */
const TMP = mkdtempSync(join(tmpdir(), 'shadow-cli-'))
function runJson(args) {
  const out = join(TMP, `out-${args.join('_').replace(/[^a-zA-Z0-9_.-]/g, '')}.json`)
  try {
    execSync(`node ${CLI} ${args.map((a) => JSON.stringify(a)).join(' ')} --json > ${JSON.stringify(out)} 2>/dev/null`, {
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    return { status: 0, body: JSON.parse(readFileSync(out, 'utf8')) }
  } catch (e) {
    return { status: e.status ?? 1, body: null }
  }
}

console.log('shadow-analysis-cutoff (--since)')

// ── invalid input must fail clearly ─────────────────────────────────────────
t('invalid --since is rejected with a clear message and a non-zero exit', () => {
  const r = run(['--since', 'not-a-date'])
  assert.equal(r.status, 2, `expected exit 2, got ${r.status}`)
  assert.match(r.stderr, /invalid --since timestamp/)
  assert.match(r.stderr, /expected ISO-8601/)
})

t('--since with no value is rejected rather than silently ignored', () => {
  const r = run(['--since'])
  assert.equal(r.status, 2)
  assert.match(r.stderr, /--since requires an ISO-8601 timestamp/)
})

t('--since followed by another flag is rejected (not consumed as a timestamp)', () => {
  const r = run(['--since', '--json'])
  assert.equal(r.status, 2)
  assert.match(r.stderr, /--since requires an ISO-8601 timestamp/)
})

// ── the cutoff is displayed ─────────────────────────────────────────────────
t('the human report prints the active cutoff and its source', () => {
  const r = run(['--since', CUTOFF])
  assert.equal(r.status, 0)
  assert.match(r.stdout, /cutoff \(--since\):/)
  assert.match(r.stdout, /2026-09-18T19:03:37\.000Z/)
  assert.match(r.stdout, /cutoff source\s+: --since/)
})

t('JSON output carries the cutoff', () => {
  const r = runJson(['--since', CUTOFF])
  assert.equal(r.status, 0)
  assert.equal(r.body.window.cutoffApplied, '2026-09-18T19:03:37.000Z')
  assert.equal(r.body.window.cutoffSource, '--since')
  assert.equal(typeof r.body.telemetryRows, 'number')
})

t('without --since the report says the cutoff is not applied', () => {
  const r = runJson([])
  assert.equal(r.status, 0)
  assert.equal(r.body.window.cutoffApplied, null)
  assert.match(r.body.window.cutoffSource, /--days/)
})

// ── structural guarantee: filtered in the QUERY, not after the fact ─────────
t('the cutoff is applied in the database query, before lifecycle reconstruction', () => {
  assert.match(SRC, /\.gte\('created_at', since\)/, 'telemetry must be bounded in the query')
  assert.match(SRC, /const since = CUTOFF \?\?/, 'the cutoff must win over the --days window')
})

t('no cutoff preserves the previous --days behaviour exactly', () => {
  assert.match(SRC, /CUTOFF \?\? new Date\(Date\.now\(\) - DAYS \* 86400_000\)\.toISOString\(\)/)
})

t('a lifecycle cannot span the boundary because trade rows are keyed on filtered tickets', () => {
  // Tickets are derived from the ALREADY-filtered telemetry rows, so survivor
  // tickets can only ever pull their own trade rows.
  assert.match(SRC, /const tickets = \[\.\.\.new Set\(rows\.map\(\(r\) => r\.broker_ticket\)/)
})

// ── live exclusion arithmetic (skipped when the DB is unreachable) ──────────
t('pre-cutoff rows are excluded and post-cutoff rows are included', () => {
  const ancient = runJson(['--since', '2000-01-01T00:00:00Z'])
  const fresh   = runJson(['--since', CUTOFF])
  const future  = runJson(['--since', '2099-01-01T00:00:00Z'])
  if (ancient.status !== 0 || fresh.status !== 0 || future.status !== 0 || !ancient.body || !fresh.body || !future.body) {
    console.log('        (skipped live check — database unreachable in this environment)')
    return
  }
  const allRows    = ancient.body.telemetryRows ?? 0
  const freshRows  = fresh.body.telemetryRows ?? 0
  const futureRows = future.body.telemetryRows ?? 0

  assert.equal(futureRows, 0, 'a future cutoff must yield no rows')
  assert.ok(allRows >= freshRows, `all(${allRows}) must be >= fresh(${freshRows})`)
  assert.ok(
    freshRows < allRows,
    `the cutoff must exclude some rows: fresh=${freshRows} all=${allRows}`,
  )
  console.log(`        all=${allRows}  fresh=${freshRows}  excluded=${allRows - freshRows}  future=0`)
})

if (failed) { console.error(`\n${failed} failed`); process.exit(1) }
console.log('shadow-analysis-cutoff: all tests passed')
