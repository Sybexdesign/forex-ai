// app/api/telegram/setup/route.ts
// One-time admin endpoint to register the webhook URL with Telegram.
// Call: GET /api/telegram/setup?key=<ADMIN_API_KEY>
// Only needs to be run once (or again if the deployment URL changes).

import { NextRequest, NextResponse } from 'next/server'

const BOT_TOKEN      = process.env.TELEGRAM_BOT_TOKEN      || ''
const WEBHOOK_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET || ''
const ADMIN_API_KEY  = process.env.ADMIN_API_KEY           || ''

export async function GET(req: NextRequest) {
  // Simple key-based guard — only the admin can call this
  const key = req.nextUrl.searchParams.get('key')
  if (!key || key !== ADMIN_API_KEY) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  if (!BOT_TOKEN) {
    return NextResponse.json({ error: 'TELEGRAM_BOT_TOKEN env var is not set' }, { status: 500 })
  }

  // Build webhook URL from the incoming request host (works on Vercel + local)
  const host = req.headers.get('x-forwarded-host') || req.headers.get('host') || req.nextUrl.host
  const proto = req.headers.get('x-forwarded-proto') || 'https'
  const webhookUrl = `${proto}://${host}/api/telegram/webhook`

  const body: Record<string, any> = {
    url: webhookUrl,
    allowed_updates: ['message'],
    drop_pending_updates: true,
  }
  if (WEBHOOK_SECRET) body.secret_token = WEBHOOK_SECRET

  const res  = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/setWebhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const data = await res.json()

  // Also fetch bot info so the admin can confirm the correct bot is connected
  const infoRes  = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/getMe`)
  const infoData = await infoRes.json()

  return NextResponse.json({
    webhookRegistered: data.ok,
    webhookUrl,
    telegramResponse: data,
    bot: infoData.result ? {
      username:  infoData.result.username,
      firstName: infoData.result.first_name,
      id:        infoData.result.id,
    } : null,
  })
}
