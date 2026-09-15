#!/usr/bin/env node
// scripts/shadow-analysis.mjs
//
// READ-ONLY report for the profit-protection shadow study.
//
//   node scripts/shadow-analysis.mjs                # source='scalp' (the worker path)
//   node scripts/shadow-analysis.mjs --all          # every source
//   node scripts/shadow-analysis.mjs --days 30      # widen/lower the window
//   node scripts/shadow-analysis.mjs --json         # machine-readable
//
// Joins profit_protection_telemetry to trades on broker_ticket (preferred) and
// trade_id, reusing lib/profit-telemetry.mjs for the ACTUAL vs COUNTERFACTUAL
// per-trade summaries and lib/shadow-analysis.mjs for classification and the
// study report.
//
// It performs NO writes and cannot affect trading. When there is no telemetry
// it says so and exits 0 — an empty sample is a valid, reportable state.

import { readFileSync } from 'node:fs'
import { createClient } from '@supabase/supabase-js'
import { closeSummaryFromRows } from '../lib/profit-telemetry.mjs'
import { buildReport, ZONE_ORDER } from '../lib/shadow-analysis.mjs'

const args = process.argv.slice(2)
const asJson = args.includes('--json')
const includeAllSources = args.includes('--all')
const daysArg = args.indexOf('--days')
const DAYS = daysArg >= 0 ? Math.max(1, Math.min(365, Number(args[daysArg + 1]) || 90)) : 90

const env = Object.fromEntries(
  readFileSync(new URL('../.env.local', import.meta.url), 'utf8')
    .split('\n')
    .filter((l) => l.includes('=') && !l.trim().startsWith('#'))
    .map((l) => {
      const i = l.indexOf('=')
      return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')]
    }),
)

const db = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
})

/** Paged read — Supabase caps a single response, so a study sample must page. */
async function readAll(table, build, { pageSize = 1000, max = 50000 } = {}) {
  const out = []
  for (let from = 0; from < max; from += pageSize) {
    const { data, error } = await build(db.from(table)).range(from, from + pageSize - 1)
    if (error) throw new Error(`${table}: ${error.message}`)
    if (!data?.length) break
    out.push(...data)
    if (data.length < pageSize) break
  }
  return out
}

const since = new Date(Date.now() - DAYS * 86400_000).toISOString()

const rows = await readAll('profit_protection_telemetry', (q) =>
  q.select('*').gte('created_at', since).order('created_at', { ascending: true }),
)

if (!rows.length) {
  const payload = {
    generatedAt: new Date().toISOString(),
    state: 'NO TELEMETRY',
    windowDays: DAYS,
    message:
      'profit_protection_telemetry has no rows in this window. Nothing to analyse — the shadow study cannot start until the trade path that places these trades writes telemetry.',
    shadowCommandEmittedCount: 0,
    note: 'Zero rows means shadow_command_emitted=false passes VACUOUSLY; it is not evidence the module is safe.',
  }
  console.log(asJson ? JSON.stringify(payload, null, 2) : formatEmpty(payload))
  process.exit(0)
}

// ── Join to trades ────────────────────────────────────────────────────────────
const tickets = [...new Set(rows.map((r) => r.broker_ticket).filter((t) => t != null).map(String))]
const tradeIds = [...new Set(rows.map((r) => r.trade_id).filter((t) => t != null).map(String))]

const trades = []
for (let i = 0; i < tickets.length; i += 200) {
  const { data } = await db
    .from('trades')
    .select('id,broker_ticket,source,pl_usd,mfe_usd,direction,pair,closed_at,result')
    .in('broker_ticket', tickets.slice(i, i + 200))
  trades.push(...(data || []))
}
if (tradeIds.length) {
  const { data } = await db
    .from('trades')
    .select('id,broker_ticket,source,pl_usd,mfe_usd,direction,pair,closed_at,result')
    .in('id', tradeIds.slice(0, 500))
  trades.push(...(data || []))
}

const byTicket = new Map()
const byTradeId = new Map()
for (const t of trades) {
  if (t.broker_ticket != null) byTicket.set(String(t.broker_ticket), t)
  if (t.id != null) byTradeId.set(String(t.id), t)
}

/** Match on ticket first, then trade_id — either may be null early in a lifecycle. */
const tradeFor = (key, groupRows) => {
  if (key && !String(key).startsWith('row:')) {
    const byT = byTicket.get(String(key))
    if (byT) return byT
  }
  for (const r of groupRows) {
    if (r.trade_id != null && byTradeId.has(String(r.trade_id))) return byTradeId.get(String(r.trade_id))
  }
  return null
}

const groups = new Map()
for (const r of rows) {
  const key = r.broker_ticket != null ? String(r.broker_ticket) : `row:${r.id}`
  if (!groups.has(key)) groups.set(key, [])
  groups.get(key).push(r)
}

const summaries = []
// RAW chronological rows for the trades we actually report on. The lifecycle /
// clipping analysis needs the trajectory AFTER a WOULD_CLOSE, and a per-trade
// summary has already collapsed that to a single number — so it cannot be
// reconstructed from `summaries` and must be carried through separately.
const reportRows = []
let unmatched = 0
for (const [key, groupRows] of groups) {
  const trade = tradeFor(key, groupRows)
  if (!trade) { unmatched += 1; continue }
  if (!includeAllSources && String(trade.source) !== 'scalp') continue
  const summary = closeSummaryFromRows(groupRows, {
    actualRealisedPnlUsd: trade.pl_usd != null ? Number(trade.pl_usd) : undefined,
    actualMfeUsd: trade.mfe_usd != null ? Number(trade.mfe_usd) : undefined,
  })
  summaries.push({ ...summary, tradeId: trade.id, source: trade.source, result: trade.result, closedAt: trade.closed_at })
  reportRows.push(...groupRows)
}

const report = buildReport(summaries, {
  windowDays: DAYS,
  sourceFilter: includeAllSources ? 'ALL' : 'scalp',
  telemetryRows: rows.length,
  unmatchedTelemetryGroups: unmatched,
  // Raw rows → lifecycleOutcomesByTicket → clippingReport.
  rows: reportRows,
})

/** Human-readable report. Formatting only — every number comes from buildReport. */
function formatReport(r) {
  const L = []
  L.push('=============================================================')
  L.push(' PROFIT PROTECTION SHADOW STUDY — COUNTERFACTUAL / ESTIMATED')
  L.push('=============================================================')
  L.push(`generated      : ${r.generatedAt}`)
  L.push(`window         : last ${r.windowDays} days`)
  L.push(`source filter  : ${r.sourceFilter}`)
  L.push(`telemetry rows : ${r.telemetryRows}  (unmatched groups: ${r.unmatchedTelemetryGroups})`)

  L.push('')
  L.push('--- SHADOW SAFETY ---')
  L.push(`shadow_command_emitted = true : ${r.shadowSafety.shadowCommandEmittedCount}`)
  L.push(`verdict                       : ${r.shadowSafety.verdict}`)
  if (r.shadowSafety.tickets.length) L.push(`tickets                       : ${r.shadowSafety.tickets.join(', ')}`)

  L.push('')
  L.push('--- SAMPLE ---')
  L.push(`trades (joined)   : ${r.sample.tradeCount}`)
  L.push(`comparable        : ${r.sample.comparableCount}`)
  L.push(`BUY / SELL        : ${r.sample.buy} / ${r.sample.sell}`)
  L.push(`actual source     : ${r.sample.brokersRealised} broker-realised, ${r.sample.decisionTimeOnly} decision-time only`)

  L.push('')
  L.push('--- FINANCIAL ---')
  L.push(`ACTUAL    total realised      : $${r.actual.totalRealisedPnlUsd}   (${r.actual.winners}W / ${r.actual.losers}L)`)
  L.push(`ESTIMATED counterfactual      : $${r.estShadow.totalPnlUsd}   [${r.estShadow.label}]`)
  L.push(`ESTIMATED delta               : $${r.estShadow.estimatedDeltaUsd}`)

  L.push('')
  L.push('--- CLASSIFICATIONS ---')
  for (const [k, v] of Object.entries(r.classifications)) L.push(`  ${k.padEnd(28)} ${v}`)

  L.push('')
  L.push('--- ZONES ---')
  L.push('  zone      n    actual $    est.shadow $   medCapA   medCapS')
  for (const z of ZONE_ORDER) {
    const v = r.zones[z]
    L.push(
      `  ${z.padEnd(6)} ${String(v.count).padStart(3)} ${String(v.actualTotalPnlUsd).padStart(11)} ${String(v.estShadowTotalPnlUsd).padStart(13)} ${String(v.actualMedianCapture ?? '-').padStart(9)} ${String(v.estShadowMedianCapture ?? '-').padStart(9)}`,
    )
  }

  L.push('')
  L.push('--- CAPTURE EFFICIENCY ---')
  for (const [name, s] of [['ACTUAL ', r.capture.actual], ['SHADOW*', r.capture.shadow]]) {
    L.push(`  ${name} n=${s.count} median=${s.median ?? '-'} mean=${s.mean ?? '-'}  <25%=${s.buckets.lt25} 25-50%=${s.buckets.p25_50} 50-75%=${s.buckets.p50_75} >75%=${s.buckets.gt75}`)
  }
  L.push(`  median improvement            : ${r.capture.medianImprovement ?? '-'}`)
  L.push(`  positive MFE -> realised loss : actual ${r.capture.positiveMfeEndingInLoss.actual}, estimated ${r.capture.positiveMfeEndingInLoss.estShadow}`)
  L.push(`  round-trips prevented (est)   : ${r.capture.roundTripsPreventedEst}`)
  L.push(`  winners clipped (est)         : ${r.capture.winnersClippedEst}`)

  L.push('')
  L.push('--- PER TRADE ---')
  if (!r.perTrade.length) L.push('  (none)')
  else {
    L.push('  id              side  1R$     MFE$   peakR  actual$  capA   stage        floor$  est$    capS   d$      classification')
    for (const t of r.perTrade) {
      const f = (v, d = 2) => (v == null ? '-' : Number(v).toFixed(d))
      L.push(
        `  ${String(t.tradeId ?? t.brokerTicket ?? '?').slice(0, 14).padEnd(15)} ${String(t.direction ?? '-').padEnd(5)} ${f(t.riskUsd).padStart(6)} ${f(t.actualMfeUsd).padStart(7)} ${f(t.peakR).padStart(6)} ${f(t.actualRealisedPnlUsd).padStart(8)} ${f(t.actualCaptureEfficiency).padStart(6)} ${String(t.highestStage ?? '-').padEnd(12)} ${f(t.highestTargetFloorUsd).padStart(7)} ${f(t.estShadowPnlUsd).padStart(7)} ${f(t.estShadowCaptureEfficiency).padStart(6)} ${f(t.deltaUsd).padStart(7)} ${t.classification}`,
      )
    }
  }

  L.push('')
  L.push('--- COUNTERFACTUAL WOULD_CLOSE / CLIPPING ---')
  L.push('  !! WOULD_CLOSE is COUNTERFACTUAL / SHADOW. It is NOT an actual trade closure.')
  L.push('  !! The real position stays open and this report keeps reading it until a')
  L.push('  !! genuine row_kind=close row arrives.')
  if (!r.clipping) {
    L.push('  (unavailable — the CLI did not supply raw rows to buildReport)')
  } else {
    const c = r.clipping
    const f = (v, d = 2) => (v == null ? '-' : Number(v).toFixed(d))
    L.push('')
    L.push(`  completed lifecycles        : ${c.lifecyclesClosed}`)
    L.push(`  still-open lifecycles       : ${c.lifecyclesOpen}`)
    L.push(`  trades containing WOULD_CLOSE: ${c.tradesWithWouldClose}`)
    L.push(`  trades clipped by shadow     : ${c.tradesClipped}   clip rate: ${c.clipRate ?? '-'}`)
    if (c.wouldCloseStillOpen) {
      L.push(`  WOULD_CLOSE but still open   : ${c.wouldCloseStillOpen} (${c.wouldCloseStillOpenTickets.join(', ')} — CANNOT be judged until they close)`)
    }
    L.push('')
    if (!c.perTrade.length) {
      L.push('  (no trade has reached a counterfactual WOULD_CLOSE yet)')
    } else {
      for (const o of c.perTrade) {
        const wc = o.firstWouldClose
        L.push(`  ticket ${o.brokerTicket}  (trade ${o.tradeId ?? '-'})  ${o.pair ?? '-'} ${o.direction ?? '-'}`)
        L.push(`    planned risk              : $${f(o.plannedRiskUsd)}`)
        L.push(`    first WOULD_CLOSE at      : ${wc.at ?? '-'}`)
        L.push(`    R at WOULD_CLOSE          : ${f(wc.rAtWouldClose, 4)}`)
        L.push(`    profit at WOULD_CLOSE     : $${f(wc.profitAtWouldClose)}`)
        L.push(`    peak at WOULD_CLOSE       : ${f(wc.peakRAtWouldClose, 4)}R / $${f(wc.peakProfitAtWouldClose)}`)
        L.push(`    target floor              : $${f(wc.targetFloorUsd)}`)
        L.push(`    max R after WOULD_CLOSE   : ${f(o.postWouldCloseMaxR, 4)}`)
        L.push(`    ranFurtherR               : ${f(o.ranFurtherR, 4)}`)
        L.push(`    actual final realised     : ${o.actualClose ? `$${f(o.actualClose.profitUsd)}` : 'STILL OPEN'}`)
        L.push(`    actual final R            : ${f(o.actualFinalR, 4)}`)
        L.push(`    lifecycle                 : ${o.lifecycleOpen ? 'OPEN' : 'CLOSED'}`)
        L.push(`    WOULD_CLOSE evaluations   : ${o.wouldCloseCount}`)
        L.push(`    shadow would have clipped : ${o.clippedRunner ? 'YES' : 'no'}`)
        L.push('')
      }
    }
    L.push(`  ${c.label}`)
  }

  L.push('')
  L.push('--- SAMPLE ADEQUACY ---')
  L.push(`  comparable trades : ${r.adequacy.tradeCount} (target >= ${r.adequacy.targetMin})`)
  L.push(`  zones covered     : ${r.adequacy.zonesCovered.join(', ') || 'none'}`)
  L.push(`  adequate          : ${r.adequacy.adequate ? 'YES' : 'NO'}`)
  for (const reason of r.adequacy.reasons) L.push(`    - ${reason}`)

  L.push('')
  L.push('--- CAVEATS ---')
  for (const c of r.caveats) L.push(`  * ${c}`)
  L.push('')
  L.push('* SHADOW column is COUNTERFACTUAL / ESTIMATED — not money earned.')
  return L.join('\n')
}

function formatEmpty(p) {
  return [
    '=============================================================',
    ' PROFIT PROTECTION SHADOW STUDY — NO TELEMETRY',
    '=============================================================',
    `generated : ${p.generatedAt}`,
    `window    : last ${p.windowDays} days`,
    '',
    p.message,
    '',
    `shadow_command_emitted = true : ${p.shadowCommandEmittedCount}`,
    '',
    'CAVEAT:',
    `  * ${p.note}`,
  ].join('\n')
}


if (asJson) {
  console.log(JSON.stringify(report, null, 2))
} else {
  console.log(formatReport(report))
}
process.exit(0)
