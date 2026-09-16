#!/usr/bin/env node
// scripts/pp-observation-report.mjs
// ── PROFIT-PROTECTION SHADOW OBSERVATION REPORT (read-only) ─────────────────
//
// Collects the Phase-4 gate answers from production data, reusing the SAME
// analysis code the admin endpoint uses (lib/profit-telemetry.mjs) rather than a
// parallel implementation, so the report cannot disagree with the product's own
// summary.
//
// Answers:
//   Q1  Did TRADE_FIRST_SEEN occur promptly? (broker appearance → discovery)
//   Q2  What did live protection vs shadow MFE look like across the lifecycle?
//   Q3  Was closure/reconciliation detected and persisted?
//   Q4  Does MFE improve the large-MFE → excessive-giveback class without
//       over-tightening healthy ATR runners?
// and prints the per-lifecycle tuple:
//   peakR → highest floor → realised → shadow estimate → capture efficiency
//
// READ-ONLY: GET requests only. No broker call, no write.
//
// Usage: node --import ./scripts/test-ts-register.mjs scripts/pp-observation-report.mjs [days]
import { readFileSync, existsSync } from 'node:fs'
import { closeSummaryFromRows, aggregateTrades, ZONE_LABEL } from '../lib/profit-telemetry.mjs'

// Credentials: environment first; .env.local only as a local convenience.
function creds() {
  let url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
  let key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if ((!url || !key) && existsSync('.env.local')) {
    const env = {}
    for (const l of readFileSync('.env.local', 'utf8').split('\n')) {
      const m = l.match(/^([A-Z0-9_]+)=(.*)$/)
      if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '').trim()
    }
    url = url || env.NEXT_PUBLIC_SUPABASE_URL
    key = key || env.SUPABASE_SERVICE_ROLE_KEY
  }
  if (!url || !key) { console.error('missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY'); process.exit(1) }
  return { url, key }
}

const DAYS = Number(process.argv[2] || 14)
const { url, key } = creds()
const H = { apikey: key, Authorization: `Bearer ${key}` }
const since = new Date(Date.now() - DAYS * 864e5).toISOString()

// ── ACCOUNT SCOPE ───────────────────────────────────────────────────────────
// A native MT5 ticket is unique WITHIN an account, not across accounts. Every
// per-trade query below is therefore scoped to the account under observation
// when one is configured, so a second terminal (or another broker's ticket
// numbering) cannot enter this report. Unscoped only when no identity is
// configured — and that is stated in the output rather than assumed.
const SCOPE_USER = (process.env.MT5_SERVER_USER_ID || process.env.WORKER_USER_ID || '').trim() || null
const scope = SCOPE_USER ? `&user_id=eq.${SCOPE_USER}` : ''

const get = async (path) => {
  const r = await fetch(`${url}/rest/v1/${path}`, { headers: H })
  let body = null
  try { body = await r.json() } catch { /* ignore */ }
  return { ok: r.ok, status: r.status, body }
}
const count = async (path) => {
  const r = await fetch(`${url}/rest/v1/${path}`, { headers: { ...H, Prefer: 'count=exact', Range: '0-0' } })
  return (r.headers.get('content-range') || '').split('/')[1] ?? '?'
}

console.log(`PROFIT PROTECTION — SHADOW OBSERVATION REPORT (last ${DAYS} days, read-only)\n`)
console.log(`account scope        : ${SCOPE_USER ? SCOPE_USER : 'ALL ACCOUNTS (no MT5_SERVER_USER_ID/WORKER_USER_ID set — ticket collisions across accounts are possible)'}\n`)

// ── Telemetry ──────────────────────────────────────────────────────────────
const rows = (await get(`profit_protection_telemetry?select=*&created_at=gte.${since}${scope}&order=created_at.asc&limit=10000`)).body || []
console.log(`telemetry rows in window : ${rows.length}`)
if (rows.length) {
  const byMode = {}, byKind = {}
  for (const r of rows) { byMode[r.protection_mode] = (byMode[r.protection_mode] || 0) + 1
                          byKind[r.row_kind] = (byKind[r.row_kind] || 0) + 1 }
  console.log(`  by protection_mode     : ${JSON.stringify(byMode)}`)
  console.log(`  by row_kind            : ${JSON.stringify(byKind)}`)
  console.log(`  shadow_command_emitted=true : ${rows.filter((r) => r.shadow_command_emitted === true).length}  (MUST be 0 while SHADOW)`)
}

// ── Q1/Q3 from the observer's own diagnostics ──────────────────────────────
console.log('\n── OBSERVER HEALTH (Q1 discovery, Q3 closure) ──')
for (const term of ['OBSERVER_RUNNING', 'TRADE_FIRST_SEEN', 'AWAITING_CLOSE_CONFIRMATION', 'STATE_INITIALISED',
                    'STATE_RESTORED', 'STATE_LOAD_FAILED', 'TELEMETRY_PERSISTED', 'TELEMETRY_FAILED']) {
  const n = await count(`worker_logs?select=id&created_at=gte.${since}&message=ilike.*${encodeURIComponent(term)}*`)
  console.log(`  ${term.padEnd(30)} ${n}`)
}

// ── Is observation running, and is it order-bound? ─────────────────────────
const orderRows = await count(`worker_logs?select=id&created_at=gte.${since}&message=ilike.*auto-trade*`)
const trades = await get(`trades?select=id,created_at,source&created_at=gte.${since}${scope}&order=created_at.asc&limit=500`)
const tradeRows = Array.isArray(trades.body) ? trades.body : []
console.log(`  order/exec rows             : ${orderRows}`)
console.log(`  trades opened in window     : ${tradeRows.length}  (scalp: ${tradeRows.filter((t) => t.source === 'scalp').length})`)


// ── Q2/Q4 + the per-lifecycle tuple ───────────────────────────────────────
console.log('\n── LIFECYCLES (Q2 live vs shadow, Q4 MFE improvement) ──')
if (!rows.length) {
  console.log('  No telemetry rows yet — no lifecycle can be summarised.')
  console.log('  EXPECTED if no eligible scalp position has occurred since deployment.')
} else {
  const keys = [...new Set(rows.map((r) => r.broker_ticket).filter(Boolean))]
  const summaries = keys.map((k) => closeSummaryFromRows(rows.filter((r) => r.broker_ticket === k)))
  console.log('  ticket    zone      peakR  highestFloor  realised$  shadowEst$  capture  shadowCapture  closed  emitted')
  for (const s of summaries) {
    const tr = rows.filter((r) => r.broker_ticket === s.brokerTicket)
    const peakR = Math.max(...tr.map((r) => Number(r.peak_r) || 0), 0)
    const f = (v) => (v === null || v === undefined ? '—' : v)
    console.log(`  ${String(s.brokerTicket).padEnd(8)}  ${String(s.zoneLabel).padEnd(8)}  ${peakR.toFixed(2).padStart(5)}  ${String(f(s.highestTargetFloorUsd)).padStart(11)}  ${String(f(s.actualRealisedPnlUsd)).padStart(9)}  ${String(f(s.estShadowPnlUsd)).padStart(10)}  ${String(f(s.actualCaptureEfficiency)).padStart(7)}  ${String(f(s.estShadowCaptureEfficiency)).padStart(13)}  ${String(!!s.firstWouldCloseAt).padStart(6)}  ${String(s.shadowCommandEmitted).padStart(7)}`)
  }
  console.log('\n── SAMPLE AGGREGATE ──')
  console.log(JSON.stringify(aggregateTrades(summaries), null, 2))
  console.log(`\n  zones: ${Object.entries(ZONE_LABEL).map(([k, v]) => `${k}=${v}`).join('  ')}`)
  console.log(`  lifecycles collected: ${summaries.length} / 15 required for the gate`)
}

// ── Phase-4 gate summary ──────────────────────────────────────────────────
const firstSeen = await count(`worker_logs?select=id&created_at=gte.${since}&message=ilike.*TRADE_FIRST_SEEN*`)
const awaiting  = await count(`worker_logs?select=id&created_at=gte.${since}&message=ilike.*AWAITING_CLOSE_CONFIRMATION*`)
const lives = rows.length ? [...new Set(rows.map((r) => r.broker_ticket).filter(Boolean))].length : 0
console.log('\n── PHASE-4 GATE ──')
console.log(`  Q1 TRADE_FIRST_SEEN events                 : ${firstSeen}`)
console.log(`  Q3 AWAITING_CLOSE_CONFIRMATION events      : ${awaiting}`)
console.log(`  Q2/Q4 summarisable lifecycles              : ${lives} / 15`)
console.log(`  shadow_command_emitted=true (must be 0)    : ${rows.filter((r) => r.shadow_command_emitted === true).length}`)
// ── PHASE 3.3.1 — NATIVE-TICKET ACCEPTANCE CHAIN ──────────────────────────
// The identity repair is only proven by ONE natural position completing this
// whole chain. Until it does, observation evidence must not be counted.
//
//   1 completed.id                     = APP_UUID
//   2 completed.ticket                 = NATIVE_POSITION_TICKET
//   3 trade located by oanda_trade_id  = APP_UUID
//   4 broker_ticket                    = NATIVE_POSITION_TICKET
//   5 /api/account openTrade.id        = same NATIVE_POSITION_TICKET
//   6 attribution count                = 1 of 1
//   7 TRADE_FIRST_SEEN
//   8 durable scalpShadowState contains the ticket
//
// Steps 1-2 live in the Vercel function log for /api/mt5-sync, emitted as a
// SANITISED line (`[native-ticket] <id-prefix>… → <ticket>`) — grep it there.
// Steps 3-8 are reconstructible from the data below.
const NATIVE_RE = /^\d+$/

const scalpRows = (await get(`trades?select=id,oanda_trade_id,broker_ticket,source,result,created_at`
  + `&source=eq.scalp&created_at=gte.${since}${scope}&order=created_at.asc&limit=500`)).body || []
const nativeFills = scalpRows.filter((t) => NATIVE_RE.test(String(t.broker_ticket ?? '')))
const ambiguous   = scalpRows.filter((t) => !NATIVE_RE.test(String(t.broker_ticket ?? '')))

console.log('\n── PHASE 3.3.1 NATIVE-TICKET CHAIN ──')
console.log(`  scalp rows in window                : ${scalpRows.length}`)
console.log(`  step 3+4 native broker_ticket       : ${nativeFills.length}   (post-fix fills)`)
console.log(`  not native (legacy / fail-closed)   : ${ambiguous.length}   (never attributable)`)

// Step 8 — is the ticket present in the durable observer state?
let stateTickets = []
try {
  const cfg = await get(`broker_configs?is_active=eq.true&limit=1&select=config`)
  const state = (cfg.body?.[0]?.config || {}).scalpShadowState
  if (state && typeof state === 'object') stateTickets = Object.keys(state)
  console.log(`  step 8 scalpShadowState tickets     : ${stateTickets.length ? stateTickets.join(', ') : '(empty / not readable)'}`)
} catch { console.log('  step 8 scalpShadowState tickets     : (not readable)') }

// Step 2/7 — the observer's own discovery log, and the acceptance instant.
const seenLogs = (await get(`worker_logs?select=created_at,message&created_at=gte.${since}`
  + `&message=ilike.*TRADE_FIRST_SEEN*&order=created_at.asc&limit=100`)).body || []
const notAttributed = await count(`worker_logs?select=id&created_at=gte.${since}&message=ilike.*attributable to source*`)
console.log(`  step 6 attribution log lines        : ${notAttributed}   ("N of M open position(s) attributable")`)
console.log(`  step 7 TRADE_FIRST_SEEN events      : ${seenLogs.length}`)

// OBSERVATION_PERIOD_START — the FIRST discovery at/after the first native fill.
const firstFillAt = nativeFills[0]?.created_at || null
const acceptance  = firstFillAt ? seenLogs.find((l) => l.created_at >= firstFillAt) : null
console.log(`  first native-ticket fill            : ${firstFillAt || '— none yet —'}`)
console.log(`  OBSERVATION_PERIOD_START candidate  : ${acceptance?.created_at || '— NOT ESTABLISHED —'}`)

// The 15-lifecycle counter only counts AFTER acceptance; even then it is the
// operator's decision to reset it (this script never writes).
const counted = rows.filter((r) => !acceptance || r.created_at >= acceptance.created_at)
const countedTickets = [...new Set(counted.map((r) => r.broker_ticket).filter(Boolean))]
console.log('\n── ACCEPTANCE-GATED EVIDENCE COUNTER ──')
console.log(`  lifecycles since acceptance         : ${countedTickets.length} / 15`)
console.log(`  (lifecycles before acceptance are NOT counted — reset to 0/15 at the timestamp above)`)
console.log(`  state: ${acceptance
  ? 'CHAIN ACCEPTED — set OBSERVATION_PERIOD_START and begin the 15-lifecycle period'
  : 'NOT READY FOR SHADOW OBSERVATION PERIOD'}`)

console.log('\n  Read-only: no broker call, no write. Re-run over the observation period.')
