// app/api/anthropic-status/route.ts
// Checks whether the Anthropic API key has usable credits by making a minimal API call.
// Returns { ok: true } if credits are fine, { ok: false, error } if exhausted or key invalid.

import { NextResponse } from 'next/server'

export async function GET() {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) {
    return NextResponse.json({ ok: false, error: 'ANTHROPIC_API_KEY not configured' })
  }

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1,
        messages: [{ role: 'user', content: 'ping' }],
      }),
    })

    if (res.ok) {
      return NextResponse.json({ ok: true })
    }

    const data = await res.json().catch(() => ({}))
    const errorType = data?.error?.type || ''

    // Credit exhaustion errors
    if (res.status === 429 || errorType === 'overloaded_error' || errorType === 'billing_error' || errorType === 'insufficient_quota') {
      return NextResponse.json({ ok: false, error: 'Anthropic credits exhausted or rate limited', status: res.status, errorType })
    }
    if (res.status === 401 || res.status === 403) {
      return NextResponse.json({ ok: false, error: 'Anthropic API key invalid or unauthorized', status: res.status })
    }

    // Treat other errors as ok (e.g., transient 500s from Anthropic should not trigger the alert)
    return NextResponse.json({ ok: true })
  } catch {
    // Network error — treat as ok to avoid false alarms
    return NextResponse.json({ ok: true })
  }
}
