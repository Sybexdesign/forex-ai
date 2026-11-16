// tests/security-diagnostics.test.mjs
// ─────────────────────────────────────────────────────────────────────────────
// SEC-1 — `GET /api/production-integrity` was readable by anyone who knew the
// URL, and answered with the firm's trading performance, accounting counts,
// reconciliation age and `cronSecretConfigured`.
//
// This suite freezes the decision:
//   * the authorisation classifier never approves an unverifiable credential,
//   * an unconfigured secret never opens the endpoint (no development escape),
//   * the unauthenticated body carries NO numbers and NO status,
//   * the route authorises BEFORE it reads the database,
//   * the failure path no longer puts raw driver text in `error`.
//
// Run: npm run test:security
// ─────────────────────────────────────────────────────────────────────────────
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  bearerToken,
  classifyDiagnosticsCaller,
  restrictedDiagnosticsBody,
} from '../lib/diagnostics-auth.mjs'

const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8')

/** Minimal Headers stand-in: the module only ever calls `.get('authorization')`. */
const headers = (value) => ({ get: (name) => (String(name).toLowerCase() === 'authorization' ? value : null) })

const SECRET = 's3cr3t-operator-value-0001'
const ENV = { CRON_SECRET: SECRET }

// ── 1 — Bearer parsing is strict ─────────────────────────────────────────────
{
  assert.equal(bearerToken(headers(`Bearer ${SECRET}`)), SECRET, '1: standard Bearer parses')
  assert.equal(bearerToken(headers(`bearer ${SECRET}`)), SECRET, '1: scheme is case-insensitive')
  assert.equal(bearerToken(headers(`  Bearer   ${SECRET}  `)), SECRET, '1: padding is tolerated')
  assert.equal(bearerToken(headers(null)), '', '1: absent header yields empty token')
  assert.equal(bearerToken(headers('Basic abc123')), '', '1: a non-Bearer scheme is not a token')
  assert.equal(bearerToken(headers('Bearer')), '', '1: a bare scheme presents no credential')
  assert.equal(bearerToken(undefined), '', '1: missing headers object is handled')
  console.log('PASS SEC-1.1: only a Bearer value is ever treated as a credential')
}

// ── 2 — No credential → not authorised ──────────────────────────────────────
{
  const c = classifyDiagnosticsCaller({ headers: headers(null), env: ENV })
  assert.equal(c.method, 'none', '2: anonymous callers are classified as none')
  assert.equal(c.authorised, false, '2: and are not authorised')
  assert.match(c.reason, /no credentials/i, '2: the reason is explicit')
  console.log('PASS SEC-1.2: an anonymous request is never authorised')
}

// ── 3 — The operator secret authorises ──────────────────────────────────────
{
  const c = classifyDiagnosticsCaller({ headers: headers(`Bearer ${SECRET}`), env: ENV })
  assert.equal(c.method, 'operator_secret', '3: exact match is the operator secret')
  assert.equal(c.authorised, true, '3: and authorises the payload')
  console.log('PASS SEC-1.3: the operator secret is accepted without a database round trip')
}

// ── 4 — A wrong or absent secret never authorises, and learns nothing ───────
{
  const wrongSameLength = classifyDiagnosticsCaller({
    headers: headers(`Bearer ${'x'.repeat(SECRET.length)}`),
    env: ENV,
  })
  assert.equal(wrongSameLength.authorised, false, '4: a same-length wrong secret is rejected')

  const wrongLength = classifyDiagnosticsCaller({ headers: headers('Bearer short'), env: ENV })
  assert.equal(wrongLength.authorised, false, '4: a short wrong secret is rejected')

  // The rejection must not distinguish "wrong secret" from "not a credential":
  // either wording would turn the endpoint into an oracle for guessing.
  assert.equal(wrongSameLength.reason, wrongLength.reason,
    '4: rejections are indistinguishable from unrecognised credentials')
  assert.doesNotMatch(wrongSameLength.reason, /secret|wrong|mismatch/i,
    '4: the reason never confirms a secret exists')

  const prefix = classifyDiagnosticsCaller({ headers: headers(`Bearer ${SECRET.slice(0, -1)}`), env: ENV })
  assert.equal(prefix.authorised, false, '4: a prefix of the secret is rejected')
  console.log('PASS SEC-1.4: no near-miss, prefix or same-length guess is accepted')
}

// ── 5 — An unconfigured secret CLOSES the endpoint ──────────────────────────
{
  // The C-2 lesson: an unset secret must block, never fall open. There is no
  // NODE_ENV branch here, so a misconfigured deployment returns 401 to everyone
  // including the operator — loud and safe, instead of silent and open.
  for (const env of [{}, { CRON_SECRET: '' }, { CRON_SECRET: undefined }]) {
    const c = classifyDiagnosticsCaller({ headers: headers('Bearer anything-at-all'), env })
    assert.notEqual(c.method, 'operator_secret', '5: an unset/empty secret cannot match')
    assert.equal(c.authorised, false, '5: unconfigured deployment authorises nobody')
  }
  console.log('PASS SEC-1.5: a missing CRON_SECRET fails closed, with no development escape hatch')
}

// ── 6 — A session token is a CANDIDATE, never an approval ───────────────────
{
  const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhYmMifQ.c2lnbmF0dXJlLXZhbHVl'
  const c = classifyDiagnosticsCaller({ headers: headers(`Bearer ${jwt}`), env: ENV })
  assert.equal(c.method, 'admin_jwt', '6: a JWT-shaped token is passed to the route for verification')
  assert.equal(c.authorised, false, '6: the classifier never approves it by itself')
  assert.match(c.reason, /must be verified/i, '6: and says so')
  assert.equal(c.token, jwt, '6: the token is returned so the route can verify it')

  // Shape, not contents: two segments is not a JWT and gets no special handling.
  const notJwt = classifyDiagnosticsCaller({ headers: headers('Bearer header.payload'), env: ENV })
  assert.equal(notJwt.method, 'none', '6: a two-segment token is just an unrecognised credential')

  // Expected consequence: a token with a short segment is rejected WITHOUT a
  // Supabase call. That is the anti-amplifier guard — every `admin_jwt` costs an
  // auth round trip, so junk must not be able to trigger one.
  const stub = classifyDiagnosticsCaller({ headers: headers('Bearer a.b.c'), env: ENV })
  assert.equal(stub.method, 'none', '6: a stub token never reaches the auth service')
  console.log('PASS SEC-1.6: an admin session still has to be resolved to the admin user by the route')
}

// ── 7 — The unauthenticated body contains nothing derived from data ─────────
{
  const body = restrictedDiagnosticsBody()

  for (const forbidden of [
    'overallStatus', 'checks', 'analytics', 'tradingSessionEvidence', 'reconciliation',
    'generatedAt', 'windowDays', 'counts', 'net', 'gross', 'buckets', 'winRate',
    'maxDrawdown', 'cronSecretConfigured', 'ageHours', 'totalRows', 'detail',
  ]) {
    assert.equal(Object.prototype.hasOwnProperty.call(body, forbidden), false,
      `7: the restricted body must not expose "${forbidden}"`)
  }

  // Strongest form: no number of any kind may appear at the top level. A count,
  // a percentage or an age would each be a number.
  for (const [k, v] of Object.entries(body)) {
    assert.ok(!(typeof v === 'number'), `7: "${k}" is a number — counts must not leak`)
    assert.ok(['string', 'boolean'].includes(typeof v), `7: "${k}" is not a primitive`)
  }

  assert.equal(body.authenticationRequired, true, '7: the caller is told why')
  assert.equal(body.readOnly, true, '7: and that nothing was written')
  assert.match(body.note, /Bearer/, '7: the accepted credential is documented in the response')
  console.log('PASS SEC-1.7: a 401 body reveals no status, no count, no figure and no config state')
}


// ── 8 — The route authorises BEFORE it reads ────────────────────────────────
{
  const route = read('app/api/production-integrity/route.ts')

  const gate = route.indexOf('classifyDiagnosticsCaller(')
  // Anchored on the handler's own first query, not the `countOf` helper that
  // happens to be defined above it.
  const firstRead = route.indexOf("const evRes = await admin.from('trades')")
  assert.ok(gate > 0, '8: the route delegates to the shared classifier')
  assert.ok(firstRead > 0, '8: the route still reads trades inside the handler')
  assert.ok(gate < firstRead, '8: authorisation precedes the first database read')

  assert.match(route, /status: 401/, '8: an unauthenticated caller gets 401')
  assert.match(route, /WWW-Authenticate/, '8: with a Bearer challenge')
  assert.match(route, /restrictedDiagnosticsBody\(\)/, '8: and the restricted body')
  assert.match(route, /authorise BEFORE any read/i, '8: the ordering is documented in the route')
  assert.match(route, /export async function GET\(req: NextRequest\)/, '8: the handler reads the request headers')
  console.log('PASS SEC-1.8: no query runs before authorisation')
}

// ── 9 — The failure path no longer echoes the driver ────────────────────────
{
  const route = read('app/api/production-integrity/route.ts')
  assert.doesNotMatch(route, /error: error\?\.message/,
    '9: raw PostgREST text is not returned as the stable error field')
  assert.match(route, /error: 'inspection failed'/, '9: a stable error code is returned')
  assert.match(route, /detail: error\?\.message/, '9: and the driver text is confined to `detail`')
  console.log('PASS SEC-1.9: schema-revealing error text is separated from the stable error code')
}

// ── 10 — No forbidden fallback creeps back in ───────────────────────────────
{
  const route = read('app/api/production-integrity/route.ts')
  // The string may appear in prose (the check detail says the forgeable header is
  // no longer accepted); what must never appear is a READ of it.
  assert.doesNotMatch(route, /headers\??\.get\(\s*['"`]x-vercel-cron['"`]/,
    '10: the forgeable cron header is never read')
  assert.doesNotMatch(route, /NODE_ENV?[^\n]*development/i,
    '10: there is no development bypass in the endpoint')
  assert.doesNotMatch(route, /secret\s*=\s*searchParams|searchParams\.get\('?secret/,
    '10: the secret is never accepted from a query string')
  console.log('PASS SEC-1.10: no header, environment or query-string fallback exists')
}

console.log('\nSEC-1: production diagnostics require authentication; anonymous callers receive nothing.')

