// lib/execution-evidence.mjs
// ─────────────────────────────────────────────────────────────────────────────
// SybexForexAI — GENUINE EXECUTION EVIDENCE (Phase 4.1F)
//
// Pure. Builds the ONLY dataset that time-of-day performance may be judged on:
// trades that a broker actually confirmed. Everything else is measurement noise.
//
// PRODUCTION FINDING THIS ENCODES
// -------------------------------
// Of 1,284 production trade rows, 637 carried P&L but NO broker ticket — June
// micro-lot rows (0.01–0.14 lots) lasting seconds, e.g. 60+ trades of 0.06 lots
// on 2026-06-05. Treating those as executions is what made a single 5-lot XAU
// winner look like a "02:00 edge".
//
// HARD RULES
//   • A row counts as a genuine execution only if it has a broker ticket AND a
//     non-null P&L. Ticket-less rows are excluded from real-execution metrics
//     and retained separately for simulation/model research.
//   • Sample size is never reported without the number of INDEPENDENT DAYS.
//     One hundred trades across two days is not one hundred observations.
//   • Results are never classified from a single outlier; sensitivity analysis
//     (exclude largest winner / two largest / largest loss) is always attached.
// ─────────────────────────────────────────────────────────────────────────────

import { ukParts, ukSession } from './uk-time.mjs'
import { resolveOutcome, RESULT } from './trade-accounting.mjs'

/** Provisional sample-confidence bands (Phase 4.1 spec). */
export function evidenceConfidence(n) {
  if (!Number.isFinite(n) || n < 20) return 'INSUFFICIENT_DATA'
  if (n < 50) return 'LOW_CONFIDENCE'
  if (n < 100) return 'MODERATE_CONFIDENCE'
  return 'LARGER_SAMPLE'
}

const toNum = (v) => { const n = Number(v); return (v === undefined || v === null || v === '') ? null : (Number.isFinite(n) ? n : null) }
const round2 = (n) => Number.isFinite(n) ? Math.round(n * 100) / 100 : null

/**
 * Classify one row into genuine execution / simulation / invalid.
 * @returns {object} annotated row with `evidenceClass` and `excludedReason`
 */
export function classifyRow(trade = {}) {
  const ticket = String(trade.broker_ticket ?? '').trim()
  const pl = toNum(trade.pl_usd ?? trade.net_realised_pnl)
  const opened = trade.opened_at ?? trade.openedAt ?? null
  const parts = ukParts(opened)
  const canonical = resolveOutcome(trade)

  if (!ticket) {
    return { ...trade, evidenceClass: 'SIMULATION', excludedReason: 'no_broker_ticket', uk: parts, canonical }
  }
  if (pl === null) {
    return { ...trade, evidenceClass: 'INCOMPLETE_EXECUTION', excludedReason: 'no_realised_pnl', uk: parts, canonical }
  }
  if (!parts) {
    return { ...trade, evidenceClass: 'INVALID', excludedReason: 'unparseable_timestamp', uk: null, canonical }
  }
  return { ...trade, evidenceClass: 'GENUINE_EXECUTION', excludedReason: null, uk: parts, canonical }
}

/** Statistical summary over an array of numeric P&Ls. */
export function summarise(pnls = []) {
  const vals = pnls.map(toNum).filter((v) => v !== null)
  const n = vals.length
  if (n === 0) {
    return {
      n: 0, wins: 0, losses: 0, breakevens: 0, winRate: null,
      net: 0, grossWin: 0, grossLoss: 0, profitFactor: null,
      avg: null, median: null, largestWin: null, largestLoss: null, maxDrawdown: 0,
    }
  }
  const wins = vals.filter((v) => v > 0.01)
  const losses = vals.filter((v) => v < -0.01)
  const bes = vals.filter((v) => Math.abs(v) <= 0.01)
  const grossWin = wins.reduce((a, b) => a + b, 0)
  const grossLoss = Math.abs(losses.reduce((a, b) => a + b, 0))
  const sorted = [...vals].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  const median = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2

  let peak = 0, equity = 0, maxDd = 0
  for (const v of vals) {
    equity += v
    if (equity > peak) peak = equity
    if (peak - equity > maxDd) maxDd = peak - equity
  }

  return {
    n,
    wins: wins.length,
    losses: losses.length,
    breakevens: bes.length,
    winRate: +(100 * wins.length / n).toFixed(1),
    net: round2(vals.reduce((a, b) => a + b, 0)),
    grossWin: round2(grossWin),
    grossLoss: round2(grossLoss),
    profitFactor: grossLoss > 0 ? +(grossWin / grossLoss).toFixed(2) : (grossWin > 0 ? null : 0),
    avg: round2(vals.reduce((a, b) => a + b, 0) / n),
    median: round2(median),
    largestWin: wins.length ? round2(Math.max(...wins)) : null,
    largestLoss: losses.length ? round2(Math.min(...losses)) : null,
    maxDrawdown: round2(maxDd),
  }
}

/** Longest run of consecutive losing trades in supplied order. */
export function maxConsecutiveLosses(pnls = []) {
  let streak = 0, worst = 0
  for (const v of pnls) {
    const n = toNum(v)
    if (n === null) continue
    if (n < -0.01) { streak++; worst = Math.max(worst, streak) } else { streak = 0 }
  }
  return worst
}

/**
 * Build the evidence dataset + per-bucket aggregates.
 *
 * @param {Array<object>} trades raw rows from `trades`
 * @param {object} [opts] { bucketBy: 'ukEntryHour' | 'ukExitHour' | 'ukHalfHour' | 'session' | 'weekday' }
 */
export function buildEvidence(trades = [], opts = {}) {
  const classified = trades.map(classifyRow)
  const genuine = classified.filter((t) => t.evidenceClass === 'GENUINE_EXECUTION')
  const simulation = classified.filter((t) => t.evidenceClass === 'SIMULATION')
  const incomplete = classified.filter((t) => t.evidenceClass === 'INCOMPLETE_EXECUTION')
  const invalid = classified.filter((t) => t.evidenceClass === 'INVALID')

  const sorted = [...genuine].sort((a, b) =>
    String(a.opened_at ?? '').localeCompare(String(b.opened_at ?? '')))

  const pnls = sorted.map((t) => toNum(t.pl_usd))
  const overall = summarise(pnls)
  const days = new Set(sorted.map((t) => t.uk.dateKey))
  const weeks = new Set(sorted.map((t) => t.uk.weekKey))
  const months = new Set(sorted.map((t) => t.uk.monthKey))

  const groups = new Map()
  for (const t of sorted) {
    const key = bucketKey(t, opts.bucketBy ?? 'ukEntryHour')
    if (key === null) continue
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(t)
  }

  const buckets = [...groups.entries()].map(([key, rows]) => {
    const series = rows.map((r) => toNum(r.pl_usd))
    const s = summarise(series)
    return {
      key,
      ...s,
      independentDays: new Set(rows.map((r) => r.uk.dateKey)).size,
      independentWeeks: new Set(rows.map((r) => r.uk.weekKey)).size,
      confidence: evidenceConfidence(s.n),
      maxConsecutiveLosses: maxConsecutiveLosses(series),
      sensitivity: sensitivity(series),
      days: [...new Set(rows.map((r) => r.uk.dateKey))].sort(),
    }
  }).sort((a, b) => String(a.key).localeCompare(String(b.key)))

  return {
    overall: {
      ...overall,
      independentDays: days.size,
      independentWeeks: weeks.size,
      independentMonths: months.size,
      confidence: evidenceConfidence(overall.n),
      maxConsecutiveLosses: maxConsecutiveLosses(pnls),
    },
    sensitivity: sensitivity(pnls),
    weeks: groupSums(sorted, (t) => t.uk.weekKey),
    months: groupSums(sorted, (t) => t.uk.monthKey),
    buckets,
    excluded: {
      simulation: simulation.length,
      incompleteExecution: incomplete.length,
      invalid: invalid.length,
      simulationNet: round2(simulation.reduce((a, t) => a + (toNum(t.pl_usd) ?? 0), 0)),
    },
    health: {
      totalRows: classified.length,
      genuineExecutions: genuine.length,
      simulationRecords: simulation.length,
      incompleteExecutions: incomplete.length,
      invalidTimestamps: invalid.length,
      withBrokerTicket: classified.filter((t) => String(t.broker_ticket ?? '').trim()).length,
      withCompleteNetPnl: classified.filter((t) => t.canonical?.accountingComplete).length,
      withCanonicalResult: classified.filter((t) => t.canonical?.tradeResult && t.canonical.tradeResult !== RESULT.UNKNOWN).length,
    },
  }
}

function bucketKey(t, mode) {
  switch (mode) {
    case 'ukExitHour': {
      const p = ukParts(t.closed_at ?? t.closedAt)
      return p ? p.hour : null
    }
    case 'ukHalfHour': {
      const p = t.uk
      if (!p) return null
      const start = Math.floor(p.minute / 30) * 30
      return `${String(p.hour).padStart(2, '0')}:${String(start).padStart(2, '0')}`
    }
    case 'session': return ukSession(t.opened_at ?? t.openedAt)
    case 'weekday': return t.uk?.weekday ?? null
    default: return t.uk ? t.uk.hour : null
  }
}

function groupSums(rows, keyFn) {
  const map = new Map()
  for (const r of rows) {
    const k = keyFn(r)
    if (k === null || k === undefined) continue
    if (!map.has(k)) map.set(k, [])
    map.get(k).push(toNum(r.pl_usd))
  }
  return [...map.entries()].sort((a, b) => String(a[0]).localeCompare(String(b[0])))
    .map(([key, series]) => ({
      key,
      ...summarise(series),
      independentDays: new Set(rows.filter((r) => keyFn(r) === key)
        .map((r) => r.uk.dateKey)).size,
    }))
}

/**
 * Outlier sensitivity — the antidote to "one big winner proves an edge".
 * Returns the same summary with the extreme trades removed.
 */
export function sensitivity(pnls = []) {
  const vals = pnls.map(toNum).filter((v) => v !== null)
  if (vals.length === 0) return null
  const sortedDesc = [...vals].sort((a, b) => b - a)
  const sortedAsc = [...vals].sort((a, b) => a - b)
  return {
    excludingLargestWinner: summarise(sortedDesc.slice(1)),
    excludingTwoLargestWinners: summarise(sortedDesc.slice(2)),
    excludingLargestLoss: summarise(sortedAsc.slice(1)),
    largestWinnerShareOfNet: (() => {
      const net = vals.reduce((a, b) => a + b, 0)
      const top = sortedDesc[0]
      if (!net || !Number.isFinite(top)) return null
      return +(100 * top / net).toFixed(1)
    })(),
  }
}

