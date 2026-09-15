// lib/supabase.ts
import { createClient, type SupabaseClient } from '@supabase/supabase-js'

function getUrl() {
  // SUPABASE_URL is a server-side runtime var that bypasses Next.js build-time substitution
  return process.env.SUPABASE_URL
    || process.env.NEXT_PUBLIC_SUPABASE_URL
    || 'https://xyzplaceholder.supabase.co'
}
function getAnonKey() {
  return process.env.SUPABASE_ANON_KEY
    || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
    || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.placeholder'
}
function getServiceKey() {
  return process.env.SUPABASE_SERVICE_ROLE_KEY || getAnonKey()
}

// Wrap fetch with a hard timeout so a slow/unresponsive Supabase auth
// service doesn't hang the UI for 30+ seconds (observed as HTTP 504 from
// the auth endpoint). 10s is generous for normal auth calls.
const AUTH_TIMEOUT_MS = 10_000

function timedFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), AUTH_TIMEOUT_MS)
  return fetch(input, { ...init, signal: controller.signal })
    .finally(() => clearTimeout(timer))
}

let _browser: SupabaseClient | null = null
export function getSupabase() {
  if (!_browser) {
    _browser = createClient(getUrl(), getAnonKey(), {
      global: { fetch: timedFetch },
    })
  }
  return _browser
}


export function getAdminClient() {
  return createClient(getUrl(), getServiceKey(), {
    auth: { autoRefreshToken: false, persistSession: false }
  })
}

// Legacy export for compatibility
export const supabase = {
  from: (...args: Parameters<SupabaseClient['from']>) => getSupabase().from(...args),
  auth: { getUser: () => getSupabase().auth.getUser() },
}

export interface BrokerConfig {
  id: string
  user_id: string
  broker_type: string
  label: string
  config: Record<string, string>
  is_active: boolean
  created_at: string
}

export interface UserProfile {
  id: string
  email: string
  full_name?: string
  role: 'user' | 'admin'
  created_at: string
}

export interface StrategySettings {
  style: 'Scalper' | 'Day Trader' | 'Swing' | 'Position'
  riskPct: number
  maxLoss: number
  maxPositions: number
  minStrength: number
  tpPips: number
  slPips: number
  watchlist: string[]
  sessionStart: number
  sessionEnd: number
  hardDailyStop: boolean
  hardNews: boolean
  demoLock: boolean
  // Optional fixed-lot override. null/undefined = auto-size (balance × riskPct ÷ slPips).
  // When > 0 the orders route uses this lot size and NEVER rewrites it; the STOP
  // DISTANCE is derived from manualRiskPct instead (see lib/manual-sizing.mjs).
  manualLots?: number | null
  /**
   * MANUAL-MODE RISK BUDGET — percentage of account value.
   *
   * This is a BUDGET, not a promise: the strategy SL cap can bind tighter than the
   * budget allows, in which case ACTUAL risk is lower than the budget. Both are
   * surfaced separately by the sizing policy.
   *
   * ONLY consulted when manualLots > 0. It must never influence AUTO sizing.
   * The canonical default lives in DEFAULT_STRATEGY below — the sizing policy
   * deliberately carries no default of its own, so UI / API / policy cannot drift.
   */
  manualRiskPct?: number | null
  // Optional override for the 1R hard-cap multiplier in mt5-sync trade manager.
  // Defaults to 1.25 if unset. Surfaced here so the orders route can read the
  // user's preferred cap when reducing manual-lots that would exceed it.
  hardCapMultiplier?: number
}

export const DEFAULT_STRATEGY: StrategySettings = {
  style: 'Day Trader',
  riskPct: 1,
  maxLoss: 3,
  maxPositions: 2,
  minStrength: 80,    // raised from 65 — audit shows 80-85% band is the only one with strong R:R + positive net P/L
  tpPips: 50,
  slPips: 25,
  watchlist: ['EUR/USD', 'GBP/USD', 'USD/JPY', 'AUD/USD', 'XAU/USD', 'XAG/USD'],
  sessionStart: 7,
  sessionEnd: 20,
  hardDailyStop: true,
  hardNews: true,
  demoLock: false,
  // MANUAL-MODE RISK BUDGET — the ONE canonical default. Nothing else invents a
  // value: the sizing policy carries no fallback, and the API validates against
  // the ceiling below rather than substituting a number.
  //
  // ⚠️ FLAGGED FOR PRODUCT REVIEW: 25% was carried over from the interim backend
  // default and no repository requirement establishes it. It is 25x the AUTO
  // riskPct (1%), and with manualLots=10 on XAU it permits ~$3,500 of stop risk on
  // a $10,000 account (35% of the account — the SL cap binds before the 50%
  // ceiling would). Kept as-is for compatibility, explicitly not chosen here.
  manualRiskPct: 25,
}
