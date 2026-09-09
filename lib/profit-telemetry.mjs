// lib/profit-telemetry.mjs
// Durable shadow profit-protection telemetry — pure, observable helpers.
// (Audit 2026-09-09 / shadow phase.) Converts trade-manager telemetry items
// into DB rows, classifies lifecycle rows, deduplicates periodic snapshots,
// derives per-trade ACTUAL vs COUNTERFACTUAL/ESTIMATED summaries and sample
// aggregates. NO trading logic lives here and nothing here can affect
// execution — persistence is best-effort via bestEffort().
// ─────────────────────────────────────────────────────────────────────────────

const round = (n, d = 4) => (n == null || !Number.isFinite(Number(n)) ? null : Number(Number(n).toFixed(d)))
const num = (n, d = 2) => (n == null || !Number.isFinite(Number(n)) ? null : Number(Number(n).toFixed(d)))

/** Lifecycle kind: snapshot (periodic/state-changed) | decision | close. */
export function rowKind(item) {
  const d = String(item.shadowDecision || '')
  const action = item.action ? String(item.action) : ''
  if (d.endsWith('_CLOSE') || /close$/i.test(action)) return 'close'
  if (item.action !== null || /^WOULD_|^MOVED_|^EXISTING_/.test(d)) return 'decision'
  return 'snapshot'
}

/**
 * Convert one trade-manager telemetry item into a snake_case DB row.
 * @param {object} item — ManageResult.telemetry entry
 * @param {object} ctx — { protectionMode, stateSeq, marketRegime, session }
 */
export function toRow(item, ctx = {}) {
  const mode = ctx.protectionMode === 'live' ? 'live' : 'shadow'
  return {
    broker_ticket: item.ticket != null ? String(item.ticket) : null,
    trade_id: item.tradeId != null ? String(item.tradeId) : null,
    pair: item.pair ?? null,
    direction: item.direction ?? null,
    lots: num(item.lots),
    open_price: num(item.openPrice, 8),
    initial_sl: num(item.initialSl, 8),
    current_sl: num(item.currentSl, 8),
    current_price: num(item.currentPrice, 8),
    current_profit_usd: num(item.currentProfit),
    peak_profit_usd: num(item.peakProfit),
    planned_risk_usd: num(item.plannedRiskUsd),
    current_r: round(item.currentR),
    peak_r: round(item.peakR),
    retained_profit_pct: round(item.retainedPct),
    giveback_pct: round(item.givebackPct),
    protection_stage: item.protectionStage || null,
    target_floor_usd: num(item.targetFloorUsd != null ? item.targetFloorUsd : item.floorUsd),
    proposed_protection_sl: num(item.proposedProtectionSl != null ? item.proposedProtectionSl : item.proposedSl, 8),
    existing_manager_action: item.existingManagerAction || null,
    shadow_decision: item.shadowDecision || 'NONE',
    protection_mode: mode,
    row_kind: rowKind(item),
    state_seq: ctx.stateSeq != null ? Number(ctx.stateSeq) : null,
    // Safety assertion — shadow protection NEVER emits broker commands.
    shadow_command_emitted: false,
    market_regime: ctx.marketRegime || null,
    session: ctx.session || null,
  }
}


/** Snapshot dedupe signature (identical observations within 30s collapse). */
export function snapshotSignature(row) {
  return [
    row.broker_ticket, row.protection_stage, row.shadow_decision,
    row.existing_manager_action || '',
    row.target_floor_usd,
    String(Math.round(Number(row.current_profit_usd) || 0) / 2),
  ].join('|')
}

/** Drop redundant snapshots; ALWAYS keep decisions and closes. */
export function dedupeRows(rows) {
  const seen = new Map()
  const out = []
  for (const r of rows) {
    if (r.row_kind !== 'snapshot') { out.push(r); continue }
    const sig = snapshotSignature(r)
    const lastMs = seen.get(sig)
    const at = r.created_at ? new Date(r.created_at).getTime() : Date.now()
    if (lastMs != null && at - lastMs < 30_000) continue
    seen.set(sig, at)
    out.push(r)
  }
  return out
}

/** Study zone classification by peak R (spec section 6). */
export function zoneOf(peakR) {
  const r = Number(peakR) || 0
  if (r < 0.5) return 'A'
  if (r < 1.2) return 'B'
  if (r < 2.0) return 'C'
  return 'SR'
}

export const ZONE_LABEL = { A: 'sub-0.5R', B: '0.5-1.2R', C: '1.2-2R', SR: '>=2R' }

// Observability copy of the early-rescue constants used ONLY for estimated
// counterfactual summaries (must mirror lib/profit-protection.mjs defaults).
export const EARLY_MIN_PEAK_USD = 7
export const EARLY_RESCUE_EST_USD = -1.5 // conservative mean rescue (range -3..0)

/**
 * Derive the ACTUAL + COUNTERFACTUAL/ESTIMATED close summary for one ticket
 * from its chronological rows.
 * @param {Array<object>} rows — telemetry rows for one ticket (any kind)
 * @param {object} [over] — { actualRealisedPnlUsd?, actualMfeUsd? } from the
 *   trades table when broker-realised values exist; otherwise the close row's
 *   decision-time current profit / peak profit are used and flagged.
 */
export function closeSummaryFromRows(rows, over = {}) {
  const sorted = [...rows].sort((a, b) => new Date(a.created_at) - new Date(b.created_at))
  const closeRow = [...sorted].reverse().find((r) => r.row_kind === 'close') || null
  const peakProfit = Math.max(0, ...sorted.map((r) => Number(r.peak_profit_usd) || 0))
  const mfe = over.actualMfeUsd != null ? Number(over.actualMfeUsd) : peakProfit
  const actualPnl = over.actualRealisedPnlUsd != null
    ? Number(over.actualRealisedPnlUsd)
    : (closeRow ? Number(closeRow.current_profit_usd) : null)
  const risk = sorted.map((r) => Number(r.planned_risk_usd) || 0).find((v) => v > 0) || null
  const peakR = risk ? peakProfit / risk : null
  const zone = zoneOf(peakR)
  const rank = { DEVELOP: 0, EARLY_GIVEBACK_BE: 1, PROTECT: 2, LOCK: 3, STRONG: 4, EXCEPTIONAL: 5 }
  let highestStage = 'DEVELOP'
  let highestFloorUsd = 0
  for (const r of sorted) {
    if ((rank[r.protection_stage] ?? 0) > (rank[highestStage] ?? 0)) highestStage = r.protection_stage
    highestFloorUsd = Math.max(highestFloorUsd, Number(r.target_floor_usd) || 0)
  }
  const first = (re) => sorted.find((r) => String(r.shadow_decision || '').startsWith(re))?.created_at ?? null
  const hadEarly = sorted.some((r) => r.shadow_decision === 'WOULD_MOVE_SL_TO_BE')
  const brokerRealised = over.actualRealisedPnlUsd != null && over.actualMfeUsd != null

  // ESTIMATED shadow outcome — conservative counterfactual (never broker-realised).
  let estPnl = actualPnl
  let preventedRoundTrip = false
  if (actualPnl != null && actualPnl < 0 && mfe >= EARLY_MIN_PEAK_USD && hadEarly) {
    estPnl = EARLY_RESCUE_EST_USD
    preventedRoundTrip = true
  } else if (actualPnl != null && actualPnl > 0 && highestFloorUsd > 0 && actualPnl < highestFloorUsd) {
    estPnl = Math.round(highestFloorUsd * 0.95 * 100) / 100
  }
  const clipped = actualPnl != null && actualPnl > 0 && highestFloorUsd > 0 && estPnl < actualPnl
  return {
    brokerTicket: rows[0]?.broker_ticket ?? null,
    pair: rows[0]?.pair ?? null,
    direction: rows[0]?.direction ?? null,
    zone,
    zoneLabel: ZONE_LABEL[zone],
    // ACTUAL
    actualRealisedPnlUsd: actualPnl,
    actualRealisedSource: brokerRealised ? 'broker' : 'decision-time',
    actualMfeUsd: mfe,
    actualCaptureEfficiency: actualPnl != null && mfe > 0 ? actualPnl / mfe : null,
    // COUNTERFACTUAL / ESTIMATED
    estShadowPnlUsd: estPnl,
    estShadowCaptureEfficiency: estPnl != null && mfe > 0 ? estPnl / mfe : null,
    estShadowSource: 'COUNTERFACTUAL / ESTIMATED',
    highestStage,
    highestTargetFloorUsd: highestFloorUsd,
    firstWouldMoveSlAt: first('WOULD_MOVE_SL'),
    firstWouldMoveSlToBeAt: first('WOULD_MOVE_SL_TO_BE'),
    firstWouldCloseAt: first('WOULD_CLOSE'),
    hadEarlyRescueTrigger: hadEarly,
    preventedRoundTripEst: preventedRoundTrip,
    clippedEst: clipped,
    shadowCommandEmitted: rows.some((r) => r.shadow_command_emitted === true && r.protection_mode === 'shadow'),
    riskUsd: risk,
    peakR,
  }
}

/** Aggregate a list of close summaries into the sample-level report shape. */
export function aggregateTrades(summaries) {
  const valid = summaries.filter((s) => s.actualMfeUsd != null && s.actualMfeUsd > 0)
  const eff = (sel) => valid.filter(sel).map((s) => s.actualCaptureEfficiency)
  const estEff = (sel) => valid.filter(sel).map((s) => s.estShadowCaptureEfficiency)
  const med = (a) => { if (!a.length) return null; const s = [...a].sort((p, q) => p - q); return s[Math.floor(s.length / 2)] }
  const bucket = (arr, lo, hi) => arr.filter((v) => v != null && v >= lo && v < hi).length
  const pnl = (arr) => arr.reduce((a, b) => a + (Number(b) || 0), 0)
  const actualWins = eff((s) => (s.actualRealisedPnlUsd ?? 0) > 0)
  const estWins = estEff((s) => (s.estShadowPnlUsd ?? 0) > 0)
  const risks = valid.map((s) => s.riskUsd).filter((v) => v != null && v > 0).sort((a, b) => a - b)
  const rmed = risks.length ? risks[Math.floor(risks.length / 2)] : null
  const rmean = risks.length ? risks.reduce((a, b) => a + b, 0) / risks.length : null
  return {
    tradeCount: valid.length,
    buySellSplit: { buy: valid.filter((s) => s.direction === 'BUY').length, sell: valid.filter((s) => s.direction === 'SELL').length },
    zones: { A: valid.filter((s) => s.zone === 'A').length, B: valid.filter((s) => s.zone === 'B').length, C: valid.filter((s) => s.zone === 'C').length, SR: valid.filter((s) => s.zone === 'SR').length },
    rDistributionUsd: risks.length ? { min: risks[0], median: rmed, mean: rmean, max: risks[risks.length - 1] } : null,
    actual: {
      totalRealisedPnlUsd: Math.round(pnl(valid.map((s) => s.actualRealisedPnlUsd)) * 100) / 100,
      winnerCaptureMedianPct: med(actualWins) != null ? Math.round(med(actualWins) * 1000) / 10 : null,
      winnerCaptureMeanPct: actualWins.length ? Math.round((pnl(actualWins) / actualWins.length) * 1000) / 10 : null,
      bucketsPct: {
        lt25: bucket(eff(() => true), 0, 0.25),
        p25_50: bucket(eff(() => true), 0.25, 0.5),
        p50_75: bucket(eff(() => true), 0.5, 0.75),
        gt75: bucket(eff(() => true), 0.75, 10),
      },
      roundTrips: valid.filter((s) => (s.actualRealisedPnlUsd ?? 0) < 0).length,
      strongRunners: valid.filter((s) => s.zone === 'SR').length,
    },
    shadow: {
      estimatedTotalRealisedPnlUsd: Math.round(pnl(valid.map((s) => s.estShadowPnlUsd)) * 100) / 100,
      estimatedDeltaUsd: Math.round((pnl(valid.map((s) => s.estShadowPnlUsd)) - pnl(valid.map((s) => s.actualRealisedPnlUsd))) * 100) / 100,
      winnerCaptureMedianPct: med(estWins) != null ? Math.round(med(estWins) * 1000) / 10 : null,
      winnerCaptureMeanPct: estWins.length ? Math.round((pnl(estWins) / estWins.length) * 1000) / 10 : null,
      preventedRoundTripsEst: valid.filter((s) => s.preventedRoundTripEst).length,
      strongRunnerClipsEst: valid.filter((s) => s.clippedEst).length,
    },
    note: 'Shadow values are COUNTERFACTUAL / ESTIMATED — not broker-realised.',
  }
}

/** Best-effort persistence wrapper — NEVER throws into the trading path. */
export async function bestEffort(write, log = (e) => console.error('[ppt] telemetry write failed:', e?.message || e)) {
  try {
    await write()
    return true
  } catch (e) {
    log(e)
    return false
  }
}


