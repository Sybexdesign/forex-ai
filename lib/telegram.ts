// lib/telegram.ts
// Telegram Bot alerts.
//
// Two delivery modes:
//   send()      → admin only  (TELEGRAM_CHAT_ID)  — private order/trade events
//   broadcast() → all active subscribers in telegram_subscribers table — public signals

import { createClient } from '@supabase/supabase-js'

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || ''
const CHAT_ID   = process.env.TELEGRAM_CHAT_ID   || ''

function serviceClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } }
  )
}

// ── Private: sends to the one admin CHAT_ID ───────────────────────────────────

async function send(text: string): Promise<void> {
  if (!BOT_TOKEN || !CHAT_ID) return
  try {
    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: CHAT_ID, text, parse_mode: 'HTML' }),
    })
  } catch (e: any) {
    console.error('[telegram] send failed:', e?.message)
  }
}

// ── Public: broadcasts to all active subscribers ──────────────────────────────

async function broadcast(text: string): Promise<void> {
  if (!BOT_TOKEN) return
  try {
    const sb = serviceClient()
    const { data: subscribers } = await sb
      .from('telegram_subscribers')
      .select('chat_id')
      .eq('active', true)

    if (!subscribers?.length) {
      // Fall back to admin chat if no subscribers yet
      await send(text)
      return
    }

    for (const sub of subscribers) {
      try {
        await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: sub.chat_id, text, parse_mode: 'HTML' }),
        })
      } catch { /* skip individual failures */ }
    }
  } catch (e: any) {
    console.error('[telegram] broadcast failed:', e?.message)
    await send(text) // fall back to admin on DB error
  }
}

// ── Alert types ───────────────────────────────────────────────────────────────

// PUBLIC — sent to all subscribers
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

// PUBLIC — sent to all subscribers when scan finds setups
export async function alertScanComplete(opts: {
  pairsScanned: number
  signalsFound: number
  pairs: string[]
}) {
  if (opts.signalsFound === 0) return  // only notify when signals found
  const text = [
    `🔍 <b>MARKET SCAN — ${opts.signalsFound} SIGNAL${opts.signalsFound > 1 ? 'S' : ''} FOUND</b>`,
    ``,
    `Scanned <b>${opts.pairsScanned} pairs</b>`,
    ``,
    opts.pairs.map(p => `• ${p}`).join('\n'),
    ``,
    `<i>Full details coming in individual signal alerts.</i>`,
  ].join('\n')
  await broadcast(text)
}

// PRIVATE — admin only (personal order events)
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

// PRIVATE — admin only
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

// PRIVATE — admin only
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

// PRIVATE — admin only
export async function alertTradeClosed(opts: {
  pair: string
  direction: 'BUY' | 'SELL'
  pl?: number
  broker: string
}) {
  const plStr = opts.pl !== undefined
    ? (opts.pl >= 0 ? `+$${opts.pl.toFixed(2)}` : `-$${Math.abs(opts.pl).toFixed(2)}`)
    : '—'
  const emoji = opts.pl !== undefined ? (opts.pl >= 0 ? '💚' : '🔴') : '⬜'
  const text = [
    `${emoji} <b>TRADE CLOSED — ${opts.pair}</b>`,
    ``,
    `Direction: ${opts.direction}`,
    `P&amp;L: <code>${plStr}</code>`,
    `Broker: ${opts.broker}`,
  ].join('\n')
  await send(text)
}
