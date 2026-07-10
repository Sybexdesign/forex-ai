// lib/llm.ts
// Thin LLM provider abstraction used by the signal, scan, and analyze routes.
// The provider is selected at runtime via LLM_PROVIDER; the shape of the reply
// is normalised so downstream JSON parsing works identically for both engines.

import Anthropic from '@anthropic-ai/sdk'

export type LlmProvider = 'anthropic' | 'deepseek'

export interface LlmCompleteArgs {
  system: string
  user: string
  maxTokens: number
}

export interface LlmCompleteResult {
  text: string
}

function isPlaceholder(v: string | undefined): boolean {
  if (!v) return true
  return v === '' || v === 'your_anthropic_api_key_here' || v === 'your_deepseek_api_key_here'
}

export function activeProvider(): LlmProvider {
  const raw = (process.env.LLM_PROVIDER || 'anthropic').toLowerCase()
  return raw === 'deepseek' ? 'deepseek' : 'anthropic'
}

// Label used in audit trails (e.g. signals.indicator_snapshot._audit.engine).
export function providerLabel(): LlmProvider {
  return activeProvider()
}

// True when the active provider has a usable key configured.
export function hasLlmKey(): boolean {
  const p = activeProvider()
  if (p === 'deepseek') return !isPlaceholder(process.env.DEEPSEEK_API_KEY)
  return !isPlaceholder(process.env.ANTHROPIC_API_KEY)
}

let anthropicClient: Anthropic | null = null
function getAnthropic(): Anthropic {
  if (!anthropicClient) anthropicClient = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  return anthropicClient
}

const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6'
const DEEPSEEK_MODEL  = process.env.DEEPSEEK_MODEL  || 'deepseek-chat'
const DEEPSEEK_BASE   = process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com/v1'

async function completeAnthropic(args: LlmCompleteArgs): Promise<LlmCompleteResult> {
  const message = await getAnthropic().messages.create({
    model:      ANTHROPIC_MODEL,
    max_tokens: args.maxTokens,
    system:     args.system,
    messages:   [{ role: 'user', content: args.user }],
  })
  const text = message.content.find(b => b.type === 'text')?.text || ''
  return { text }
}

// DeepSeek exposes an OpenAI-compatible /chat/completions endpoint. Enabling
// json_object response_format is safe because the prompts already instruct the
// model to return valid JSON only.
async function completeDeepseek(args: LlmCompleteArgs): Promise<LlmCompleteResult> {
  const apiKey = process.env.DEEPSEEK_API_KEY
  if (!apiKey) throw new Error('DEEPSEEK_API_KEY not configured')

  const res = await fetch(`${DEEPSEEK_BASE}/chat/completions`, {
    method: 'POST',
    headers: {
      'authorization': `Bearer ${apiKey}`,
      'content-type':  'application/json',
    },
    body: JSON.stringify({
      model:       DEEPSEEK_MODEL,
      max_tokens:  args.maxTokens,
      // 0.35 not 0.1 — direction is enforced deterministically by the prompt
      // rules; the entropy budget is spent on confidence-score calibration.
      // Observed: temp 0.1 pinned every signal at confidence=72 across 33
      // consecutive calls while the rules engine varied 64–95 on the same
      // ticks. Higher temp restores variance without destabilising direction.
      temperature: 0.35,
      messages: [
        { role: 'system', content: args.system },
        { role: 'user',   content: args.user },
      ],
      response_format: { type: 'json_object' },
    }),
  })

  if (!res.ok) {
    const body = await res.text().catch(() => '')
    // Normalise error text so the existing credit/quota/rate-limit heuristics
    // in scan/route.ts continue to work for both providers.
    let hint = ''
    if (res.status === 429) hint = ' (rate limit)'
    else if (res.status === 402) hint = ' (insufficient credit)'
    else if (res.status === 401 || res.status === 403) hint = ' (auth)'
    const err: any = new Error(`DeepSeek ${res.status}${hint}: ${body.slice(0, 300)}`)
    err.status = res.status
    throw err
  }

  const data = await res.json() as { choices?: Array<{ message?: { content?: string } }> }
  const text = data.choices?.[0]?.message?.content || ''
  return { text }
}

export async function llmComplete(args: LlmCompleteArgs): Promise<LlmCompleteResult> {
  return activeProvider() === 'deepseek' ? completeDeepseek(args) : completeAnthropic(args)
}
