// app/api/production-integrity/route.ts
// ─────────────────────────────────────────────────────────────────────────────
// Phase 4.1 — READ-ONLY production integrity + trading-session evidence.
//
// This endpoint answers "can we trust the records?" and nothing else. It has NO
// connection to Trade Authority, order submission, sizing or execution: it only
// reads. Every status carries the counts behind it, because a status without
// evidence is another thing to distrust.
//
// Statuses: HEALTHY | INCOMPLETE | WARNING | FAILED | INSUFFICIENT_DATA
// ─────────────────────────────────────────────────────────────────────────────
export const dynamic = 'force-dynamic'

import { NextResponse } from 'next/server'
import { getAdminClient } from '@/lib/supabase'
import { buildEvidence } from '@/lib/execution-evidence.mjs'
import { ukOffsetMinutes } from '@/lib/uk-time.mjs'
import { buildScopedAnalytics } from '@/lib/analytics-metrics.mjs'
import { POPULATION } from '@/lib/analytics-scope.mjs'
import { reconStatus, reconWarnHours } from '@/lib/integrity-thresholds.mjs'

const WINDOW_DAYS = 120
const EVIDENCE_LIMIT = 3000

type Status = 'HEALTHY' | 'INCOMPLETE' | 'WARNING' | 'FAILED' | 'INSUFFICIENT_DATA'

function check(name: string, status: Status, detail: string, counts: Record<string, number | null>) {
  return { name, status, detail, counts }
}

async function countOf(build: (q: any) => any): Promise<number | null> {
  try {
    const q = build(getAdminClient().from('trades').select('id', { count: 'exact', head: true }))
    const { count, error } = await q
    return error ? null : (typeof count === 'number' ? count : null)
  } catch { return null }
}

export async function GET() {
  try {
    const admin = getAdminClient()
    const since = new Date(Date.now() - WINDOW_DAYS * 86400_000).toISOString()

    // ── 1. Genuine execution evidence ─────────────────────────────────────
    const evRes = await admin.from('trades')
      .select('id,broker_ticket,pair,direction,lots,pl_usd,commission,swap,result,trade_status,trade_result,sl_price,entry_price,opened_at,closed_at')
      .gte('opened_at', since)
      .not('broker_ticket', 'is', null)
      .not('pl_usd', 'is', null)
      .order('opened_at', { ascending: true })
      .limit(EVIDENCE_LIMIT)
    if (evRes.error) throw new Error(`trades read failed — ${evRes.error.message}`)

    const evidence = buildEvidence(evRes.data ?? [], { bucketBy: 'ukEntryHour' })

    // ── 3b. Population scope (Phase 4.2C) ─────────────────────────────────
    // Every analytics surface must be able to answer "how many rows did you
    // exclude, and why". This block is that answer, computed from the same
    // classifier the UI uses, so the endpoint cannot disagree with the pages.
    const scopeRes = await admin.from('trades')
      .select('id,broker_ticket,pl_usd,net_realised_pnl,commission,swap,other_fees,accounting_complete,accounting_missing,trade_result,result,trade_status,closed_at')
      .gte('opened_at', since)
      .order('opened_at', { ascending: false })
      .limit(EVIDENCE_LIMIT)
    const scoped = buildScopedAnalytics(scopeRes.error ? [] : (scopeRes.data ?? []))
    const c = scoped.scope.counts

    // ── 2. Row counts ─────────────────────────────────────────────────────
    const [totalRows, closedRows, legacyClosed, ticketless, withExecSource] = await Promise.all([
      countOf((q) => q),
      countOf((q) => q.in('result', ['WIN', 'LOSS', 'BREAKEVEN', 'CLOSED'])),
      countOf((q) => q.eq('result', 'CLOSED')),
      countOf((q) => q.is('broker_ticket', null)),
      countOf((q) => q.not('execution_source', 'is', null)),
    ])

    // ── 3. Phase 4.1 columns may not exist yet — degrade, never throw ─────
    let hasPhase41 = false
    let authority: { sampled: number, byLane: Record<string, number>, byDecision: Record<string, number> } | null = null
    try {
      const a = await admin.from('trades')
        .select('submission_source,authority_decision')
        .not('submission_source', 'is', null)
        .order('submitted_at', { ascending: false })
        .limit(200)
      if (!a.error) {
        hasPhase41 = true
        const rows = (a.data ?? []) as any[]
        const byLane: Record<string, number> = {}
        const byDecision: Record<string, number> = {}
        for (const r of rows) {
          byLane[r.submission_source] = (byLane[r.submission_source] ?? 0) + 1
          byDecision[r.authority_decision] = (byDecision[r.authority_decision] ?? 0) + 1
        }
        authority = { sampled: rows.length, byLane, byDecision }
      }
    } catch { hasPhase41 = false }

    // ── 4. Reconciliation freshness ───────────────────────────────────────
    //
    // Phase 4.2.1 (M-6 / A-6). The threshold was hard-coded at 48 h FAILED /
    // 6 h WARNING against a 10-minute design cadence, so a 4.4 h stale
    // reconciliation reported HEALTHY — the health surface could not see the
    // staleness it exists to detect.
    //
    // The strict value is deliberately NOT hard-coded: M-6 has a hard dependency
    // on C-2 (the scheduler's CRON_SECRET), and turning the monitor red before
    // the scheduler can be fixed produces noise, not safety. So the threshold is
    // environment-gated with **today's value as the default** — nothing changes
    // until the owner opts in by setting RECON_STALE_WARN_HOURS (strict value
    // 0.5, i.e. 30 min, documented in PHASE42_1_OWNER_ACTIONS.md).
    const warnH = reconWarnHours(process.env)
    let recon: { rows: number | null, executionLinked: number | null, lastUpdatedAt: string | null, ageHours: number | null, warnHours: number, status: Status } = {
      rows: null, executionLinked: null, lastUpdatedAt: null, ageHours: null, warnHours: warnH, status: 'FAILED',
    }
    try {
      const r = await admin.from('outcome_reconciliation')
        .select('setup_key,execution_id,updated_at')
        .order('updated_at', { ascending: false })
        .limit(1)
      const totalRes = await admin.from('outcome_reconciliation').select('setup_key', { count: 'exact', head: true })
      const linkedRes = await admin.from('outcome_reconciliation').select('setup_key', { count: 'exact', head: true }).not('execution_id', 'is', null)
      const last = r.data?.[0]?.updated_at ?? null
      const ageH = last ? (Date.now() - new Date(last).getTime()) / 3600_000 : null
      recon = {
        rows: totalRes.count ?? null,
        executionLinked: linkedRes.count ?? null,
        lastUpdatedAt: last,
        ageHours: ageH === null ? null : +ageH.toFixed(1),
        warnHours: warnH,
        status: reconStatus(ageH, warnH),
      }
    } catch { /* left as FAILED */ }


    // ── 5. Integrity checks ───────────────────────────────────────────────
    const genuine = evidence.health.genuineExecutions
    const withCompleteNet = evidence.health.withCompleteNetPnl
    const withResult = evidence.health.withCanonicalResult

    const checks = [
      check('order_authority',
        hasPhase41 ? ((authority?.sampled ?? 0) > 0 ? 'HEALTHY' : 'INSUFFICIENT_DATA') : 'INCOMPLETE',
        hasPhase41
          ? 'Every new order records submission_source + authority_decision. Rows predating 2026-11-12 carry neither.'
          : 'Phase 4.1 authority columns are absent — apply 20261112_phase41_order_authority_and_accounting.sql.',
        {
          sampledWithAuthority: authority?.sampled ?? 0,
          approvedAutomated: authority?.byDecision?.APPROVED_AUTOMATED ?? 0,
          approvedManual: authority?.byDecision?.APPROVED_MANUAL ?? 0,
          rejected: authority?.byDecision?.REJECTED_UNAUTHORISED ?? 0,
          workerLane: authority?.byLane?.WORKER_AUTOTRADE ?? 0,
          uiScalpLane: authority?.byLane?.UI_SCALP_CARD ?? 0,
        }),

      check('trade_accounting',
        !genuine ? 'INSUFFICIENT_DATA' : (withResult === genuine ? 'HEALTHY' : withResult === 0 ? 'FAILED' : 'INCOMPLETE'),
        'Canonical trade_result present on broker-confirmed executions.',
        { genuineExecutions: genuine, withCanonicalResult: withResult }),

      check('commission_swap',
        !genuine ? 'INSUFFICIENT_DATA' : (withCompleteNet === genuine ? 'HEALTHY' : withCompleteNet === 0 ? 'FAILED' : 'INCOMPLETE'),
        'Complete net P&L requires commission AND swap from broker deal records. Until the EA supplies them net is unknowable, and gross is reported as GROSS_ONLY rather than passed off as net.',
        { genuineExecutions: genuine, withCompleteNetPnl: withCompleteNet, missingCosts: genuine - withCompleteNet }),

      check('lineage',
        !(totalRows ?? 0) ? 'INSUFFICIENT_DATA' : 'INCOMPLETE',
        'Trades carrying an explicit prediction_log_id / setup_id. Scalper orders carry signal_id_ref only and are not backfilled without unambiguous evidence.',
        { totalRows: totalRows ?? 0, withExecutionSource: withExecSource ?? 0 }),

      check('reconciliation_refresh', recon.status,
        recon.status === 'FAILED'
          ? 'outcome_reconciliation has not refreshed recently — the scheduled refresh is not completing (check the Vercel cron cadence and CRON_SECRET).'
          : 'Derived reconciliation layer is refreshing.',
        { rows: recon.rows, executionLinked: recon.executionLinked, ageHours: recon.ageHours }),

      check('actual_risk', 'INCOMPLETE',
        'planned_risk_amount must come from the ACTUAL filled stop. Historical rows used requested pips and cannot be corrected without broker deal history.',
        { closedRows: closedRows ?? 0 }),

      check('broker_execution_coverage',
        !(totalRows ?? 0) ? 'INSUFFICIENT_DATA' : 'WARNING',
        'Ticket-less rows are simulations/model records, excluded from execution metrics and retained rather than deleted.',
        { totalRows: totalRows ?? 0, ticketless: ticketless ?? 0 }),

      check('accounting_errors',
        (legacyClosed ?? 0) > 0 ? 'WARNING' : 'HEALTHY',
        "Legacy result='CLOSED' rows are CLOSED trades with unrecorded profitability — never counted as losses.",
        { legacyClosed: legacyClosed ?? 0 }),

      check('timezone_integrity',
        evidence.health.invalidTimestamps > 0 ? 'WARNING' : (genuine ? 'HEALTHY' : 'INSUFFICIENT_DATA'),
        'All time-of-day aggregation runs through Europe/London (Intl), with no hardcoded UTC offset.',
        {
          invalidTimestamps: evidence.health.invalidTimestamps,
          ukOffsetNowMinutes: ukOffsetMinutes(new Date()) ?? 0,
          isBst: ukOffsetMinutes(new Date()) === 60 ? 1 : 0,
        }),

      // ── Phase 4.2C — analytics population hygiene ──────────────────────
      // A number is only honest if the denominator is stated. This check fails
      // loudly if any simulated row could ever reach a net figure.
      check('analytics_population',
        scoped.scope.totalRows === 0 ? 'INSUFFICIENT_DATA'
          : (c[POPULATION.SIMULATION] > 0 && c[POPULATION.NET_CONFIRMED] === 0) ? 'WARNING' : 'HEALTHY',
        scoped.scope.disclosure
          + ' — net metrics are computed ONLY from net-complete executions; '
          + 'gross-only and simulated rows are reported separately and never averaged into net.',
        {
          netComplete: c[POPULATION.NET_CONFIRMED],
          grossOnly: c[POPULATION.GROSS_ONLY],
          accountingPending: c[POPULATION.ACCOUNTING_PENDING],
          accountingError: c[POPULATION.ACCOUNTING_ERROR],
          simulated: c[POPULATION.SIMULATION],
          cancelled: c[POPULATION.CANCELLED],
          open: c[POPULATION.OPEN],
          netMetricAvailable: scoped.net.n > 0 ? 1 : 0,
        }),

      // ── Phase 4.2E — scheduler authentication ──────────────────────────
      // The Vercel preview/production process is the only environment this
      // endpoint can inspect. THE VPS WORKER's CRON_SECRET is NOT observable
      // from here and is reported separately as NOT VERIFIED.
      check('scheduler_authentication',
        process.env.CRON_SECRET ? 'HEALTHY' : 'FAILED',
        process.env.CRON_SECRET
          ? 'CRON_SECRET is set in this runtime; the refresh endpoint requires an exact timing-safe match and no longer accepts a forgeable x-vercel-cron header.'
          : 'CRON_SECRET is NOT set in this runtime. The refresh endpoint refuses unauthenticated production requests (503), so scheduled reconciliation cannot run. Worker-side configuration is NOT VERIFIED from here.',
        {
          cronSecretConfigured: process.env.CRON_SECRET ? 1 : 0,
          workerSchedulerVerified: 0,
        }),
    ]


    // ── 6. Trading session evidence (sample size FIRST, ranking second) ───
    const buckets = evidence.buckets
      .map((b) => ({
        ukEntryHour: b.key,
        executions: b.n,
        independentDays: b.independentDays,
        independentWeeks: b.independentWeeks,
        confidence: b.confidence,
        wins: b.wins, losses: b.losses, breakevens: b.breakevens,
        winRate: b.winRate,
        net: b.net, median: b.median, profitFactor: b.profitFactor,
        maxDrawdown: b.maxDrawdown,
        maxConsecutiveLosses: b.maxConsecutiveLosses,
        excludingLargestWinnerNet: b.sensitivity?.excludingLargestWinner?.net ?? null,
        days: b.days,
      }))
      // Ordered by SAMPLE SIZE, not by profit: a "best hour" table built on two
      // trades is precisely the failure mode this phase exists to stop.
      .sort((a, b) => b.executions - a.executions
        || String(a.ukEntryHour).localeCompare(String(b.ukEntryHour)))

    const rankable = buckets.filter((b) => b.confidence !== 'INSUFFICIENT_DATA')

    return NextResponse.json({
      generatedAt: new Date().toISOString(),
      windowDays: WINDOW_DAYS,
      readOnly: true,
      connectedToTradeAuthority: false,
      overallStatus: checks.some((c) => c.status === 'FAILED') ? 'FAILED'
        : checks.some((c) => c.status === 'INCOMPLETE') ? 'INCOMPLETE'
          : checks.some((c) => c.status === 'WARNING') ? 'WARNING' : 'HEALTHY',
      checks,
      analytics: {
        scope: scoped.scope,
        net: scoped.net,
        gross: scoped.gross,
        netComplete: scoped.netComplete,
        excluded: scoped.excluded,
        note: 'net.* is confirmed net profitability. gross.* is provisional and is labelled GROSS. They are never summed together.',
      },
      tradingSessionEvidence: {
        overall: evidence.overall,
        sensitivity: evidence.sensitivity,
        health: evidence.health,
        excluded: evidence.excluded,
        rankingAvailable: rankable.length > 0,
        rankingSuppressedReason: rankable.length > 0
          ? null
          : `No UK-hour bucket reaches the 20-execution minimum (largest has ${buckets[0]?.executions ?? 0} executions across ${buckets[0]?.independentDays ?? 0} independent day(s)). A "best hour" ranking would be noise.`,
        buckets,
        weeks: evidence.weeks,
        months: evidence.months,
      },
    })
  } catch (error: any) {
    console.error('[production-integrity]', error?.message)
    return NextResponse.json({
      generatedAt: new Date().toISOString(),
      readOnly: true,
      overallStatus: 'FAILED',
      error: error?.message || 'inspection failed',
    }, { status: 500 })
  }
}

