// app/api/telegram/setup/route.ts
// One-time admin endpoint to register the webhook URL with Telegram.
// Call: GET /api/telegram/setup?key=<ADMIN_API_KEY>
// POST /api/telegram/setup?key=<ADMIN_API_KEY>  → sends a test message
// Only needs to be run once (or again if the deployment URL changes).

import { NextRequest, NextResponse } from 'next/server'

const WEBHOOK_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET || ''
const ADMIN_API_KEY  = process.env.ADMIN_API_KEY           || ''

function auth(req: NextRequest) {
  const key = req.nextUrl.searchParams.get('key')
  return !ADMIN_API_KEY || key === ADMIN_API_KEY
}

export async function GET(req: NextRequest) {
  if (!auth(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const token = process.env.TELEGRAM_BOT_TOKEN || ''
  if (!token) {
    return NextResponse.json({ error: 'TELEGRAM_BOT_TOKEN env var is not set' }, { status: 500 })
  }

  const host = req.headers.get('x-forwarded-host') || req.headers.get('host') || req.nextUrl.host
  const proto = req.headers.get('x-forwarded-proto') || 'https'
  const webhookUrl = `${proto}://${host}/api/telegram/webhook`

  const body: Record<string, any> = {
    url: webhookUrl,
    allowed_updates: ['message'],
    drop_pending_updates: true,
  }
  if (WEBHOOK_SECRET) body.secret_token = WEBHOOK_SECRET

  const res      = await fetch(`https://api.telegram.org/bot${token}/setWebhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const data     = await res.json()
  const infoRes  = await fetch(`https://api.telegram.org/bot${token}/getMe`)
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

// POST → sends a test message. Use this to verify Telegram env vars are readable from serverless.
export async function POST(req: NextRequest) {
  if (!auth(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const token  = process.env.TELEGRAM_BOT_TOKEN || ''
  const chatId = process.env.TELEGRAM_CHAT_ID   || ''

  const envStatus = {
    BOT_TOKEN_SET: !!token,
    BOT_TOKEN_PREFIX: token ? token.slice(0, 10) + '...' : '(empty)',
    CHAT_ID_SET: !!chatId,
    CHAT_ID: chatId || '(empty)',
  }

  if (!token || !chatId) {
    return NextResponse.json({ ok: false, envStatus, error: 'Missing env vars' }, { status: 500 })
  }

  const res  = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({
      chat_id:    chatId,
      text:       '✅ <b>Sybex ForexAI</b> — Telegram test from production serverless function.',
      parse_mode: 'HTML',
    }),
  })
  const data = await res.json()
  return NextResponse.json({ ok: data.ok, envStatus, telegramResponse: data })
}
