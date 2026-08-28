// app/api/scalper/analytics/route.ts
// Audit Phase 4 (item 14): Session / Regime / Confidence-band dashboards.
//
// Aggregates RESOLVED prediction_logs (WIN/LOSS) into the three slices the
// audit called for, so the operator can see WHERE the edge lives:
//
//   bySession       — win rate by 4-bucket UTC session (Asian/London/NY+LON/NY)
//   byRegime        — win rate by market regime (chop/ranging/weak-trend/…)
//   byConfidenceBand — win rate by confidence bucket (50-59 … 90+)
//
// Also returns a blended `expectancy` (avg MFE − avg MAE) per slice so a high
// win-rate slice with terrible MFE/MAE is visible as unprofitable.
export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { getAdminClient } from '@/lib/supabase'

const MAX_ROWS = 5000
const CONFIDENCE_BANDS = [
  { label: '50–59', min: 50, max: 59 },
  { label: '60–69', min: 60, max: 69 },
  { label: '70–79', min: 70, max: 79 },
  { label: '80–89', min: 80, max: 89 },
  { label: '90+',   min: 90, max: 100 },
]

function sessionBucket(iso: string | null): string {
  if (!iso) return 'unknown'
  const h = new Date(iso).getUTCHours()
  if (h >= 22 || h < 7)  return 'Asian'
  if (h >= 7  && h < 13) return 'London'
  if (h >= 13 && h < 17) return 'NY+LON'
  return 'NY'
}

interface Slice { n: number; wins: number; losses: number; winRate: number | null; avgMfe: number | null; avgMae: number | null; expectancy: number | null }

function emptySlice(): Slice {
  return { n: 0, wins: 0, losses: 0, winRate: null, avgMfe: null, avgMae: null, expectancy: null }
}

function addToSlice(s: Slice, outcome: string | null, mfe: number | null, mae: number | null): void {
  if (outcome !== 'WIN' && outcome !== 'LOSS') return
  s.n++
  if (outcome === 'WIN') s.wins++; else s.losses++
  s.avgMfe = s.avgMfe === null ? (mfe ?? 0) : s.avgMfe + (mfe ?? 0)
  s.avgMae = s.avgMae === null ? (mae ?? 0) : s.avgMae + (mae ?? 0)
}

function finalize(s: Slice): Slice {
  if (s.n === 0) return s
  const scored = s.wins + s.losses
  if (scored > 0) s.winRate = Math.round((s.wins / scored) * 100)
  s.avgMfe = +((s.avgMfe ?? 0) / s.n).toFixed(2)
  s.avgMae = +((s.avgMae ?? 0) / s.n).toFixed(2)
  s.expectancy = +(s.avgMfe - s.avgMae).toFixed(2)
  return s
}

export async function GET(req: NextRequest) {
  try {
    const days = Math.min(90, Math.max(1, parseInt(req.nextUrl.searchParams.get('days') || '30', 10)))
    const sb = getAdminClient()
    const cutoff = new Date(Date.now() - days * 86400_000).toISOString()

    const { data, error } = await sb
      .from('prediction_logs')
      .select('pair, direction, confidence, outcome, regime, mfe_pips, mae_pips, created_at')
      .gte('created_at', cutoff)
      .order('created_at', { ascending: false })
      .limit(MAX_ROWS)

    if (error) throw error
    const rows: any[] = data || []

    // ── bySession ──────────────────────────────────────────────────────────
    const sessionKeys = ['Asian', 'London', 'NY+LON', 'NY', 'unknown']
    const bySession: Record<string, Slice> = Object.fromEntries(sessionKeys.map(k => [k, emptySlice()]))
    // ── byRegime ───────────────────────────────────────────────────────────
    const regimeKeys = ['chop', 'ranging', 'weak-trend', 'trending', 'strong-trend', 'unknown']
    const byRegime: Record<string, Slice> = Object.fromEntries(regimeKeys.map(k => [k, emptySlice()]))
    // ── byConfidenceBand ───────────────────────────────────────────────────
    const byConfidence: Record<string, Slice> = Object.fromEntries(CONFIDENCE_BANDS.map(b => [b.label, emptySlice()]))

    for (const r of rows) {
      const s = sessionBucket(r.created_at)
      addToSlice(bySession[s], r.outcome, Number(r.mfe_pips ?? 0), Number(r.mae_pips ?? 0))

      const reg = r.regime && regimeKeys.includes(r.regime) ? r.regime : 'unknown'
      addToSlice(byRegime[reg], r.outcome, Number(r.mfe_pips ?? 0), Number(r.mae_pips ?? 0))

      const conf = Number(r.confidence ?? 0)
      const band = CONFIDENCE_BANDS.find(b => conf >= b.min && conf <= b.max)
      addToSlice(byConfidence[band ? band.label : '90+'], r.outcome, Number(r.mfe_pips ?? 0), Number(r.mae_pips ?? 0))
    }

    const sliceToArray = (m: Record<string, Slice>) =>
      Object.entries(m).map(([label, sl]) => ({ label, ...finalize(sl) }))

    return NextResponse.json({
      days,
      totalResolved: rows.filter(r => r.outcome === 'WIN' || r.outcome === 'LOSS').length,
      bySession: sliceToArray(bySession),
      byRegime: sliceToArray(byRegime),
      byConfidenceBand: sliceToArray(byConfidence),
    })
  } catch (e: any) {
    console.error('[scalper/analytics]', e?.message)
    return NextResponse.json({ error: e?.message || 'analytics failed' }, { status: 500 })
  }
}
