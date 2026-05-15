// app/api/prop-firm/route.ts — GET/POST prop-firm settings for the authenticated user
import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { DEFAULT_PROP_FIRM } from '@/lib/propfirm'

function userClient(token: string) {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { global: { headers: { Authorization: `Bearer ${token}` } }, auth: { autoRefreshToken: false, persistSession: false } }
  )
}

function getToken(req: NextRequest) {
  return req.headers.get('Authorization')?.replace('Bearer ', '') ?? ''
}

export async function GET(req: NextRequest) {
  const token = getToken(req)
  if (!token) return NextResponse.json({ settings: DEFAULT_PROP_FIRM })
  const sb = userClient(token)
  const { data } = await sb.from('prop_firm_settings').select('*').single()
  if (!data) return NextResponse.json({ settings: DEFAULT_PROP_FIRM })
  return NextResponse.json({ settings: dbToSettings(data) })
}

export async function POST(req: NextRequest) {
  const token = getToken(req)
  if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const { settings } = await req.json()
  const sb = userClient(token)
  const { data: { user } } = await sb.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const row = settingsToDb(settings, user.id)
  const { data, error } = await sb
    .from('prop_firm_settings')
    .upsert(row, { onConflict: 'user_id' })
    .select().single()
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ settings: dbToSettings(data) })
}

function dbToSettings(d: any) {
  return {
    enabled: d.enabled,
    firmType: d.firm_type,
    phase: d.phase,
    accountSize: +d.account_size,
    initialBalance: +d.initial_balance,
    maxDailyLossPct: +d.max_daily_loss_pct,
    maxTotalDrawdownPct: +d.max_total_drawdown_pct,
    profitTargetPct: +d.profit_target_pct,
    minTradingDays: +d.min_trading_days,
    noOvernight: d.no_overnight,
    noWeekend: d.no_weekend,
    newsRestriction: d.news_restriction,
    consistencyRulePct: +d.consistency_rule_pct,
  }
}

function settingsToDb(s: any, userId: string) {
  return {
    user_id: userId,
    enabled: s.enabled,
    firm_type: s.firmType,
    phase: s.phase,
    account_size: s.accountSize,
    initial_balance: s.initialBalance,
    max_daily_loss_pct: s.maxDailyLossPct,
    max_total_drawdown_pct: s.maxTotalDrawdownPct,
    profit_target_pct: s.profitTargetPct,
    min_trading_days: s.minTradingDays,
    no_overnight: s.noOvernight,
    no_weekend: s.noWeekend,
    news_restriction: s.newsRestriction,
    consistency_rule_pct: s.consistencyRulePct,
    updated_at: new Date().toISOString(),
  }
}
