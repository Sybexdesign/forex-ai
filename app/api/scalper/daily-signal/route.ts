// app/api/scalper/daily-signal/route.ts
export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'

const ML_URL = process.env.ML_SERVICE_URL || 'http://localhost:8100'

type Direction = 'BUY' | 'SELL' | 'HOLD'

// ATR multipliers for daily-scale signal levels
const SL_MULT  = 2.0   // wider SL for daily context
const TP1_MULT = 1.5   // 1:1.5 risk-reward partial
const TP2_MULT = 2.5   // 1:2.5 core target
const TP3_MULT = 4.0   // 1:4.0 runner target

function pipSize(pair: string): number {
  if (pair.startsWith('XAU')) return 0.1
  if (pair.startsWith('XAG')) return 0.01
  if (pair.includes('JPY'))   return 0.01
  return 0.0001
}

function dp(pair: string): number {
  if (pair.startsWith('XA')) return 2
  if (pair.includes('JPY'))  return 3
  return 5
}

async function fetchMl<T>(path: string, opts?: RequestInit): Promise<T | null> {
  try {
    const ctrl  = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), 4000)
    const resp  = await fetch(`${ML_URL}${path}`, { signal: ctrl.signal, ...opts })
    clearTimeout(timer)
    if (!resp.ok) return null
    return await resp.json() as T
  } catch {
    return null
  }
}

interface DailyPrediction {
  pair:                   string
  metal:                  string
  up_probability:         number
  direction:              'UP' | 'DOWN'
  confidence:             number
  feature_date:           string
  feature_contributions:  Record<string, { importance: number; value: number }>
  cached:                 boolean
}

interface WorkerStatus {
  worker_status:  string
  last_trained?:  string
  model_auc?:     number
  model_accuracy?: number
  dataset_size?:  number
  model_version?: number
  data_freshness?: string
  rows_added?:    number
  top_features?:  string[]
}

// Layer confirmation checks (6 layers from the ScalperPage architecture)
function buildLayerConfirmations(
  direction: Direction,
  pred: DailyPrediction,
  tick: Record<string, number>,
): { name: string; confirmed: boolean; note: string }[] {
  const up = direction === 'BUY'

  return [
    {
      name:      'Market Data',
      confirmed: true,
      note:      `${pred.metal} daily price from cached CSV (${pred.feature_date})`,
    },
    {
      name:      'Feature Extraction',
      confirmed: true,
      note:      `${Object.keys(pred.feature_contributions).length} features → XGBoost`,
    },
    {
      name:      'Daily ML Model',
      confirmed: pred.confidence >= 60,
      note:      `${up ? 'UP' : 'DOWN'} ${pred.confidence}% confidence (AUC model)`,
    },
    {
      name:      'Trend Alignment (EMA50)',
      confirmed: up ? tick.price > tick.ema50 : tick.price < tick.ema50,
      note:      `Price ${tick.price > tick.ema50 ? 'above' : 'below'} EMA50 (${tick.ema50?.toFixed(2)})`,
    },
    {
      name:      'Momentum (MACD)',
      confirmed: up ? tick.macdHistogram > 0 : tick.macdHistogram < 0,
      note:      `MACD histogram ${tick.macdHistogram > 0 ? '+' : ''}${tick.macdHistogram?.toFixed(4)}`,
    },
    {
      name:      'Volatility Gate',
      confirmed: (tick.atrPips ?? 0) >= 3,
      note:      `ATR ${tick.atrPips?.toFixed(1)} pips (min 3)`,
    },
  ]
}

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const pair      = searchParams.get('pair')      || 'XAU/USD'
  const timeframe = searchParams.get('timeframe') || '1H'

  // Fetch ML prediction and worker status in parallel
  const [pred, workerStatus] = await Promise.all([
    fetchMl<DailyPrediction>(`/predict_daily_auto?pair=${encodeURIComponent(pair)}`),
    fetchMl<WorkerStatus>('/worker/status'),
  ])

  if (!pred) {
    return NextResponse.json(
      { error: 'Daily ML model unavailable', mlOnline: false },
      { status: 503 },
    )
  }

  // Fetch current tick for price + ATR (optional — degrade gracefully)
  let tick: Record<string, number> = {}
  try {
    const tickResp = await fetch(
      `${req.nextUrl.origin}/api/scalper/tick?pair=${encodeURIComponent(pair)}&timeframe=1H`,
      { headers: { Authorization: req.headers.get('Authorization') || '' } },
    )
    if (tickResp.ok) tick = await tickResp.json()
  } catch { /* non-critical */ }

  const price = (tick.price ?? 0)
  const atr   = (tick.atr   ?? 0)
  const pip   = pipSize(pair)
  const dec   = dp(pair)

  const direction: Direction =
    pred.confidence >= 60
      ? (pred.direction === 'UP' ? 'BUY' : 'SELL')
      : 'HOLD'

  const slDist  = atr * SL_MULT
  const tp1Dist = slDist * TP1_MULT
  const tp2Dist = slDist * TP2_MULT
  const tp3Dist = slDist * TP3_MULT

  const entry = price
  const sl    = direction === 'BUY'  ? +(entry - slDist).toFixed(dec)
              : direction === 'SELL' ? +(entry + slDist).toFixed(dec)
              : 0
  const tp1   = direction === 'BUY'  ? +(entry + tp1Dist).toFixed(dec)
              : direction === 'SELL' ? +(entry - tp1Dist).toFixed(dec)
              : 0
  const tp2   = direction === 'BUY'  ? +(entry + tp2Dist).toFixed(dec)
              : direction === 'SELL' ? +(entry - tp2Dist).toFixed(dec)
              : 0
  const tp3   = direction === 'BUY'  ? +(entry + tp3Dist).toFixed(dec)
              : direction === 'SELL' ? +(entry - tp3Dist).toFixed(dec)
              : 0

  const layers = buildLayerConfirmations(direction, pred, tick)
  const confirmedCount = layers.filter(l => l.confirmed).length

  return NextResponse.json({
    pair,
    timeframe,
    direction,
    confidence:   pred.confidence,
    upProbability: pred.up_probability,
    entry:         entry > 0 ? +entry.toFixed(dec) : null,
    sl:            sl  || null,
    tp1:           tp1 || null,
    tp2:           tp2 || null,
    tp3:           tp3 || null,
    atr:           atr  > 0 ? +atr.toFixed(dec)  : null,
    atrPips:       tick.atrPips ?? null,
    slPips:        atr  > 0 ? +(slDist  / pip).toFixed(1) : null,
    tp1Pips:       atr  > 0 ? +(tp1Dist / pip).toFixed(1) : null,
    tp2Pips:       atr  > 0 ? +(tp2Dist / pip).toFixed(1) : null,
    tp3Pips:       atr  > 0 ? +(tp3Dist / pip).toFixed(1) : null,
    featureDate:   pred.feature_date,
    featureContributions: pred.feature_contributions,
    layers,
    confirmedLayers: confirmedCount,
    totalLayers:     layers.length,
    workerStatus,
    mlOnline:      true,
    timestamp:     Date.now(),
  })
}
