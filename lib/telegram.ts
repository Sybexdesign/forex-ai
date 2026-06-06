// lib/telegram.ts
// Telegram Bot alerts — two delivery modes:
//   send()      → admin TELEGRAM_CHAT_ID only  (orders, errors — always reliable)
//   broadcast() → admin CHAT_ID + any DB subscribers  (signals)

import { createClient } from '@supabase/supabase-js'

// Read at call-time (not module init) so Vercel runtime env vars are always available
function getBotToken() { return process.env.TELEGRAM_BOT_TOKEN || '' }
function getChatId()   { return process.env.TELEGRAM_CHAT_ID   || '' }

// Per-pair cooldown: suppress repeat Telegram alerts for the same pair+direction
// within this window. Prevents spamming when the scanner fires every 60 s on
// unchanged market conditions.
const SIGNAL_COOLDOWN_MS = 15 * 60_000  // 15 minutes
const signalCooldowns    = new Map<string, number>()

function serviceClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } }
  )
}

// ── Core send: always delivers to admin CHAT_ID ───────────────────────────────
async function send(text: string): Promise<void> {
  const token  = getBotToken()
  const chatId = getChatId()
  if (!token || !chatId) {
    console.error('[telegram] send: missing BOT_TOKEN or CHAT_ID — message not sent')
    return
  }
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }),
    })
    if (!res.ok) {
      const err = await res.text()
      console.error('[telegram] send failed:', res.status, err)
    } else {
      console.log('[telegram] send: message delivered to', chatId)
    }
  } catch (e: any) {
    console.error('[telegram] send failed:', e?.message)
  }
}

// ── Broadcast: admin CHAT_ID first (guaranteed), then DB subscribers ──────────
async function broadcast(text: string): Promise<void> {
  // Admin always gets the message — this path has no DB dependency
  await send(text)

  // Additionally send to any extra subscribers in the DB
  if (!getBotToken()) return
  try {
    const sb = serviceClient()
    const { data: subscribers } = await sb
      .from('telegram_subscribers')
      .select('chat_id')
      .eq('active', true)

    for (const sub of (subscribers || [])) {
      if (sub.chat_id === getChatId()) continue  // admin already received it above
      try {
        await fetch(`https://api.telegram.org/bot${getBotToken()}/sendMessage`, {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({ chat_id: sub.chat_id, text, parse_mode: 'HTML' }),
        })
      } catch { /* skip individual failures */ }
    }
  } catch { /* table may not exist yet — admin was already notified */ }
}

// ── Alert types ───────────────────────────────────────────────────────────────

// Signal alert — rate-limited per pair+direction to avoid 60 s spam
export async function alertNewSignal(opts: {
  pair: string
  direction: 'BUY' | 'SELL'
  confidence: number
  checklistScore: number
  currentPrice: number
  timeframe: string
  entryLow: number
  entryHigh: number
  tpPrice: number
  slPrice: number
  lots: number
  reasons: string[]
}) {
  // Cooldown: skip if the same pair+direction was alerted within the last 15 min
  const coolKey  = `${opts.pair}:${opts.direction}`
  const lastSent = signalCooldowns.get(coolKey) ?? 0
  if (Date.now() - lastSent < SIGNAL_COOLDOWN_MS) {
    console.log(`[telegram] ${coolKey} — cooldown active, skipping duplicate alert`)
    return
  }
  signalCooldowns.set(coolKey, Date.now())

  const dir = opts.direction === 'BUY' ? '🟢 BUY' : '🔴 SELL'
  const dp  = opts.pair.includes('JPY') ? 3 : opts.pair.startsWith('XA') ? 2 : 5
  const text = [
    `⚡ <b>NEW SIGNAL — ${opts.pair}</b>`,
    ``,
    `${dir}  |  ${opts.confidence}% confidence  |  ${opts.checklistScore}/8 rules`,
    ``,
    `📍 Entry:  <code>${opts.entryLow.toFixed(dp)} – ${opts.entryHigh.toFixed(dp)}</code>`,
    `🎯 TP:     <code>${opts.tpPrice.toFixed(dp)}</code>`,
    `🛑 SL:     <code>${opts.slPrice.toFixed(dp)}</code>`,
    `📦 Size:   <code>${opts.lots.toFixed(2)} lots</code>`,
    `⏱ TF:     ${opts.timeframe}`,
    ``,
    opts.reasons.slice(0, 2).map(r => `• ${r}`).join('\n'),
    ``,
    `<i>⚠️ Review in the Sybex ForexAI terminal before trading.</i>`,
  ].join('\n')

  await broadcast(text)
}

// Scan summary — only fires when signals are found
export async function alertScanComplete(opts: {
  pairsScanned: number
  signalsFound: number
  pairs: string[]
}) {
  if (opts.signalsFound === 0) return
  const text = [
    `🔍 <b>MARKET SCAN — ${opts.signalsFound} SIGNAL${opts.signalsFound > 1 ? 'S' : ''} FOUND</b>`,
    ``,
    `Scanned <b>${opts.pairsScanned} pairs</b>`,
    ``,
    opts.pairs.map(p => `• ${p}`).join('\n'),
    ``,
    `<i>Full details in individual signal alerts above.</i>`,
  ].join('\n')
  await broadcast(text)
}

// ── Private order/trade alerts (admin only) ───────────────────────────────────

export async function alertOrderPlaced(opts: {
  pair: string
  direction: 'BUY' | 'SELL'
  lots: number
  filledPrice: number
  tpPrice: number
  slPrice: number
  confidence: number
  broker: string
}) {
  const dir = opts.direction === 'BUY' ? '🟢 BUY' : '🔴 SELL'
  const dp  = opts.pair.includes('JPY') ? 3 : opts.pair.startsWith('XA') ? 2 : 5
  const text = [
    `✅ <b>ORDER PLACED — ${opts.pair}</b>`,
    ``,
    `${dir}  |  ${opts.lots.toFixed(2)} lots  |  ${opts.confidence}% AI confidence`,
    ``,
    `💰 Filled:  <code>${opts.filledPrice.toFixed(dp)}</code>`,
    `🎯 TP:      <code>${opts.tpPrice?.toFixed(dp) ?? '—'}</code>`,
    `🛑 SL:      <code>${opts.slPrice?.toFixed(dp) ?? '—'}</code>`,
    `🏦 Broker:  ${opts.broker}`,
  ].join('\n')
  await send(text)
}

export async function alertOrderBlocked(opts: {
  pair: string
  direction: 'BUY' | 'SELL'
  reason: string
}) {
  const text = [
    `🚫 <b>TRADE BLOCKED — ${opts.pair}</b>`,
    ``,
    `Direction: ${opts.direction}`,
    `Reason: ${opts.reason}`,
  ].join('\n')
  await send(text)
}

export async function alertOrderFailed(opts: {
  pair: string
  direction: 'BUY' | 'SELL'
  error: string
}) {
  const text = [
    `❌ <b>ORDER FAILED — ${opts.pair}</b>`,
    ``,
    `Direction: ${opts.direction}`,
    `Error: ${opts.error}`,
  ].join('\n')
  await send(text)
}

// Risk-management breach: hard-dollar cap, -1.5R emergency close, post-close >1R.
// Always delivered to admin chat (no cooldown — these are critical safety events).
export async function alertRiskBreach(opts: {
  pair: string
  ticket?: number | string
  pl: number
  cap?: number      // expected cap (USD) — informational
  reason: 'hard-cap' | 'emergency-1.5R' | 'post-close-1R'
}) {
  const titles: Record<typeof opts.reason, string> = {
    'hard-cap':         '🚨 HARD CAP BREACHED',
    'emergency-1.5R':   '🛑 EMERGENCY CLOSE -1.5R',
    'post-close-1R':    '⚠️ LOSS EXCEEDED 1R',
  }
  const plStr = opts.pl >= 0 ? `+$${opts.pl.toFixed(2)}` : `-$${Math.abs(opts.pl).toFixed(2)}`
  const lines = [
    `${titles[opts.reason]} — ${opts.pair}`,
    ``,
    `P&amp;L: <code>${plStr}</code>`,
    opts.cap !== undefined ? `Cap:  <code>-$${opts.cap.toFixed(2)}</code>` : null,
    opts.ticket !== undefined ? `Ticket: <code>${opts.ticket}</code>` : null,
    ``,
    `⏱ ${new Date().toUTCString()}`,
  ].filter(Boolean).join('\n')
  await send(lines)
}

export async function alertTradeClosed(opts: {
  pair: string
  direction: 'BUY' | 'SELL'
  pl?: number
  broker: string
}) {
  const plStr  = opts.pl !== undefined
    ? (opts.pl >= 0 ? `+$${opts.pl.toFixed(2)}` : `-$${Math.abs(opts.pl).toFixed(2)}`)
    : '—'
  const emoji  = opts.pl !== undefined ? (opts.pl >= 0 ? '💚' : '🔴') : '⬜'
  const text   = [
    `${emoji} <b>TRADE CLOSED — ${opts.pair}</b>`,
    ``,
    `Direction: ${opts.direction}`,
    `P&amp;L: <code>${plStr}</code>`,
    `Broker: ${opts.broker}`,
  ].join('\n')
  await send(text)
}
