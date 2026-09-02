// lib/setup-evaluator.ts
// ─────────────────────────────────────────────────────────────────────────────
// Shared glue between the Expectancy Engine, Safety Score and Trade Authority.
// One call evaluates a candidate setup, records the decision snapshot and runs
// the qualified-setup alert lifecycle. Used by /api/expectancy (evaluate) and
// the /api/scalper/signal shadow integration. Purely additive — never gates or
// modifies execution (mode defaults to 'shadow').
// ─────────────────────────────────────────────────────────────────────────────
import { getAdminClient } from '@/lib/supabase'
import {
  fetchExpectancyData, lookupSetupExpectancy, maybePersistExpectancyStats,
  type ExpectancyVerdict,
} from '@/lib/expectancy-engine'
import { computeSafetyScore, type SafetyResult } from '@/lib/safety-score'
import {
  adjudicateAuthority, recordAuthorityDecision,
  type AuthorityVerdict, type AuthorityContext,
} from '@/lib/trade-authority'
import { processQualifiedSetup, type QualifiedSetupOutcome } from '@/lib/qualified-alerts'

export interface SetupEvaluationInput {
  pair: string
  direction: 'BUY' | 'SELL' | 'HOLD'
  userId?: string | null
  mode?: 'shadow' | 'live'
  timeframe?: string
  // setup dimensions
  regime?: string | null
  session?: string | null
  volRegime?: string
  spreadCond?: string
  setupType?: string
  // gate outputs
  signalScore?: number | null
  mlWinProb?: number | null
  agreementScore?: number | null
  htfBias15m?: 'BUY' | 'SELL' | null
  htfBias1h?: 'BUY' | 'SELL' | null
  // safety inputs
  spreadPips?: number | null
  atrPips?: number | null
  spreadSource?: 'live' | 'default' | null
  slPips?: number | null
  newsInWindow?: boolean
  newsMinutesAway?: number | null
  openPositions?: number
  maxPositions?: number
  dailyLossUsedPct?: number | null
  maxDailyLossPct?: number
  // trade-plan + audit context
  entry?: number | null
  sl?: number | null
  tp?: number | null
  signalId?: string | null
  reasons?: string[]
  snapshot?: Record<string, unknown>
}

export interface SetupEvaluationResult {
  expectancy: ExpectancyVerdict | null
  safety: SafetyResult | null
  authority: AuthorityVerdict
  setupOutcome: QualifiedSetupOutcome
}

/** Record a rejection for the filter-bottleneck view. Best-effort. */
export async function recordFilterRejection(row: {
  userId?: string | null
  pair: string
  direction: 'BUY' | 'SELL' | 'HOLD'
  filterName: string
  stage: 'pre' | 'engine' | 'post' | 'authority' | 'risk' | 'execution'
  value?: number | null
  threshold?: number | null
  reason?: string
  signalId?: string | null
  snapshot?: Record<string, unknown>
}): Promise<void> {
  try {
    const admin = getAdminClient()
    await admin.from('filter_rejections').insert({
      user_id: row.userId ?? null,
      pair: row.pair,
      direction: row.direction,
      filter_name: row.filterName,
      filter_stage: row.stage,
      rejection_value: row.value ?? null,
      threshold: row.threshold ?? null,
      reason: row.reason ?? null,
      signal_id: row.signalId ?? null,
      indicator_snapshot: (row.snapshot ?? {}) as any,
    })
  } catch (e: any) {
    console.warn('[filter-rejection] record failed:', e?.message)
  }
}

// Short-TTL memo so high-frequency UI polling doesn't re-record the same setup
// every few seconds. One full evaluation + audit per (pair,direction,context)
// per minute is plenty.
const _lastEval = new Map<string, { at: number; value: SetupEvaluationResult }>()
const EVAL_TTL_MS = 45_000
const evalKeyOf = (input: SetupEvaluationInput) =>
  `${input.pair}|${input.direction}|${input.regime ?? ''}|${input.session ?? ''}|${input.signalScore ?? ''}|${input.signalId ?? ''}`

/**
 * Evaluate a setup through the new intelligence layer (shadow by default).
 * Pure monitoring/advisory — existing gates and execution paths are untouched.
 * Returns structured results for the UI / response enrichment.
 */
export async function evaluateSetup(input: SetupEvaluationInput): Promise<SetupEvaluationResult> {
  const tradable = input.direction === 'BUY' || input.direction === 'SELL'
  const userId = input.userId ?? null

  // NO_OP fast-path.
  if (!tradable) {
    const authority: AuthorityVerdict = {
      status: 'NO_OP', reasons: [{ reason: 'Signal is HOLD — nothing to adjudicate.', severity: 'info' }],
      overrideAi: false, wouldTrade: false, mode: input.mode ?? 'shadow',
      htfAlignment: 'n/a', expectancyR: null, expectancyStatus: 'n/a',
      sampleConfidence: 'n/a', safetyScore: null,
    }
    return {
      expectancy: null, safety: null, authority,
      setupOutcome: { setupId: null, alertId: null, qualifies: false, alreadyActive: false, status: 'DETECTED' },
    }
  }

  // Memo — identical setups within TTL reuse the recorded result.
  const cacheKey = evalKeyOf(input)
  const cached = _lastEval.get(cacheKey)
  if (cached && Date.now() - cached.at < EVAL_TTL_MS) return cached.value

  // ── 1. Historical segment expectancy ───────────────────────────────────────
  let expectancy: ExpectancyVerdict | null = null
  try {
    const data = await fetchExpectancyData({ userId })
    const samples = userId && data.data.byUserSamples.length > 0
      ? data.data.byUserSamples
      : data.data.samples
    expectancy = lookupSetupExpectancy(samples, {
      pair: input.pair,
      direction: input.direction as 'BUY' | 'SELL',
      regime: input.regime ?? undefined,
      session: input.session ?? undefined,
      volRegime: input.volRegime ?? undefined,
      confidence: input.signalScore ?? undefined,
      mlWinProb: input.mlWinProb ?? undefined,
      spreadCond: input.spreadCond ?? undefined,
      setupType: input.setupType ?? undefined,
    })
    // Keep the statistics materialised (throttled — cheap after first run).
    await maybePersistExpectancyStats({ userId })
  } catch (e: any) {
    console.warn('[evaluator] expectancy unavailable:', e?.message)
  }

  // ── 2. Safety score (independent of signal strength) ───────────────────────
  const safety = computeSafetyScore({
    pair: input.pair,
    direction: input.direction as 'BUY' | 'SELL',
    regime: input.regime ?? null,
    session: input.session ?? 'OTHER',
    spreadPips: input.spreadPips ?? undefined,
    atrPips: input.atrPips ?? undefined,
    spreadSource: input.spreadSource ?? null,
    slPips: input.slPips ?? undefined,
    htfBias15m: input.htfBias15m ?? null,
    htfBias1h: input.htfBias1h ?? null,
    newsInWindow: input.newsInWindow ?? false,
    newsMinutesAway: input.newsMinutesAway ?? null,
    openPositions: input.openPositions ?? 0,
    maxPositions: input.maxPositions ?? 0,
    dailyLossUsedPct: input.dailyLossUsedPct ?? null,
    maxDailyLossPct: input.maxDailyLossPct ?? 0,
  })


  // ── 3. Authority adjudication (shadow: records, never executes) ────────────
  const authCtx: AuthorityContext = {
    pair: input.pair,
    direction: input.direction as 'BUY' | 'SELL',
    mode: input.mode ?? 'shadow',
    signalConfidence: input.signalScore ?? null,
    agreementScore: input.agreementScore ?? null,
    mlWinProb: input.mlWinProb ?? null,
    htfBias15m: input.htfBias15m ?? null,
    htfBias1h: input.htfBias1h ?? null,
    expectancy,
    safety,
    setupContext: {
      pair: input.pair,
      direction: input.direction as 'BUY' | 'SELL',
      regime: input.regime ?? undefined,
      session: input.session ?? undefined,
      volRegime: input.volRegime ?? undefined,
      confidence: input.signalScore ?? undefined,
      mlWinProb: input.mlWinProb ?? undefined,
      spreadCond: input.spreadCond ?? undefined,
      setupType: input.setupType ?? undefined,
    },
    snapshot: input.snapshot ?? {},
  }
  const authority = adjudicateAuthority(authCtx)

  // ── 4. Audit trail + qualified-setup lifecycle ─────────────────────────────
  const extra: Record<string, unknown> = { user_id: userId, signal_id: input.signalId }
  const decisionId = await recordAuthorityDecision(authCtx, authority, extra)
  const noSetup: QualifiedSetupOutcome = { setupId: null, alertId: null, qualifies: false, alreadyActive: false, status: authority.status }
  // Lifecycle rows are only created for setups the authority approves. DENIED
  // and REVIEW verdicts already live in trade_authority_decisions — tracking
  // every AI opinion would flood the setup table with noise.
  const setupOutcome = authority.status === 'APPROVED'
    ? await processQualifiedSetup({
        pair: input.pair,
        direction: input.direction as 'BUY' | 'SELL',
        timeframe: input.timeframe ?? '5m',
        userId,
        signalScore: input.signalScore ?? null,
        signalId: input.signalId ?? null,
        expectancy,
        safety,
        authority,
        regime: input.regime ?? null,
        session: input.session ?? null,
        entry: input.entry ?? null,
        sl: input.sl ?? null,
        tp: input.tp ?? null,
        reasons: input.reasons ?? [],
        snapshot: { ...(input.snapshot ?? {}), authorityDecisionId: decisionId },
      })
    : noSetup

  // ── 5. Filter-bottleneck diagnostics: log authority vetoes ─────────────────
  if (authority.status === 'DENIED') {
    await recordFilterRejection({
      userId,
      pair: input.pair,
      direction: input.direction as 'BUY' | 'SELL',
      filterName: 'authority',
      stage: 'authority',
      value: authority.expectancyR ?? input.mlWinProb ?? input.signalScore ?? undefined,
      threshold: 0,
      reason: authority.reasons.filter(r => r.severity === 'block').map(r => r.reason).join('; ') || authority.status,
      signalId: input.signalId ?? null,
      snapshot: input.snapshot ?? {},
    })
  }

  const result: SetupEvaluationResult = { expectancy, safety, authority, setupOutcome }
  _lastEval.set(cacheKey, { at: Date.now(), value: result })
  return result
}
