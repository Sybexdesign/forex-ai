#!/usr/bin/env node
// scripts/outcome-backfill.mjs — Phase 3 materialisation of outcome_reconciliation
//
//   node scripts/outcome-backfill.mjs --dry-run            (default; prints summary only)
//   node scripts/outcome-backfill.mjs --commit --windowDays 30
//
// NEVER modifies source engines (prediction_logs/signals/signal_reconciliation/
// trades). It only INSERTS rows into the analytical outcome_reconciliation
// table, idempotently (upsert, ignore duplicates on setup_key).
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { linkRecords } from '../lib/outcome-linkage.mjs'
import { summarize, classifyRecord, diagnose } from '../lib/outcome-reconciliation.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const env = {}
for (const source of [path.join(root, '.env.local'), path.join(root, '.env')]) {
  if (!fs.existsSync(source)) continue
  for (const l of fs.readFileSync(source, 'utf8').split('\n')) {
    const m = l.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/); if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '')
  }
}
const URL = (env.SUPABASE_URL || env.NEXT_PUBLIC_SUPABASE_URL || '').replace(/\/$/, '')
const KEY = env.SUPABASE_SERVICE_ROLE_KEY
if (!URL || !KEY) { console.error('Missing SUPABASE env'); process.exit(2) }

const args = process.argv.slice(2)
const commit = args.includes('--commit')
const windowDays = (() => { const i = args.indexOf('--windowDays'); return i >= 0 ? Number(args[i + 1]) || 30 : 30 })()
const pair = (() => { const i = args.indexOf('--pair'); return i >= 0 ? args[i + 1] : undefined })()

const H = { apikey: KEY, Authorization: `Bearer ${KEY}` }
const since = new Date(Date.now() - windowDays * 86400_000).toISOString()
const tryFetch = async (path) => {
  const res = await fetch(`${URL}/rest/v1/${path}`, { headers: H })
  const body = await res.json().catch(() => null)
  return Array.isArray(body) ? body : null
}

console.log(`outcome-backfill · ${commit ? 'COMMIT' : 'DRY-RUN'} · window ${windowDays}d${pair ? ` · ${pair}` : ''}`)

// Attribution columns only exist after migration 20260912 — fall back to the
// legacy signals columns when they are absent so the dry-run still works.
let signals = await tryFetch(`signals?select=id,user_id,pair,direction,outcome,outcome_source,signal_label_outcome,signal_label_source,signal_label_resolved_at,created_at,candle_close_time&created_at=gte.${since}&order=candle_close_time.desc.nullslast&limit=5000`)
const attributionAvailable = signals !== null
if (!signals) signals = await tryFetch(`signals?select=id,user_id,pair,direction,outcome,created_at,candle_close_time&created_at=gte.${since}&order=candle_close_time.desc.nullslast&limit=5000`)
if (!signals) signals = []
const [predictions, reconciliations, trades] = await Promise.all([
  tryFetch(`prediction_logs?select=id,user_id,pair,direction,outcome,resolved_at,created_at,candle_close_time,entry&created_at=gte.${since}&order=created_at.desc&limit=5000`),
  tryFetch(`signal_reconciliation?select=id,user_id,pair,direction,outcome,entry_price,generated_at,resolved_at&generated_at=gte.${since}&order=generated_at.desc&limit=5000`),
  tryFetch(`trades?select=id,user_id,pair,direction,result,entry_price,opened_at,closed_at,pl_usd&opened_at=gte.${since}&order=opened_at.desc&limit=5000`),
])
if (!attributionAvailable) console.log('NOTE: signals attribution columns not present (migration 20260912 pending) — signal-label comparisons will be limited.')
const pools = { predictions, signals, reconciliations, trades }
if (pair) for (const k of Object.keys(pools)) pools[k] = (pools[k] || []).filter(x => x.pair === pair)
for (const k of Object.keys(pools)) pools[k] = pools[k] || []

const { records, ambiguousSkipped, linkedCounts } = linkRecords(pools)
const summary = summarize(records)
console.log('linkage:', JSON.stringify({ loaded: { p: predictions.length, s: signals.length, r: reconciliations.length, t: trades.length }, linkedCounts, ambiguousSkipped }))
console.log('summary:', JSON.stringify(summary, null, 2).slice(0, 4000))
console.log('fourEngine:', JSON.stringify(summary.fourEngine))
if (records.length) {
  console.log('first 5 records:')
  for (const r of records.slice(0, 5)) {
    console.log(' ', r.setupKey.slice(-40), 'p=' + r.prediction, 'label=' + r.signalLabel, 'recon=' + r.reconciliation, 'exec=' + r.execution, 'class=' + classifyRecord(r), 'why=' + JSON.stringify(diagnose(r)))
  }
}

if (!commit) { console.log('\nDRY-RUN complete — no writes. Re-run with --commit after migration 20260912 is applied.'); process.exit(0) }

// Insert into the analytical table (idempotent upsert, ignore duplicates).
const rows = records.map(r => ({
  user_id: r.user_id, pair: r.pair, direction: r.direction,
  signal_id: null, prediction_log_id: r.prediction_log_id, reconciliation_id: r.reconciliation_id ?? null,
  execution_id: r.execution_id ?? null, setup_key: r.setupKey,
  evaluated_candle_time: null, candle_close_time: r.candle_close_time ?? null, signal_created_at: r.signal_created_at ?? null,
  prediction_outcome: r.prediction, prediction_resolved_at: r.predictionResolvedAt ?? null,
  signal_label_outcome: r.signalLabel, signal_label_resolved_at: r.signalLabelResolvedAt ?? null,
  signal_label_source: r.signalLabelSource ?? null,
  reconciliation_outcome: r.reconciliation, reconciliation_resolved_at: r.reconciliationResolvedAt ?? null,
  execution_outcome: r.execution, execution_closed_at: r.executionClosedAt ?? null,
  execution_pnl_usd: r.executionPnl ?? null,
  agreement_class: classifyRecord(r),
  disagreement_reasons: diagnose(r),
  contract_versions: { prediction: 'prediction_v2_phase2', signal_label: 'label_legacy', reconciliation: 'reconcile_v1', execution: null },
}))
const cols = 'setup_key'
const res = await fetch(`${URL}/rest/v1/outcome_reconciliation?on_conflict=${cols}`, {
  method: 'POST',
  headers: { ...H, 'Content-Type': 'application/json', Prefer: 'resolution=ignore-duplicates,return=minimal' },
  body: JSON.stringify(rows),
})
if (!res.ok) { console.error('insert failed:', res.status, await res.text()); process.exit(1) }
console.log(`\nCOMMIT complete — inserted/ignored ${rows.length} analytical rows into outcome_reconciliation.`)
