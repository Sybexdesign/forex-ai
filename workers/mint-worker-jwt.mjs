#!/usr/bin/env node
// workers/mint-worker-jwt.mjs
//
// One-time helper: mints a Supabase-compatible HS256 JWT that authenticates as
// WORKER_USER_ID, so the background worker (workers/scalper.mjs) can call
// /api/account and /api/orders and have getBroker() resolve the per-user
// broker_configs row.
//
// Usage:
//   SUPABASE_JWT_SECRET=... WORKER_USER_ID=... node workers/mint-worker-jwt.mjs
//
// Optional:
//   WORKER_JWT_TTL_DAYS=365     # default 365 days
//
// Output: prints the JWT on stdout. Set it on your worker host as
// WORKER_SERVICE_JWT. Rotate by re-running before expiry.
//
// Where to find SUPABASE_JWT_SECRET:
//   Supabase Dashboard → Project Settings → API → JWT Settings → "JWT Secret"
//   (NOT the anon key, NOT the service role key — the JWT signing secret.)

import { createHmac } from 'node:crypto'

const SECRET   = process.env.SUPABASE_JWT_SECRET
const SUB      = process.env.WORKER_USER_ID
const TTL_DAYS = parseInt(process.env.WORKER_JWT_TTL_DAYS || '365', 10)

if (!SECRET) {
  console.error('error: SUPABASE_JWT_SECRET is required')
  console.error('       Supabase Dashboard → Settings → API → JWT Settings → JWT Secret')
  process.exit(1)
}
if (!SUB) {
  console.error('error: WORKER_USER_ID is required (the auth.users UUID this token impersonates)')
  process.exit(1)
}

function b64url(input) {
  return Buffer.from(input).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_')
}

const now = Math.floor(Date.now() / 1000)
const exp = now + TTL_DAYS * 86400

const header  = { alg: 'HS256', typ: 'JWT' }
const payload = {
  aud:  'authenticated',
  role: 'authenticated',
  sub:  SUB,
  iat:  now,
  exp,
}

const data      = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`
const signature = createHmac('sha256', SECRET).update(data).digest('base64')
  .replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_')

const jwt = `${data}.${signature}`

console.error(`[mint] sub=${SUB} exp=${new Date(exp * 1000).toISOString()} ttl=${TTL_DAYS}d`)
console.error('[mint] Set this on your worker host as WORKER_SERVICE_JWT:')
console.error('')
process.stdout.write(jwt + '\n')
