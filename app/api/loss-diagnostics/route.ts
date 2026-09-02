// app/api/loss-diagnostics/route.ts
// Automatic loss diagnosis.
//   GET  ?days=30&userId=       → recent diagnoses + recurring failure patterns
//   POST { source, sourceId, userId? } →
//        Loads the losing row (closed_trade | prediction | reconciliation),
//        diagnoses it, persists (idempotent per source+id) and returns it.
export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { getAdminClient } from '@/lib/supabase'
import { diagnoseLoss, saveDiagnosis, recurringFailurePatterns } from '@/lib/loss-diagnosis'
import { pipSizeOf } from '@/lib/expectancy-engine'
import { getPipValuePerLot } from '@/lib/brokers/interface'

export async function GET(req: NextRequest) {
  try {
    const userId = req.nextUrl.searchParams.get('userId') || null
    const days = Math.min(90, Math.max(1, parseInt(req.nextUrl.searchParams.get('days') || '30', 10)))
    const admin = getAdminClient()

    let q = admin
      .from('trade_diagnoses')
      .select('*')
      .gte('created_at', new Date(Date.now() - days * 86400_000).toISOString())
      .order('created_at', { ascending: false })
      .limit(200)
    q = userId ? q.eq('user_id', userId) : q.is('user_id', null)
    const { data } = await q

    const patterns = await recurringFailurePatterns(days, userId)
    return NextResponse.json({ days, diagnoses: data ?? [], patterns })
  } catch (e: any) {
    console.error('[loss-diagnostics GET]', e?.message)
    return NextResponse.json({ error: e?.message || 'loss-diagnostics failed' }, { status: 500 })
  }
}

async function loadSourceRow(admin: any, source: string, sourceId: string, userId?: string | null) {
  let q
  if (source === 'closed_trade') {
    q = admin.from('trades')
      .select('id, pair, direction, entry_price, sl_price, tp_price, lots, pl_usd, result, opened_at, closed_at, user_id')
      .eq('id', sourceId)
  } else if (source === 'prediction') {
    q = admin.from('prediction_logs')
      .select('id, pair, direction, entry, sl, tp, outcome, mfe_pips, mae_pips, created_at, indicator_snapshot, user_id')
      .eq('id', sourceId)
  } else {
    q = admin.from('signal_reconciliation')
      .select('id, pair, direction, entry_price, resolved_price, outcome, movement_pips, sl, tp, mfe_pips, mae_pips, generated_at, user_id')
      .eq('id', sourceId)
  }
  if (userId) q = q.eq('user_id', userId)
  const { data } = await q
  return data?.[0] ?? null
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const { source, sourceId, userId } = body as {
      source: 'closed_trade' | 'prediction' | 'reconciliation'
      sourceId: string
      userId?: string | null
    }
    if (!['closed_trade', 'prediction', 'reconciliation'].includes(source) || !sourceId) {
      return NextResponse.json({ error: 'source and sourceId required' }, { status: 400 })
    }
    const admin = getAdminClient()
    const row = await loadSourceRow(admin, source, sourceId, userId)
    if (!row) return NextResponse.json({ error: 'row not found' }, { status: 404 })

    const pip = pipSizeOf(row.pair)
    const asPips = (a: number | null, b: number | null): number | null => {
      if (a === null || b === null) return null
      return Math.abs(a - b) / pip
    }
    const slPips = source === 'closed_trade'
      ? asPips(row.entry_price, row.sl_price)
      : asPips(row.entry, row.sl)
    const tpPips = source === 'closed_trade'
      ? asPips(row.entry_price, row.tp_price)
      : asPips(row.entry, row.tp)

    const direction = row.direction as 'BUY' | 'SELL'
    const outcome = source === 'closed_trade'
      ? row.result
      : row.outcome
    if (outcome !== 'LOSS') {
      return NextResponse.json({ message: `Row resolved as ${outcome} — automatic diagnosis only applies to losses.`, outcome }, { status: 200 })
    }
    const rMultiple = source === 'closed_trade' && slPips && slPips > 0
      ? (row.pl_usd ?? 0) / (slPips * getPipValuePerLot(row.pair) * (row.lots ?? 0.01))
      : null

    const snap = row.indicator_snapshot || {}
    const diag = diagnoseLoss({
      pair: row.pair,
      direction,
      outcome,
      rMultiple,
      mfePips: row.mfe_pips ?? null,
      maePips: row.mae_pips ?? null,
      slPips,
      tpPips,
      atrPips: snap.atrPips ?? null,
      regime: snap?._regime?.marketRegime ?? row.regime ?? null,
      session: snap?._regime?.session ?? row.session ?? null,
      spreadCond: snap?._regime?.spreadCondition ?? row.spread_condition ?? null,
      confidence: row.confidence ?? null,
      agreement: row.agreement_score ?? snap?._audit?.agreementScore ?? null,
    })

    const savedId = await saveDiagnosis({
      source,
      sourceId,
      pair: row.pair,
      direction,
      result: diag,
      rMultiple,
      mfePips: row.mfe_pips ?? null,
      maePips: row.mae_pips ?? null,
      userId: userId ?? row.user_id ?? null,
    })

    return NextResponse.json({ diagnosis: { id: savedId, ...diag }, source, sourceId })
  } catch (e: any) {
    console.error('[loss-diagnostics POST]', e?.message)
    return NextResponse.json({ error: e?.message || 'diagnosis failed' }, { status: 500 })
  }
}
