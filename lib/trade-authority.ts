// lib/trade-authority.ts
// ─────────────────────────────────────────────────────────────────────────────
// Trade Authority (Phase 2/3) — the layer between the existing filters and the
// risk engine that decides whether a setup deserves execution. It can OVERRIDE
// the AI (the AI is only a signal generator; it has no veto here). All verdicts
// are currently produced in SHADOW mode: recorded, never executed. Flip mode to
// 'live' only after the backtest + shadow acceptance gates pass.
//
// Decision inputs (all pre-computed upstream):
//   • expectancy verdict for the setup's own historical segment
//   • safety score (independent of signal strength)
//   • existing gate outputs (ML win-prob, agreement score, HTF alignment)
//
// Verdict semantics:
//   NO_OP     — signal is HOLD; nothing to adjudicate.
//   APPROVED  — expectancy + safety + agreement all support execution.
//   REVIEW    — evidence is thin or mixed; needs operator confirmation.
//   DENIED    — statistically negative, unsafe, or self-contradictory. The
//               authority vetoes the AI here (override_ai = true).
// ─────────────────────────────────────────────────────────────────────────────
import { getAdminClient } from '@/lib/supabase'
import type { ExpectancyMetrics, ExpectancyVerdict, SetupContext } from '@/lib/expectancy-engine'
import { SAFETY_EXECUTE_MIN, SAFETY_HARD_BLOCK_AT } from '@/lib/safety-score'
import type { SafetyResult } from '@/lib/safety-score'

export type AuthorityStatus = 'APPROVED' | 'DENIED' | 'REVIEW' | 'NO_OP'
export type AuthorityReasonSeverity = 'info' | 'warn' | 'block'

export interface AuthorityReason {
  reason: string
  severity: AuthorityReasonSeverity
}

export interface AuthorityContext {
  pair: string
  direction: 'BUY' | 'SELL' | 'HOLD'
  mode?: 'shadow' | 'live'
  // Existing gate outputs (already applied by the upstream pipeline)
  signalConfidence?: number | null
  agreementScore?: number | null
  mlWinProb?: number | null
  htfBias15m?: 'BUY' | 'SELL' | null
  htfBias1h?: 'BUY' | 'SELL' | null
  // New-layer inputs
  expectancy?: ExpectancyVerdict | null
  safety?: SafetyResult | null
  setupContext?: SetupContext
  snapshot?: Record<string, unknown>     // full decision snapshot for audit
}

export interface AuthorityVerdict {
  status: AuthorityStatus
  reasons: AuthorityReason[]
  overrideAi: boolean
  wouldTrade: boolean
  mode: 'shadow' | 'live'
  htfAlignment: 'ALIGNED' | 'PARTIAL' | 'OPPOSED' | 'AMBIGUOUS' | 'n/a'
  expectancyR: number | null
  expectancyStatus: string
  sampleConfidence: string
  safetyScore: number | null
}

const fmtPct = (n: number | null | undefined, d = 0) =>
  (typeof n === 'number' && Number.isFinite(n)) ? `${(n * 100).toFixed(d)}%` : '—'

function htfAlignmentOf(ctx: AuthorityContext): AuthorityVerdict['htfAlignment'] {
  const d = ctx.direction as 'BUY' | 'SELL'
  const b15 = ctx.htfBias15m
  const b1h = ctx.htfBias1h
  if (!b15 && !b1h) return 'AMBIGUOUS'
  if ((b15 && b15 !== d) && (b1h && b1h !== d)) return 'OPPOSED'
  if ((b15 && b15 !== d) || (b1h && b1h !== d)) return 'PARTIAL'
  return 'ALIGNED'
}

/**
 * Pure adjudication — no I/O. See file header for rule semantics.
 */
export function adjudicateAuthority(ctx: AuthorityContext): AuthorityVerdict {
  const mode = ctx.mode ?? 'shadow'
  const reasons: AuthorityReason[] = []
  const aiWantedTrade = ctx.direction === 'BUY' || ctx.direction === 'SELL'

  // NO_OP — no position to adjudicate.
  if (!aiWantedTrade) {
    return {
      status: 'NO_OP', reasons, overrideAi: false, wouldTrade: false, mode,
      htfAlignment: 'n/a', expectancyR: null, expectancyStatus: 'n/a',
      sampleConfidence: 'n/a', safetyScore: null,
    }
  }

  const safety = ctx.safety
  const exp = ctx.expectancy
  const m: ExpectancyMetrics | null = exp?.metrics ?? null
  const safetyTotal = safety?.total ?? null
  const conf = ctx.signalConfidence ?? null
  const agreement = ctx.agreementScore ?? null
  const ml = ctx.mlWinProb ?? null

  const htfAlign = htfAlignmentOf(ctx)
  reasons.push({ reason: `AI signal: ${ctx.direction} ${conf !== null ? `${conf}%` : ''}`, severity: 'info' })
  if (ml !== null) reasons.push({ reason: `ML win-probability ${fmtPct(ml, 0)}`, severity: 'info' })
  if (agreement !== null) reasons.push({ reason: `Engine agreement ${agreement}%`, severity: 'info' })
  reasons.push({
    reason: exp?.segment && Object.keys(exp.segment).length
      ? `Historical expectancy ${(m?.expectancyR ?? 0).toFixed(2)}R (${m?.n ?? 0} samples)`
      : 'No historical segment evidence',
    severity: 'info',
  })

  const expectStatus = m?.status ?? 'INSUFFICIENT_DATA'
  const block: string[] = []
  const warn: string[] = []

  // 1. Safety veto — unsafe conditions beat everything.
  if (safetyTotal === null) {
    warn.push('Safety score unavailable')
  } else if (safetyTotal < SAFETY_HARD_BLOCK_AT()) {
    block.push(`Safety score ${safetyTotal}/100 below hard block ${SAFETY_HARD_BLOCK_AT()}`)
  } else if (safetyTotal < SAFETY_EXECUTE_MIN()) {
    warn.push(`Safety score ${safetyTotal}/100 below execute threshold ${SAFETY_EXECUTE_MIN()} — REVIEW`)
  }

  // 2. Expectancy veto — statistical edge beats the AI's opinion.
  if (expectStatus === 'NEGATIVE') {
    block.push(`Segment expectancy is NEGATIVE (${(m?.expectancyR ?? 0).toFixed(2)}R) — authority overrides the AI`)
  } else if (expectStatus === 'INSUFFICIENT_DATA') {
    warn.push('Insufficient historical sample for this setup segment — no statistical backing')
  } else if (expectStatus === 'NEUTRAL') {
    warn.push('Segment expectancy is neutral — not statistically compelling')
  } else {
    reasons.push({ reason: `Segment edge ${expectStatus} at ${(m?.expectancyR ?? 0).toFixed(2)}R`, severity: 'info' })
  }

  // 3. Self-contradiction veto — engines disagree.
  if (ml !== null && ml < 0.35 && expectStatus === 'POSITIVE') {
    warn.push(`ML (${fmtPct(ml, 0)}) contradicts historical segment edge`)
  }
  if (agreement !== null && agreement < 40) {
    block.push(`Agreement score ${agreement}% — independent engines contradict each other`)
  }
  if (htfAlign === 'OPPOSED') block.push('Both higher timeframes oppose the trade direction')

  // Collapse.
  for (const r of block) reasons.push({ reason: r, severity: 'block' })
  for (const r of warn) reasons.push({ reason: r, severity: 'warn' })

  const safetyOk = safetyTotal !== null && safetyTotal >= SAFETY_EXECUTE_MIN()
  const hasPositiveEdge = expectStatus === 'POSITIVE' || expectStatus === 'STRONG' || expectStatus === 'VERY_STRONG'
  const status: AuthorityStatus =
    block.length > 0 ? 'DENIED'
    : hasPositiveEdge ? (safetyOk ? 'APPROVED' : 'REVIEW')
    : 'REVIEW'

  return {
    status,
    reasons,
    overrideAi: status === 'DENIED' && aiWantedTrade,
    wouldTrade: status === 'APPROVED',
    mode,
    htfAlignment: htfAlign,
    expectancyR: m?.expectancyR ?? null,
    expectancyStatus: expectStatus,
    sampleConfidence: m?.sampleConfidence ?? 'insufficient',
    safetyScore: safetyTotal,
  }
}


/** Persist one authority decision (audit). Best-effort, never throws. */
export async function recordAuthorityDecision(
  ctx: AuthorityContext,
  verdict: AuthorityVerdict,
  extra: Record<string, unknown> = {},
): Promise<string | null> {
  try {
    const admin = getAdminClient()
    const { data, error } = await admin
      .from('trade_authority_decisions')
      .insert({
        user_id: extra.user_id ?? null,
        setup_id: extra.setup_id ?? null,
        mode: verdict.mode,
        status: verdict.status,
        pair: ctx.pair,
        direction: ctx.direction,
        override_ai: verdict.overrideAi,
        signal_score: ctx.signalConfidence ?? null,
        ml_win_probability: ctx.mlWinProb ?? null,
        agreement_score: ctx.agreementScore ?? null,
        htf_alignment: verdict.htfAlignment,
        regime: (ctx.setupContext?.regime as string) ?? null,
        session: ctx.setupContext?.session ?? null,
        expectancy_r: verdict.expectancyR,
        expectancy_status: verdict.expectancyStatus,
        sample_confidence: verdict.sampleConfidence,
        safety_score: verdict.safetyScore,
        decision_reasons: verdict.reasons,
        snapshot: {
          ...(ctx.snapshot ?? {}),
          aiDirection: ctx.direction,
          signalConfidence: ctx.signalConfidence,
          agreementScore: ctx.agreementScore,
          mlWinProb: ctx.mlWinProb,
          htfBias15m: ctx.htfBias15m,
          htfBias1h: ctx.htfBias1h,
          expectancy: ctx.expectancy ? {
            expectancy_r: ctx.expectancy.metrics.expectancyR,
            status: ctx.expectancy.metrics.status,
            n: ctx.expectancy.metrics.n,
            win_rate: ctx.expectancy.metrics.winRate,
            profit_factor: ctx.expectancy.metrics.profitFactor,
            sample_confidence: ctx.expectancy.metrics.sampleConfidence,
            segment: ctx.expectancy.segment,
          } : null,
          safety: ctx.safety ? { total: ctx.safety.total, grade: ctx.safety.grade, components: ctx.safety.components } : null,
        },
      })
      .select('id')
      .single()
    if (error) { console.warn('[authority] record failed:', error.message); return null }
    return data?.id ?? null
  } catch (e: any) {
    console.warn('[authority] record failed:', e?.message)
    return null
  }
}
