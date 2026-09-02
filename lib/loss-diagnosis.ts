// lib/loss-diagnosis.ts
// ─────────────────────────────────────────────────────────────────────────────
// Automatic loss diagnosis (Phase 5/6): every losing trade gets an explanation
// derived from its MFE/MAE excursion and the conditions at signal time, plus a
// severity. Recurring failure patterns are aggregated for the strategy-health
// view so "why do we keep losing" is answered by data, not vibes.
// ─────────────────────────────────────────────────────────────────────────────
import { getAdminClient } from '@/lib/supabase'

export interface DiagnosisInput {
  pair: string
  direction: 'BUY' | 'SELL'
  outcome: 'WIN' | 'LOSS'
  rMultiple?: number | null
  mfePips?: number | null
  maePips?: number | null
  slPips?: number | null
  tpPips?: number | null
  atrPips?: number | null
  regime?: string | null
  session?: string | null
  spreadCond?: string | null
  confidence?: number | null
  agreement?: number | null
  mlWinProb?: number | null
  openAt?: string | null
  closeAt?: string | null
}

export interface DiagnosisResult {
  code: string
  diagnosis: string
  severity: 'INFO' | 'WARN' | 'CRITICAL'
  evidence: Record<string, unknown>
}

const p2 = (v: number | null | undefined): number | null =>
  (typeof v === 'number' && Number.isFinite(v)) ? v : null

export function diagnoseLoss(input: DiagnosisInput): DiagnosisResult {
  const sl = p2(input.slPips)
  const tp = p2(input.tpPips)
  const mfe = p2(input.mfePips)
  const mae = p2(input.maePips)
  const atr = p2(input.atrPips)
  const r = p2(input.rMultiple)
  const evidence: Record<string, unknown> = {
    rMultiple: r, mfePips: mfe, maePips: mae, slPips: sl, tpPips: tp,
    atrPips: atr, regime: input.regime ?? null, session: input.session ?? null,
    spreadCond: input.spreadCond ?? null, confidence: input.confidence ?? null,
  }
  const fail = (code: string, diagnosis: string, severity: 'INFO' | 'WARN' | 'CRITICAL'): DiagnosisResult =>
    ({ code, diagnosis, severity, evidence })

  if (input.outcome !== 'LOSS') {
    return fail('WIN', 'Trade resolved as a win — no diagnosis needed.', 'INFO')
  }
  if (mae === null) {
    return fail('UNKNOWN', 'Loss recorded without MAE/MFE telemetry — cannot diagnose further.', 'INFO')
  }

  // 1. Loss beyond the planned stop: slippage, gap, or broker fill issue.
  if (sl && mae > sl * 1.15) {
    return fail('GAP_THROUGH_SL',
      `Adverse excursion (${mae.toFixed(1)}p) exceeded the planned stop (${sl.toFixed(1)}p) by ` +
      `${((mae / sl - 1) * 100).toFixed(0)}% — price gapped or slipped through the stop. ` +
      'Check broker execution and consider wider stops during high-volatility news.',
      'CRITICAL')
  }
  // 2. Stop placed inside the ATR noise floor.
  if (sl && atr && atr > 0 && sl < atr) {
    return fail('SL_TOO_TIGHT',
      `Stop (${sl.toFixed(1)}p) is ${(sl / atr).toFixed(2)}× ATR (${atr.toFixed(1)}p) — the stop sat inside ` +
      "one bar of normal noise. The trade was stopped by the market's random walk, not by a failed thesis.",
      'CRITICAL')
  }
  // 3. Classic stop-out with no favourable excursion at all.
  if (mae >= (sl ?? mae) * 0.9 && (mfe === null || mfe < (tp ?? Infinity) * 0.3)) {
    return fail('RAN_TO_STOP_FIRST',
      `Price went straight to the stop${mfe !== null ? ` with a maximum favourable excursion of only ${mfe.toFixed(1)}p` : ''} — ` +
      'the entry fought the immediate flow. Consider waiting for confirmation candles after the signal.',
      'WARN')
  }
  // 4. Reversal after a meaningful favourable move — partial-take / BE candidate.
  if (mfe !== null && tp && mfe >= tp * 0.5 && mae >= (sl ?? mae)) {
    return fail('GAVE_BACK_AFTER_MFE',
      `Reached ${mfe.toFixed(1)}p favourable (≥50% of the ${tp.toFixed(1)}p target) then reversed into the stop. ` +
      'This is a partial-take-profit / break-even trigger candidate rather than an entry error.',
      'WARN')
  }
  // 5. Wide spread at entry consumed the edge.
  if (input.spreadCond === 'wide' && sl) {
    return fail('WIDE_SPREAD_ENTRY',
      "Entry spread was 'wide' relative to ATR — the trade started underwater by the spread cost, " +
      'making the realised R smaller than planned. Wait for spread normalisation before entering.',
      'WARN')
  }
  // 6. Low-confidence / low-agreement entries losing money is overtrading noise.
  if ((input.confidence ?? 100) < 70 || (input.agreement ?? 100) < 50) {
    return fail('WEAK_CONVICTION_ENTRY',
      `Entry carried weak conviction (confidence ${input.confidence ?? '—'}%, agreement ${input.agreement ?? '—'}%). ` +
      'Losses on low-conviction signals are the first place to cut.',
      'INFO')
  }
  return fail('STANDARD_STOP_OUT',
    `Standard stop-out. Adverse excursion ${mae.toFixed(1)}p within a ${input.regime ?? 'unknown'} regime. ` +
    (mfe !== null ? `Best favourable move was ${mfe.toFixed(1)}p. ` : '') +
    'No systematic failure signature detected in this single loss.',
    'INFO')
}

// ── Persistence ───────────────────────────────────────────────────────────────

export interface SavedDiagnosisRow {
  source: 'closed_trade' | 'prediction' | 'reconciliation'
  sourceId: string
  pair: string
  direction: 'BUY' | 'SELL'
  result: DiagnosisResult
  rMultiple?: number | null
  mfePips?: number | null
  maePips?: number | null
  userId?: string | null
}

/** Idempotent save — one diagnosis per (source, source_id). Never throws. */
export async function saveDiagnosis(row: SavedDiagnosisRow): Promise<string | null> {
  try {
    const admin = getAdminClient()
    const { data, error } = await admin
      .from('trade_diagnoses')
      .upsert({
        user_id: row.userId ?? null,
        source: row.source,
        source_id: row.sourceId,
        pair: row.pair,
        direction: row.direction,
        outcome: 'LOSS',
        r_multiple: row.rMultiple ?? null,
        mfe_pips: row.mfePips ?? null,
        mae_pips: row.maePips ?? null,
        diagnosis_code: row.result.code,
        diagnosis: row.result.diagnosis,
        severity: row.result.severity,
        evidence: row.result.evidence,
      }, { onConflict: 'source,source_id', ignoreDuplicates: true })
      .select('id')
      .single()
    if (error) { console.warn('[diagnosis] save failed:', error.message); return null }
    return data?.id ?? null
  } catch (e: any) {
    console.warn('[diagnosis] save failed:', e?.message)
    return null
  }
}

/** Aggregate the recurring failure patterns for the last N days. */
export async function recurringFailurePatterns(days = 30, userId?: string | null) {
  const admin = getAdminClient()
  let q = admin
    .from('trade_diagnoses')
    .select('diagnosis_code, severity')
    .gte('created_at', new Date(Date.now() - days * 86400_000).toISOString())
    .order('created_at', { ascending: false })
    .limit(2000)
  if (userId) q = q.eq('user_id', userId)
  const { data, error } = await q
  if (error) return { counts: {}, critical: 0, warn: 0, n: 0 }
  const counts: Record<string, number> = {}
  let critical = 0, warn = 0
  for (const r of data || []) {
    counts[r.diagnosis_code] = (counts[r.diagnosis_code] ?? 0) + 1
    if (r.severity === 'CRITICAL') critical++
    if (r.severity === 'WARN') warn++
  }
  const ranked = Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([code, count]) => ({ code, count }))
  return { counts, ranked, critical, warn, n: (data || []).length }
}
