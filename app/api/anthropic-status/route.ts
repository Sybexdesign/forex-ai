// app/api/anthropic-status/route.ts
// Provider-aware health check. Historically Anthropic-only; the path is kept
// for compatibility with existing UI callers (AppShell) but the actual check
// now targets whichever provider LLM_PROVIDER selects.

import { NextResponse } from 'next/server'
import { activeProvider } from '@/lib/llm'

async function checkAnthropic(apiKey: string) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key':         apiKey,
      'anthropic-version': '2023-06-01',
      'content-type':      'application/json',
    },
    body: JSON.stringify({
      model:      'claude-haiku-4-5-20251001',
      max_tokens: 1,
      messages:   [{ role: 'user', content: 'ping' }],
    }),
  })
  if (res.ok) return NextResponse.json({ ok: true, provider: 'anthropic' })

  const data = await res.json().catch(() => ({}))
  const errorType = data?.error?.type || ''

  if (res.status === 429 || errorType === 'overloaded_error' || errorType === 'billing_error' || errorType === 'insufficient_quota') {
    return NextResponse.json({ ok: false, provider: 'anthropic', error: 'Anthropic credits exhausted or rate limited', status: res.status, errorType })
  }
  if (res.status === 401 || res.status === 403) {
    return NextResponse.json({ ok: false, provider: 'anthropic', error: 'Anthropic API key invalid or unauthorized', status: res.status })
  }
  return NextResponse.json({ ok: true, provider: 'anthropic' })
}

async function checkDeepseek(apiKey: string) {
  const base = process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com/v1'
  const model = process.env.DEEPSEEK_MODEL || 'deepseek-chat'
  const res = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: {
      'authorization': `Bearer ${apiKey}`,
      'content-type':  'application/json',
    },
    body: JSON.stringify({
      model,
      max_tokens: 1,
      messages:   [{ role: 'user', content: 'ping' }],
    }),
  })
  if (res.ok) return NextResponse.json({ ok: true, provider: 'deepseek' })

  if (res.status === 429 || res.status === 402) {
    return NextResponse.json({ ok: false, provider: 'deepseek', error: 'DeepSeek credits exhausted or rate limited', status: res.status })
  }
  if (res.status === 401 || res.status === 403) {
    return NextResponse.json({ ok: false, provider: 'deepseek', error: 'DeepSeek API key invalid or unauthorized', status: res.status })
  }
  return NextResponse.json({ ok: true, provider: 'deepseek' })
}

export async function GET() {
  const provider = activeProvider()

  const apiKey = provider === 'deepseek'
    ? process.env.DEEPSEEK_API_KEY
    : process.env.ANTHROPIC_API_KEY

  if (!apiKey) {
    return NextResponse.json({ ok: false, provider, error: `${provider === 'deepseek' ? 'DEEPSEEK_API_KEY' : 'ANTHROPIC_API_KEY'} not configured` })
  }

  try {
    return provider === 'deepseek' ? await checkDeepseek(apiKey) : await checkAnthropic(apiKey)
  } catch {
    // Network error — treat as ok to avoid false alarms
    return NextResponse.json({ ok: true, provider })
  }
}
