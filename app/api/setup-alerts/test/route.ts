// app/api/setup-alerts/test/route.ts
// Safe notification test (audit item): fires a synthetic QUALIFIED SETUP alert
// through the exact production path — inserts a setup_alerts row (realtime
// broadcast → Auto Trade/Setup Intel live list) and sends a Telegram message.
// It NEVER creates a trade, NEVER touches orders/brokers, and uses a unique
// dedup_key each run so it can be triggered repeatedly.
export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { getAdminClient } from '@/lib/supabase'
import { alertQualifiedSetup } from '@/lib/telegram'

export async function POST(req: NextRequest) {
  try {
    let body: any = {}
    try { body = await req.json() } catch { /* no body */ }
    const admin = getAdminClient()

    const pair = (body?.pair as string) || 'XAU/USD'
    const direction: 'BUY' | 'SELL' = body?.direction === 'BUY' ? 'BUY' : 'SELL'
    const runId = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`
    const snapshot = {
      test: true,
      pair, direction,
      regime: 'trending',
      session: 'NEW_YORK',
      entry: 4473.76, sl: 4468.5, tp: 4479.0,
      expectancy: { expectancy_r: 0.42, status: 'POSITIVE', n: 85, win_rate: 0.66 },
      safety: { total: 88, grade: 'A' },
      authority: { status: 'APPROVED', reasons: [{ reason: 'TEST — no broker order placed', severity: 'info' }] },
      reasons: ['TEST EVENT — notification pipeline check'],
    }

    const insert = await admin.from('setup_alerts').insert({
      user_id: body?.userId ?? null,
      setup_id: null,
      dedup_key: `test:${runId}`,           // unique every run
      pair, direction,
      status: 'NEW',
      severity: 'QUALIFIED',
      title: `TEST QUALIFIED SETUP — ${pair} ${direction}`,
      body: snapshot,
    }).select('id').single()
    const alertId = insert.data?.id ?? null

    // Telegram (only fires if BOT_TOKEN + CHAT_ID configured; never throws).
    let telegramSentAt: string | null = null
    let telegramError: string | null = null
    try {
      await alertQualifiedSetup({
        pair, direction,
        signalScore: 84,
        expectancyR: 0.42, expectancyStatus: 'POSITIVE', sampleN: 85,
        safetyScore: 88, safetyGrade: 'A',
        reasons: ['TEST EVENT — no broker order placed', 'Realtime + Telegram pipeline check'],
        entry: 4473.76, sl: 4468.5, tp: 4479.0,
        regime: 'trending', session: 'NEW_YORK',
      })
      telegramSentAt = new Date().toISOString()
    } catch (e: any) {
      telegramError = e?.message ?? 'telegram failed'
    }

    if (alertId) {
      await admin.from('setup_alerts')
        .update({ status: telegramSentAt ? 'SENT' : 'FAILED', telegram_sent_at: telegramSentAt, telegram_error: telegramError })
        .eq('id', alertId)
    }

    return NextResponse.json({
      ok: true,
      message: 'Test qualified-setup alert fired. Check: setup_alerts realtime row + Telegram (if configured). No broker order placed.',
      alertId,
      telegram: telegramSentAt ? 'sent' : (telegramError ? `failed: ${telegramError}` : 'not-configured'),
      pair, direction,
    })
  } catch (e: any) {
    console.error('[setup-alerts/test]', e?.message)
    return NextResponse.json({ error: e?.message || 'test failed' }, { status: 500 })
  }
}
