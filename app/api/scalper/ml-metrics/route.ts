// app/api/scalper/ml-metrics/route.ts
// Phase 5 (item 17): metrics dashboard API — calibration curve + drift.
//
// Two sources, one response:
//   1. Proxies the ML service /metrics/calibration and /metrics/drift when the
//      ML service is reachable (it owns the drift baseline file).
//   2. Falls back to computing the calibration curve directly from
//      prediction_logs in Supabase so the dashboard still works even when the
//      ML service is down.
//
// GET ?days=30 — calibration curve (binned predicted vs observed win rate),
// Brier score, PSI drift + severity.
export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { getAdminClient } from '@/lib/supabase'

const ML_URL = process.env.ML_SERVICE_URL || 'http://localhost:8100'
const MAX_ROWS = 2000

export async function GET(req: NextRequest) {
  try {
    const days = Math.min(90, Math.max(1, parseInt(req.nextUrl.searchParams.get('days') || '30', 10)))

    // ── 1. Try the ML service first (it owns the drift baseline) ────────────
    let mlCalib = null
    let mlDrift = null
    try {
      const ctrl = new AbortController()
      const timer = setTimeout(() => ctrl.abort(), 4000)
      const [cRes, dRes] = await Promise.all([
        fetch(`${ML_URL}/metrics/calibration`, { signal: ctrl.signal }),
        fetch(`${ML_URL}/metrics/drift`, { signal: ctrl.signal }),
      ])
      clearTimeout(timer)
      if (cRes.ok) mlCalib = await cRes.json()
      if (dRes.ok) mlDrift = await dRes.json()
    } catch { /* ML down — fall through to Supabase path */ }

    // ── 2. Fallback / augment: compute calibration from prediction_logs ─────
    const sb = getAdminClient()
    const cutoff = new Date(Date.now() - days * 86400_000).toISOString()
    const { data, error } = await sb
      .from('prediction_logs')
      .select('outcome, indicator_snapshot')
      .gte('created_at', cutoff)
      .in('outcome', ['WIN', 'LOSS'])
      .order('created_at', { ascending: false })
      .limit(MAX_ROWS)

    if (error) throw error

    const live: { win_prob: number; win: boolean }[] = []
    for (const r of data || []) {
      const snap = r.indicator_snapshot || {}
      const p = snap?._audit?.mlWinProb
      const pv = Number(p)
      if (!Number.isFinite(pv) || pv < 0 || pv > 1) continue
      live.push({ win_prob: pv, win: r.outcome === 'WIN' })
    }

    // Build calibration curve if we have enough rows.
    let curve: any[] = []
    let brier: number | null = null
    if (live.length >= 10) {
      const bins = [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1]
      const n = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0]
      const w = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0]
      const p = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0]
      let b = 0
      for (const r of live) {
        const idx = Math.min(9, Math.floor(r.win_prob * 10))
        n[idx]++
        w[idx] += r.win ? 1 : 0
        p[idx] += r.win_prob
        b += (r.win_prob - (r.win ? 1 : 0)) ** 2
      }
      brier = +(b / live.length).toFixed(4)
      for (let i = 0; i < 10; i++) {
        if (n[i] === 0) continue
        curve.push({
          bin: `${bins[i]}-${bins[i + 1]}`,
          mid: +((bins[i] + bins[i + 1]) / 2).toFixed(2),
          n: n[i],
          predicted: +(p[i] / n[i]).toFixed(3),
          observed: +(w[i] / n[i]).toFixed(3),
          absErr: +Math.abs(p[i] / n[i] - w[i] / n[i]).toFixed(3),
        })
      }
    }

    return NextResponse.json({
      days,
      n: live.length,
      // Prefer ML-service drift (has baseline); else unavailable.
      drift: mlDrift && mlDrift.available ? mlDrift : null,
      calibration: mlCalib && mlCalib.available ? mlCalib : { available: true, n: live.length, bins: curve, brier },
      source: mlCalib && mlCalib.available ? 'ml-service' : 'supabase-fallback',
    })
  } catch (e: any) {
    console.error('[ml-metrics]', e?.message)
    return NextResponse.json({ error: e?.message || 'ml-metrics failed' }, { status: 500 })
  }
}
