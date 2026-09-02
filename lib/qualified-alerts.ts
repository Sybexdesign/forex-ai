// lib/qualified-alerts.ts
// ─────────────────────────────────────────────────────────────────────────────
// Qualified Setup lifecycle + notification outbox (Phases 8–9).
//
// When the Expectancy + Authority + Safety layers all agree a setup is worth
// trading, we:
//   1. create/refresh a trade_setups row (one lifecycle per setup signature),
//   2. mark it QUALIFIED → ALERTED,
//   3. enqueue a setup_alerts row (unique dedup_key — hard de-dup),
//   4. push a Telegram broadcast immediately.
//
// The trader can therefore close the Auto Trade page and still get the
// 🔔 XAUUSD A+ SELL SETUP DETECTED ping without any manual refresh.
//
// The route integration is shadow-safe: alerts only fire when the authority
// verdict is APPROVED and the edge is real (see QUALIFY_MIN_*).
// ─────────────────────────────────────────────────────────────────────────────
import { getAdminClient } from '@/lib/supabase'
import type { AuthorityVerdict } from '@/lib/trade-authority'
import type { ExpectancyVerdict } from '@/lib/expectancy-engine'
import type { SafetyResult } from '@/lib/safety-score'
import { alertQualifiedSetup } from '@/lib/telegram'

export const SETUP_WINDOW_MS = 30 * 60_000   // setups dedupe within 30 min
const QUALIFY_MIN_EXPECTANCY_R = () => parseFloat(process.env.QUALIFY_MIN_EXPECTANCY_R || '0.2')
const QUALIFY_MIN_SAFETY       = () => parseInt(process.env.QUALIFY_MIN_SAFETY || '80', 10)
const QUALIFY_MIN_CONFIDENCE   = () => parseInt(process.env.QUALIFY_MIN_CONFIDENCE || '75', 10)

export interface QualifiedSetupCtx {
  pair: string
  direction: 'BUY' | 'SELL'
  timeframe?: string
  userId?: string | null
  signalScore?: number | null
  signalId?: string | null
  expectancy?: ExpectancyVerdict | null
  safety?: SafetyResult | null
  authority?: AuthorityVerdict | null
  regime?: string | null
  session?: string | null
  entry?: number | null
  sl?: number | null
  tp?: number | null
  reasons?: string[]
  snapshot?: Record<string, unknown>
}

export interface QualifiedSetupOutcome {
  setupId: string | null
  alertId: string | null
  qualifies: boolean
  alreadyActive: boolean
  status: string
}

/** Stable signature of a setup within its window. */
export function setupKeyOf(ctx: QualifiedSetupCtx, now = Date.now()): string {
  const bucket = Math.floor(now / SETUP_WINDOW_MS)
  const regime = ctx.regime ?? 'n/a'
  const session = ctx.session ?? 'n/a'
  return `${ctx.pair}|${ctx.direction}|${regime}|${session}|${bucket}`
}

/** Does this setup clear the qualification bar? */
export function qualifies(ctx: QualifiedSetupCtx): boolean {
  const exp = ctx.expectancy?.metrics
  const safety = ctx.safety?.total ?? null
  const auth = ctx.authority?.status
  if (auth !== 'APPROVED') return false
  if (!exp || exp.status === 'INSUFFICIENT_DATA' || exp.status === 'NEGATIVE') return false
  if ((exp.expectancyR ?? 0) < QUALIFY_MIN_EXPECTANCY_R()) return false
  if (safety === null || safety < QUALIFY_MIN_SAFETY()) return false
  if ((ctx.signalScore ?? 0) < QUALIFY_MIN_CONFIDENCE()) return false
  return true
}

/**
 * Run the setup lifecycle for a signal that reached the authority layer.
 * Returns the lifecycle outcome. Never throws (all DB errors degrade to
 * "not active, no alert").
 */
export async function processQualifiedSetup(ctx: QualifiedSetupCtx): Promise<QualifiedSetupOutcome> {
  const noop: QualifiedSetupOutcome = { setupId: null, alertId: null, qualifies: false, alreadyActive: false, status: 'DETECTED' }
  try {
    const admin = getAdminClient()
    const key = setupKeyOf(ctx)
    const q = qualifies(ctx)
    const nowIso = new Date().toISOString()
    const snapshot = {
      ...(ctx.snapshot ?? {}),
      signalScore: ctx.signalScore ?? null,
      signalId: ctx.signalId ?? null,
      regime: ctx.regime ?? null,
      session: ctx.session ?? null,
      entry: ctx.entry ?? null,
      sl: ctx.sl ?? null,
      tp: ctx.tp ?? null,
      reasons: ctx.reasons ?? [],
      expectancy: ctx.expectancy?.metrics ?? null,
      expectancySegment: ctx.expectancy?.segment ?? null,
      safety: ctx.safety ? { total: ctx.safety.total, grade: ctx.safety.grade, components: ctx.safety.components } : null,
      authority: ctx.authority ? { status: ctx.authority.status, reasons: ctx.authority.reasons } : null,
    }

    // 1. Upsert the trade_setups lifecycle row (re-activate existing active row).
    const { data: existing } = await admin
      .from('trade_setups')
      .select('id, status')
      .eq('setup_key', key)
      .in('status', ['DETECTED', 'QUALIFIED', 'ALERTED'])
      .maybeSingle()

    let setupId: string | null = existing?.id ?? null
    if (existing) {
      // Refresh: keep DETECTED if still pending, promote to QUALIFIED when the
      // bar is cleared, ALERTED after the alert goes out.
      const nextStatus = q ? (existing.status === 'DETECTED' ? 'QUALIFIED' : existing.status) : existing.status
      if (nextStatus !== existing.status) {
        await admin.from('trade_setups').update({ status: nextStatus, updated_at: nowIso, snapshot }).eq('id', existing.id)
      } else {
        await admin.from('trade_setups').update({ updated_at: nowIso, snapshot }).eq('id', existing.id)
      }
    } else {
      const insert = await admin
        .from('trade_setups')
        .insert({
          user_id: ctx.userId ?? null,
          setup_key: key,
          pair: ctx.pair,
          direction: ctx.direction,
          timeframe: ctx.timeframe ?? '5m',
          status: q ? 'QUALIFIED' : 'DETECTED',
          snapshot,
          signal_id: ctx.signalId ?? null,
          expires_at: new Date(Date.now() + SETUP_WINDOW_MS).toISOString(),
        })
        .select('id')
        .maybeSingle()
      setupId = insert.data?.id ?? null
    }

    // 2. Not-alertable — not qualified, or already active in this window.
    if (!q || !setupId) {
      return {
        setupId, alertId: null, qualifies: q, alreadyActive: !!existing,
        status: existing?.status ?? (q ? 'QUALIFIED' : 'DETECTED'),
      }
    }

    // 3. Enqueue the alert (hard dedup on dedup_key). Realtime push makes it
    //    appear live on the Auto Trade page.
    const dedupKey = `alert:${key}`
    const alertUpsert = await admin
      .from('setup_alerts')
      .upsert({
        user_id: ctx.userId ?? null,
        setup_id: setupId,
        dedup_key: dedupKey,
        pair: ctx.pair,
        direction: ctx.direction,
        status: 'NEW',
        severity: 'QUALIFIED',
        title: `${ctx.pair} ${ctx.direction === 'BUY' ? 'A+ BUY' : 'A+ SELL'} SETUP DETECTED`,
        body: snapshot,
      }, { onConflict: 'dedup_key', ignoreDuplicates: true })
      .select('id')
      .single()

    const alertId = alertUpsert.data?.id ?? null
    if (!alertId) {
      return { setupId, alertId: null, qualifies: true, alreadyActive: true, status: 'ALERTED' }
    }

    // 4. Telegram broadcast (idempotent — admin chat + DB subscribers).
    let telegramSentAt: string | null = null
    let telegramError: string | null = null
    try {
      await alertQualifiedSetup({
        pair: ctx.pair,
        direction: ctx.direction,
        signalScore: ctx.signalScore ?? null,
        expectancyR: ctx.expectancy?.metrics.expectancyR ?? null,
        expectancyStatus: ctx.expectancy?.metrics.status ?? null,
        sampleN: ctx.expectancy?.metrics.n ?? null,
        safetyScore: ctx.safety?.total ?? null,
        safetyGrade: ctx.safety?.grade ?? null,
        reasons: ctx.authority?.reasons.filter(r => r.severity !== 'info').map(r => r.reason)
          ?? ctx.reasons ?? [],
        entry: ctx.entry ?? null,
        sl: ctx.sl ?? null,
        tp: ctx.tp ?? null,
        regime: ctx.regime ?? null,
        session: ctx.session ?? null,
      })
      telegramSentAt = new Date().toISOString()
    } catch (e: any) {
      telegramError = e?.message ?? 'telegram failed'
    }

    // 5. Mark SENT + lifecycle ALERTED.
    await admin.from('setup_alerts')
      .update({ status: telegramSentAt ? 'SENT' : 'FAILED', telegram_sent_at: telegramSentAt, telegram_error: telegramError })
      .eq('id', alertId)
    await admin.from('trade_setups').update({ status: 'ALERTED', alert_sent_at: telegramSentAt, updated_at: nowIso }).eq('id', setupId)

    return { setupId, alertId, qualifies: true, alreadyActive: false, status: 'ALERTED' }
  } catch (e: any) {
    console.warn('[qualified-setup] lifecycle failed:', e?.message)
    return noop
  }
}
