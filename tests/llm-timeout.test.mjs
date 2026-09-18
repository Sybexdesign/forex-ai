// tests/llm-timeout.test.mjs
// Option C — bounded provider latency.
//
// Neither provider had ANY timeout (Anthropic SDK default ~10 min; DeepSeek fetch
// had no signal), so a slow/black-holed provider stalled the whole signal request
// until the scalper worker's own 45s client abort fired — turning a slow model
// into a LOST signal. These tests prove the call is now bounded, that expiry
// THROWS (so the route's existing rules-engine fallback engages), and that the
// happy path and genuine API errors are untouched.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  llmComplete, resolveLlmTimeoutMs,
  DEFAULT_LLM_TIMEOUT_MS, MIN_LLM_TIMEOUT_MS, MAX_LLM_TIMEOUT_MS,
} from '../lib/llm.ts'

let failed = 0
const t = async (name, fn) => {
  try { await fn(); console.log('  ok   ' + name) }
  catch (e) { failed++; console.error('  FAIL ' + name + '\n        ' + e.message) }
}

const SRC = readFileSync(new URL('../lib/llm.ts', import.meta.url), 'utf8')
const realFetch = globalThis.fetch
const realEnv = { ...process.env }

function restore() {
  globalThis.fetch = realFetch
  process.env = { ...realEnv }
}

console.log('llm-timeout (option C)')

await t('resolver: default when nothing is configured', () => {
  delete process.env.LLM_TIMEOUT_MS
  assert.equal(resolveLlmTimeoutMs(), DEFAULT_LLM_TIMEOUT_MS)
  assert.equal(DEFAULT_LLM_TIMEOUT_MS, 15_000)
})

await t('resolver: respects an explicit value', () => {
  assert.equal(resolveLlmTimeoutMs(5_000), 5_000)
})

await t('resolver: honours LLM_TIMEOUT_MS', () => {
  process.env.LLM_TIMEOUT_MS = '8000'
  assert.equal(resolveLlmTimeoutMs(), 8_000)
  restore()
})

await t('resolver: clamps below the floor and above the ceiling', () => {
  assert.equal(resolveLlmTimeoutMs(1), MIN_LLM_TIMEOUT_MS)
  assert.equal(resolveLlmTimeoutMs(999_999), MAX_LLM_TIMEOUT_MS)
})

await t('resolver: a nonsense value falls back to the default, never to "no bound"', () => {
  assert.equal(resolveLlmTimeoutMs(NaN), DEFAULT_LLM_TIMEOUT_MS)
  process.env.LLM_TIMEOUT_MS = 'not-a-number'
  assert.equal(resolveLlmTimeoutMs(), DEFAULT_LLM_TIMEOUT_MS)
  restore()
})

await t('resolver: explicit argument beats the env', () => {
  process.env.LLM_TIMEOUT_MS = '9000'
  assert.equal(resolveLlmTimeoutMs(3_000), 3_000)
  restore()
})

// ── the bound actually fires ────────────────────────────────────────────────
await t('deepseek: a black-holed provider THROWS on expiry (does not hang)', async () => {
  process.env.LLM_PROVIDER = 'deepseek'
  process.env.DEEPSEEK_API_KEY = 'test-key'
  // Mirror real fetch semantics: reject with the abort reason when signalled.
  globalThis.fetch = (_url, init) => new Promise((_res, rej) => {
    init.signal.addEventListener('abort', () => rej(init.signal.reason))
  })
  // NOTE: `AbortSignal.timeout()` is UNREF'D — it does not hold the event loop
  // open. In an idle test process Node would exit before the timer fired, so a
  // keep-alive is required. In production the Next.js server always has a live
  // loop, so the bound fires normally; this is purely a harness concern.
  const keepAlive = setInterval(() => {}, 100)
  const started = Date.now()
  let err = null
  try {
    await llmComplete({ system: 's', user: 'u', maxTokens: 10, timeoutMs: MIN_LLM_TIMEOUT_MS })
  } catch (e) { err = e }
  const elapsed = Date.now() - started
  clearInterval(keepAlive)
  assert.ok(err, 'must throw, not resolve')
  assert.equal(err.name, 'LlmTimeoutError')
  assert.equal(err.status, 408)
  assert.match(err.message, /LLM timeout after 1000ms \(provider=deepseek\)/)
  assert.ok(elapsed < 5_000, `must abort near the bound, took ${elapsed}ms`)
  restore()
})

await t('deepseek: the abort is what marks it a timeout, not merely any failure', async () => {
  process.env.LLM_PROVIDER = 'deepseek'
  process.env.DEEPSEEK_API_KEY = 'test-key'
  // Network error that is NOT an abort: must keep its own identity.
  globalThis.fetch = () => Promise.reject(Object.assign(new Error('ECONNRESET'), { code: 'ECONNRESET' }))
  let err = null
  try {
    await llmComplete({ system: 's', user: 'u', maxTokens: 10, timeoutMs: MIN_LLM_TIMEOUT_MS })
  } catch (e) { err = e }
  assert.ok(err)
  assert.notEqual(err.name, 'LlmTimeoutError', 'a real network error must not be relabelled')
  assert.match(err.message, /ECONNRESET/)
  restore()
})

// ── happy path untouched ────────────────────────────────────────────────────
await t('deepseek: a fast response is returned unchanged (no added latency)', async () => {
  process.env.LLM_PROVIDER = 'deepseek'
  process.env.DEEPSEEK_API_KEY = 'test-key'
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({ choices: [{ message: { content: '{"direction":"BUY","confidence":71}' } }] }),
  })
  const { text } = await llmComplete({ system: 's', user: 'u', maxTokens: 600, timeoutMs: MIN_LLM_TIMEOUT_MS })
  assert.equal(text, '{"direction":"BUY","confidence":71}')
  restore()
})

await t('deepseek: an HTTP error still surfaces its status for quota heuristics', async () => {
  process.env.LLM_PROVIDER = 'deepseek'
  process.env.DEEPSEEK_API_KEY = 'test-key'
  globalThis.fetch = async () => ({ ok: false, status: 402, text: async () => 'insufficient balance' })
  let err = null
  try {
    await llmComplete({ system: 's', user: 'u', maxTokens: 10 })
  } catch (e) { err = e }
  assert.ok(err)
  assert.equal(err.status, 402)
  assert.match(err.message, /insufficient credit/)
  restore()
})

// ── anthropic parity (source-level: the SDK call cannot be stubbed cheaply) ──
await t('anthropic: the SDK call is given both an abort signal and a timeout', () => {
  const fn = SRC.slice(SRC.indexOf('async function completeAnthropic'))
  assert.match(fn, /AbortSignal\.timeout\(timeoutMs\)/, 'must create an abort signal')
  assert.match(fn, /\{\s*signal,\s*timeout:\s*timeoutMs\s*\}/, 'must pass both to messages.create')
  assert.match(fn, /if \(signal\.aborted\) throw llmTimeoutError\('anthropic'/, 'abort must become LlmTimeoutError')
})

await t('no provider is left unbounded', () => {
  const ds = SRC.slice(SRC.indexOf('async function completeDeepseek'))
  assert.match(ds, /signal,/, 'deepseek fetch must pass a signal')
})

if (failed) { console.error(`\n${failed} failed`); process.exit(1) }
console.log('llm-timeout: all tests passed')

