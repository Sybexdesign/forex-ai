// app/api/scalper/label/route.ts
// Signal outcome labeller — called by Vercel cron every 5 minutes.
// Fetches PENDING signals older than 5 minutes, checks M5 candle data from
// the EA's candle cache, and writes WIN or LOSS back to the signals table.
//
// Labelling logic (M5 candles, BUY example):
//   - Check the candle containing signal.created_at and the following 2 candles
//   - If any candle's high >= tp  → WIN
//   - If any candle's low  <= sl  → LOSS
//   - If a candle hits both       → LOSS (conservative)
//   - If no hit after window      → LOSS (timeout)

import { NextRequest, NextResponse } from 'next/server'
import { getAdminClient } from '@/lib/supabase'
import { getPipValue } from '@/lib/brokers/interface'

export const dynamic = 'force-dynamic'

interface EACandle { t: number; o: number; h: number; l: number; c: number; v: number }

// How many M5 candles to check after the signal candle (6 candles = 30 min window)
// Extended from 3 (15 min) — the 15-min timeout caused systematic LOSS labeling for
// counter-trend signals during trending sessions. XAU/USD ATR-based TPs often need
// 20-30 min to reach. Premature timeout was artificially suppressing the BUY win rate.
const CANDLE_WINDOW = 6
// Only label signals older than this (ensures price data is available)
const MIN_AGE_MS    = 5 * 60_000
// Max candle cache age before we consider it stale
const CACHE_TTL_MS  = 90 * 60_000
// M5 candle cache holds ~200 candles ≈ 16.7 hours; skip signals older than this
// to avoid mis-labelling with candles from the wrong time window
const MAX_SIGNAL_AGE_MS = 16 * 60 * 60_000

// Mirror the max-SL caps from the signal route so legacy reconstruction stays consistent
function maxSlDistance(pair: string): number {
  if (pair.startsWith('XAU')) return 80 * 0.1    // 8.0 price units
  if (pair.startsWith('XAG')) return 60 * 0.01   // 0.60
  if (pair.includes('JPY'))   return 50 * 0.01
  return                              40 * 0.0001
}

function reconstructSlTp(snap: any, direction: string, pair: string) {
  // Prefer pre-computed values stored by the signal route (new signals)
  if (snap?._computed?.sl && snap?._computed?.tp && snap?._computed?.entry) {
    return { entry: snap._computed.entry, sl: snap._computed.sl, tp: snap._computed.tp }
  }
  // Reconstruct from raw snapshot (legacy / analyze-route signals)
  const price  = snap?.currentPrice || snap?.price || 0
  const scalper = snap?.scalper || {}
  const atr    = scalper.atr || snap?.atr || 0.0005
  const maxSl  = maxSlDistance(pair)
  const slDist = Math.min(atr * 1.5, maxSl)
  const tpDist = slDist * (4 / 3)
  const sl = direction === 'BUY' ? price - slDist : price + slDist
  const tp = direction === 'BUY' ? price + tpDist : price - tpDist
  return { entry: price, sl, tp }
}

function labelFromCandles(
  candles:   EACandle[],
  signalTs:  number,   // unix seconds
  sl:        number,
  tp:        number,
  direction: string,
): 'WIN' | 'LOSS' | null {
  // Find the index of the candle whose window contains signalTs
  const M5 = 5 * 60
  let startIdx = candles.findIndex((c, i) => {
    const next = candles[i + 1]
    return c.t <= signalTs && (next ? next.t > signalTs : true)
  })
  if (startIdx < 0) startIdx = candles.length - 1  // fallback to last candle

  const window = candles.slice(startIdx, startIdx + CANDLE_WINDOW + 1)
  if (window.length === 0) return null

  for (const c of window) {
    const tpHit = direction === 'BUY' ? c.h >= tp  : c.l <= tp
    const slHit = direction === 'BUY' ? c.l <= sl  : c.h >= sl
    if (tpHit && !slHit) return 'WIN'
    if (slHit)           return 'LOSS'  // SL hit or both = LOSS
  }
  return 'LOSS'  // timeout — didn't reach TP
}

export async function GET(req: NextRequest) {
  // Simple secret check so only Vercel cron or admin can trigger
  const secret = req.nextUrl.searchParams.get('secret')
  if (secret !== process.env.CRON_SECRET && process.env.NODE_ENV === 'production') {
    const cronHeader = req.headers.get('x-vercel-cron')
    if (!cronHeader) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }
  }

  try {
    const sb        = getAdminClient()
    const cutoff    = new Date(Date.now() - MIN_AGE_MS).toISOString()
    // Don't attempt to label signals older than the candle cache window —
    // the candle data for that period is gone and we'd label against wrong candles.
    const oldestOk  = new Date(Date.now() - MAX_SIGNAL_AGE_MS).toISOString()

    // ── Fetch PENDING signals older than MIN_AGE_MS ───────────────────────
    const { data: signals, error: sigErr } = await sb
      .from('signals')
      .select('id, user_id, pair, direction, indicator_snapshot, created_at')
      .eq('outcome', 'PENDING')
      .lt('created_at', cutoff)
      .gt('created_at', oldestOk)
      .order('created_at', { ascending: true })
      .limit(500)

    if (sigErr) throw sigErr
    if (!signals || signals.length === 0) {
      return NextResponse.json({ labelled: 0, message: 'No pending signals to label' })
    }

    // ── Fetch candle caches for all relevant users ────────────────────────
    const userIds = [...new Set(signals.map((s: any) => s.user_id))]
    const { data: configs } = await sb
      .from('broker_configs')
      .select('user_id, config')
      .in('user_id', userIds)
      .in('broker_type', ['mt5direct', 'exness'])

    // Build candleCache lookup: userId → { "XAUUSD_M5": [...candles] }
    const candleCacheByUser: Record<string, Record<string, EACandle[]>> = {}
    const now = Date.now()
    for (const cfg of configs || []) {
      const cache = cfg.config?.candleCache
      if (!cache) continue
      const updatedAt = cfg.config?.updatedAt
      if (updatedAt && now - new Date(updatedAt).getTime() > CACHE_TTL_MS) continue
      const userCache: Record<string, EACandle[]> = {}
      for (const [key, entry] of Object.entries(cache as Record<string, any>)) {
        if (key.endsWith('_M5') && Array.isArray(entry.candles)) {
          userCache[key] = entry.candles
        }
      }
      if (Object.keys(userCache).length > 0) {
        candleCacheByUser[cfg.user_id] = userCache
      }
    }

    // ── Label each signal ─────────────────────────────────────────────────
    let labelled = 0, wins = 0, losses = 0, skipped = 0

    for (const sig of signals as any[]) {
      const userCache = candleCacheByUser[sig.user_id]
      if (!userCache) { skipped++; continue }

      const sym     = sig.pair.replace('/', '')
      const candles = userCache[`${sym}_M5`]
      if (!candles || candles.length < 3) { skipped++; continue }

      const { sl, tp } = reconstructSlTp(sig.indicator_snapshot, sig.direction, sig.pair)
      if (!sl || !tp || sl === tp) { skipped++; continue }

      const signalTs = Math.floor(new Date(sig.created_at).getTime() / 1000)
      const outcome  = labelFromCandles(candles, signalTs, sl, tp, sig.direction)
      if (!outcome) { skipped++; continue }

      const { error: updateErr } = await sb
        .from('signals')
        .update({ outcome })
        .eq('id', sig.id)

      if (!updateErr) {
        labelled++
        if (outcome === 'WIN') wins++; else losses++
      }
    }

    const msg = `Labelled ${labelled} signals (${wins}W/${losses}L) — skipped ${skipped} (no candle data)`
    console.log(`[scalper/label] ${msg}`)
    return NextResponse.json({ labelled, wins, losses, skipped, total: signals.length })

  } catch (e: any) {
    console.error('[scalper/label]', e.message)
    return NextResponse.json({ error: e.message }, { status: 500 })
  }
}
