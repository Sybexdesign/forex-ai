// app/api/signal-reconciliation/route.ts
// Aggregation endpoint for the Scalp vs Mirror signal reconciliation module.
// Returns rolling win-rate per signal_type over configurable windows
// (last 50 signals, last 7 days, last 30 days) plus the inconclusive rate.
//
// Query params:
//   userId  — required, the authenticated user's UUID
//   window  — optional, one of '50' | '7d' | '30d' (default '50')
//
// Response shape:
//   {
//     scalp:  { winRate, n, wins, losses, inconclusive, inconclusiveRate },
//     mirror: { winRate, n, wins, losses, inconclusive, inconclusiveRate },
//     windows: { '50': {...}, '7d': {...}, '30d': {...} }  // all windows
//   }

export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { getAdminClient } from '@/lib/supabase'

// Config values pulled from env — not hardcoded.
// NOISE_THRESHOLD_PIPS: minimum movement (in pips) for a signal to be scored
//   WIN/LOSS. Below this, the outcome is INCONCLUSIVE (noise, not confirmation).
//   Default 0.3 pips.
const NOISE_THRESHOLD_PIPS = parseFloat(process.env.SIGNAL_RECON_NOISE_THRESHOLD_PIPS || '0.3')

// Rolling window sizes for aggregation — pulled from env, not hardcoded.
//   SIGNAL_RECON_WINDOW_50  — last N signals per type (default 50)
//   SIGNAL_RECON_WINDOW_7D  — days (default 7)
//   SIGNAL_RECON_WINDOW_30D — days (default 30)
const WINDOW_50  = parseInt(process.env.SIGNAL_RECON_WINDOW_50  || '50', 10)
const WINDOW_7D  = parseInt(process.env.SIGNAL_RECON_WINDOW_7D  || '7',  10)
const WINDOW_30D = parseInt(process.env.SIGNAL_RECON_WINDOW_30D || '30', 10)


interface TypeStats {
  winRate: number | null
  n: number
  wins: number
  losses: number
  inconclusive: number
  inconclusiveRate: number | null
}

function emptyStats(): TypeStats {
  return { winRate: null, n: 0, wins: 0, losses: 0, inconclusive: 0, inconclusiveRate: null }
}

function computeStats(rows: any[]): TypeStats {
  const s = emptyStats()
  for (const r of rows) {
    s.n++
    if (r.outcome === 'WIN') s.wins++
    else if (r.outcome === 'LOSS') s.losses++
    else if (r.outcome === 'INCONCLUSIVE') s.inconclusive++
  }
  const scored = s.wins + s.losses
  if (scored > 0) s.winRate = Math.round((s.wins / scored) * 100)
  if (s.n > 0) s.inconclusiveRate = Math.round((s.inconclusive / s.n) * 100)
  return s
}

export async function GET(req: NextRequest) {
  const userId = req.nextUrl.searchParams.get('userId')
  if (!userId) return NextResponse.json({ error: 'userId required' }, { status: 400 })

  try {
    const sb = getAdminClient()

    // Fetch all resolved signals for this user, ordered newest first.
    // We fetch a generous limit (500) and compute all windows in JS to avoid
    // multiple round-trips. The table is small per-user so this is fine.
    const { data, error } = await sb
      .from('signal_reconciliation')
      .select('signal_type, outcome, generated_at')
      .eq('user_id', userId)
      .not('outcome', 'is', null)
      .order('generated_at', { ascending: false })
      .limit(500)

    if (error) throw error

    const rows: any[] = data || []
    const now = Date.now()

    // Helper: filter rows by window
    const byWindow = (limit: number | null, days: number | null) => {
      let filtered = rows
      if (days !== null) {
        const cutoff = new Date(now - days * 86400_000).toISOString()
        filtered = rows.filter(r => r.generated_at >= cutoff)
      }
      if (limit !== null) filtered = filtered.slice(0, limit)
      return filtered
    }

    const scalpRows  = (t: any[]) => t.filter(r => r.signal_type === 'scalp')
    const mirrorRows = (t: any[]) => t.filter(r => r.signal_type === 'mirror')

    // Compute stats for each window
    const windows: Record<string, { scalp: TypeStats; mirror: TypeStats }> = {}

    // Last 50 signals per type
    const w50 = byWindow(WINDOW_50, null)
    windows['50'] = {
      scalp:  computeStats(scalpRows(w50)),
      mirror: computeStats(mirrorRows(w50)),
    }

    // Last 7 days
    const w7d = byWindow(null, WINDOW_7D)
    windows['7d'] = {
      scalp:  computeStats(scalpRows(w7d)),
      mirror: computeStats(mirrorRows(w7d)),
    }

    // Last 30 days
    const w30d = byWindow(null, WINDOW_30D)
    windows['30d'] = {
      scalp:  computeStats(scalpRows(w30d)),
      mirror: computeStats(mirrorRows(w30d)),
    }

    // Default window for the UI badge is '50'
    const defaultWindow = windows['50']

    return NextResponse.json({
      noiseThresholdPips: NOISE_THRESHOLD_PIPS,
      windows,
      scalp:  defaultWindow.scalp,
      mirror: defaultWindow.mirror,
    })
  } catch (e: any) {
    console.error('[signal-reconciliation GET]', e?.message)
    return NextResponse.json({ error: e?.message || 'signal-reconciliation failed' }, { status: 500 })
  }
}
