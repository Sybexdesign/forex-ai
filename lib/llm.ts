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
  /**
   * Hard wall-clock bound on the provider call, in ms. On expiry the request is
   * ABORTED and this function THROWS, so the caller's deterministic rules engine
   * takes over instead of the request hanging.
   *
   * WHY THIS EXISTS (option C — bounded provider latency)
   *
   * Neither provider had any timeout at all: the Anthropic SDK defaults to ~10
   * minutes, and the DeepSeek `fetch` had no signal. A slow or black-holed
   * provider therefore stalled the entire signal request until the CALLER's own
   * client timeout fired (the scalper worker aborts at 45s), turning a slow model
   * into a LOST signal rather than a degraded-but-usable one. Bounding it here
   * means a slow provider costs `timeoutMs` and then yields a real rule-based
   * signal — never a stall.
   *
   * Default: `LLM_TIMEOUT_MS` env, else 15s. Clamped to [1s, 120s].
   * This adds NO latency to the happy path.
   */
  timeoutMs?: number
}

export interface LlmCompleteResult {
  text: string
}

/** Bound on the provider call when neither the argument nor the env sets one. */
export const DEFAULT_LLM_TIMEOUT_MS = 15_000
/** Floor — below this a healthy provider would be aborted mid-flight. */
export const MIN_LLM_TIMEOUT_MS = 1_000
/** Ceiling — beyond this the caller's own client timeout would fire first anyway. */
export const MAX_LLM_TIMEOUT_MS = 120_000

/**
 * Resolve the effective provider timeout. Never throws: a nonsense env value
 * falls back to the default rather than disabling the bound, because "no timeout"
 * is the failure mode this exists to remove.
 */
export function resolveLlmTimeoutMs(explicit?: number): number {
  const raw = Number(explicit ?? process.env.LLM_TIMEOUT_MS ?? DEFAULT_LLM_TIMEOUT_MS)
  if (!Number.isFinite(raw)) return DEFAULT_LLM_TIMEOUT_MS
  return Math.min(MAX_LLM_TIMEOUT_MS, Math.max(MIN_LLM_TIMEOUT_MS, Math.trunc(raw)))
}

/**
 * One legible, typed error for an aborted call, so the caller's catch block
 * (which falls back to the rules engine) reports a cause rather than a raw
 * DOMException, and so quota/credit heuristics downstream cannot misread it.
 */
function llmTimeoutError(provider: LlmProvider, ms: number, cause: unknown): Error {
  const err: any = new Error(
    `LLM timeout after ${ms}ms (provider=${provider}) — aborting and falling back to the rules engine`,
  )
  err.name = 'LlmTimeoutError'
  err.status = 408
  err.cause = cause
  return err
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
  const timeoutMs = resolveLlmTimeoutMs(args.timeoutMs)
  // Hard abort as well as the SDK's own `timeout`, so the bound holds even if a
  // future SDK build changes how it applies the option.
  const signal = AbortSignal.timeout(timeoutMs)
  let message: Awaited<ReturnType<Anthropic['messages']['create']>>
  try {
    message = await getAnthropic().messages.create(
      {
        model:      ANTHROPIC_MODEL,
        max_tokens: args.maxTokens,
        system:     args.system,
        messages:   [{ role: 'user', content: args.user }],
      },
      { signal, timeout: timeoutMs },
    )
  } catch (e) {
    // Only the abort is re-labelled; a genuine API error (401/429/…) must keep its
    // own identity so the existing quota/credit heuristics still recognise it.
    if (signal.aborted) throw llmTimeoutError('anthropic', timeoutMs, e)
    throw e
  }
  const text = message.content.find(b => b.type === 'text')?.text || ''
  return { text }
}

// DeepSeek exposes an OpenAI-compatible /chat/completions endpoint. Enabling
// json_object response_format is safe because the prompts already instruct the
// model to return valid JSON only.
async function completeDeepseek(args: LlmCompleteArgs): Promise<LlmCompleteResult> {
  const apiKey = process.env.DEEPSEEK_API_KEY
  if (!apiKey) throw new Error('DEEPSEEK_API_KEY not configured')

  const timeoutMs = resolveLlmTimeoutMs(args.timeoutMs)
  const signal = AbortSignal.timeout(timeoutMs)

  let res: Response
  try {
    res = await fetch(`${DEEPSEEK_BASE}/chat/completions`, {
      method: 'POST',
      signal,
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
  } catch (e) {
    // A black-holed provider used to hang here indefinitely; bound it and hand the
    // caller a typed reason so its rules-engine fallback engages promptly.
    if (signal.aborted) throw llmTimeoutError('deepseek', timeoutMs, e)
    throw e
  }

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
