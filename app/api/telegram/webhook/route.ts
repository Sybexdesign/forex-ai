// app/api/telegram/webhook/route.ts
// Telegram Bot webhook — receives messages from users and handles commands.
// Register this URL with Telegram via /api/telegram/setup?key=<ADMIN_API_KEY>

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

const BOT_TOKEN      = process.env.TELEGRAM_BOT_TOKEN      || ''
const WEBHOOK_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET || ''

function serviceClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } }
  )
}

async function reply(chatId: number | string, text: string) {
  if (!BOT_TOKEN) return
  try {
    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true }),
    })
  } catch { /* ignore send errors */ }
}

export async function POST(req: NextRequest) {
  // Validate Telegram's secret token header
  if (WEBHOOK_SECRET) {
    const incoming = req.headers.get('X-Telegram-Bot-Api-Secret-Token')
    if (incoming !== WEBHOOK_SECRET) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }
  }

  let body: any
  try { body = await req.json() } catch { return NextResponse.json({ ok: true }) }

  const message = body.message || body.edited_message
  if (!message) return NextResponse.json({ ok: true })

  const chatId    = message.chat?.id
  const text      = (message.text || '').trim()
  const username  = message.from?.username  || null
  const firstName = message.from?.first_name || null
  const lastName  = message.from?.last_name  || null

  if (!chatId || !text) return NextResponse.json({ ok: true })

  const cmd = text.split('@')[0].toLowerCase() // strip @BotName suffix
  const sb  = serviceClient()

  // ── /start ────────────────────────────────────────────────────────────────
  if (cmd === '/start') {
    try {
      await sb.from('telegram_subscribers').upsert(
        {
          chat_id: String(chatId),
          username, first_name: firstName, last_name: lastName,
          active: true,
          subscribed_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'chat_id' }
      )
    } catch (e: any) {
      console.error('[telegram/webhook] subscriber upsert failed:', e?.message)
    }

    await reply(chatId, [
      `👋 Welcome to <b>Sybex ForexAI</b>! 🤖`,
      ``,
      `You're now <b>subscribed</b> to live trading signals. ✅`,
      ``,
      `<b>What you'll receive:</b>`,
      `📡  New signals as they're detected`,
      `🟢🔴  BUY / SELL alerts with Entry, TP &amp; SL levels`,
      `🔍  Scan results when high-confidence setups appear`,
      ``,
      `<b>Pairs covered:</b>`,
      `EUR/USD  •  GBP/USD  •  USD/JPY  •  AUD/USD`,
      `XAU/USD (Gold)  •  XAG/USD (Silver)`,
      ``,
      `<b>Commands:</b>`,
      `/stop  — Unsubscribe from alerts`,
      `/status — Check bot status`,
      `/help  — Show this menu`,
      ``,
      `<i>⚠️ Signals are for informational purposes only. Always manage your own risk.</i>`,
    ].join('\n'))
    return NextResponse.json({ ok: true })
  }

  // ── /stop ─────────────────────────────────────────────────────────────────
  if (cmd === '/stop' || cmd === '/unsubscribe') {
    try {
      await sb.from('telegram_subscribers')
        .update({ active: false, updated_at: new Date().toISOString() })
        .eq('chat_id', String(chatId))
    } catch (e: any) {
      console.error('[telegram/webhook] subscriber deactivate failed:', e?.message)
    }

    await reply(chatId, [
      `👋 You've been <b>unsubscribed</b> from Sybex ForexAI alerts.`,
      ``,
      `Send /start anytime to re-subscribe.`,
    ].join('\n'))
    return NextResponse.json({ ok: true })
  }

  // ── /status ───────────────────────────────────────────────────────────────
  if (cmd === '/status') {
    let subStatus = '❌ Not subscribed (send /start)'
    let subCount = 0
    try {
      const { data: sub } = await sb
        .from('telegram_subscribers')
        .select('active')
        .eq('chat_id', String(chatId))
        .single()
      subStatus = sub?.active ? '✅ Subscribed' : '❌ Not subscribed (send /start)'

      const { count } = await sb
        .from('telegram_subscribers')
        .select('*', { count: 'exact', head: true })
        .eq('active', true)
      subCount = count ?? 0
    } catch { /* DB unavailable — show bot as online anyway */ }

    await reply(chatId, [
      `📊 <b>Sybex ForexAI — Bot Status</b>`,
      ``,
      `🤖  Bot: <b>Online</b>`,
      `📡  Monitoring: 24/5 during market hours`,
      `👥  Subscribers: <b>${subCount}</b>`,
      ``,
      `Your status: ${subStatus}`,
    ].join('\n'))
    return NextResponse.json({ ok: true })
  }

  // ── /help ─────────────────────────────────────────────────────────────────
  if (cmd === '/help') {
    await reply(chatId, [
      `<b>Sybex ForexAI — Help</b>`,
      ``,
      `/start  — Subscribe to live signals`,
      `/stop   — Unsubscribe`,
      `/status — Check bot &amp; subscription status`,
      `/help   — Show this menu`,
      ``,
      `<b>Signal alerts include:</b>`,
      `• Pair &amp; direction (BUY/SELL)`,
      `• AI confidence score`,
      `• Entry zone, Take Profit &amp; Stop Loss`,
      `• Checklist score (out of 8 rules)`,
      `• Reasoning from the AI engine`,
      ``,
      `<i>To place trades, use the Sybex ForexAI trading terminal.</i>`,
    ].join('\n'))
    return NextResponse.json({ ok: true })
  }

  // ── Unknown command ───────────────────────────────────────────────────────
  await reply(chatId, `Unknown command. Send /help to see available commands.`)
  return NextResponse.json({ ok: true })
}
