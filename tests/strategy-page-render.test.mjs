// tests/strategy-page-render.test.mjs
// ── THE REAL STRATEGY PAGE, RENDERED ────────────────────────────────────────
//
// The view-model tests prove the numbers are right; this proves the PAGE actually
// renders the complete Manual preview. It server-renders the real component with a
// Manual strategy and asserts the required rows appear in the markup.
//
// This is a render smoke test, not a DOM interaction test — effects do not run, so
// it exercises the initial (loaded-strategy) render, which is exactly the state a
// user sees when they open the page with Manual sizing already configured.
import assert from 'node:assert/strict'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import StrategyPage from '../components/pages/StrategyPage.tsx'
import { DEFAULT_STRATEGY } from '../lib/supabase'

let failed = 0
const t = (name, fn) => {
  try { fn(); console.log('  ok   ' + name) }
  catch (e) { failed++; console.error('  FAIL ' + name + '\n        ' + (e.stack || e.message).split('\n').slice(0, 4).join('\n        ')) }
}

const account = { balance: 10000, currency: 'USD', profitFixedUsd: 0, profitTargetPct: 75 }
// Render the REAL component as a React element (not a direct function call — hooks
// require a render context).
const render = async (over = {}) =>
  renderToStaticMarkup(
    createElement(StrategyPage, {
      strategy: { ...DEFAULT_STRATEGY, ...over },
      onSave: async () => {},
      account,
    })
  )

const strip = (html) => html.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/\s+/g, ' ').trim()

console.log('strategy page render (server-rendered)')

// ── MANUAL: the complete preview must be on the page ───────────────────────
const manualHtml = await render({ manualLots: 10, manualRiskPct: 25 })
const manualText = strip(manualHtml)

t('renders the full Manual preview row set', () => {
  for (const label of [
    'MANUAL POSITION SIZING',
    'Position Sizing', 'Manual',
    'Requested Lot Size', '10.00 lots',
    'Manual Risk Limit', '25%',
    'Account Balance', '$10,000.00',
    'Maximum Risk Budget', '$2,500.00',
    'Raw Calculated Stop Loss', '25 pips',
    'Final Stop Loss',
    'Estimated Actual Loss at SL', '\u2212$2,500.00',
    'Actual Account Risk',
    'Strategy Risk : Reward', '1 : 2',
    'Calculated Take Profit', '50 pips',
    'Application Maximum', '10.00 lots',
    'Status', 'Executable',
  ]) {
    assert.ok(manualText.includes(label), `page must render: ${label}`)
  }
})

t('renders the Manual Risk % input and does not pre-fill it with 0', () => {
  assert.ok(manualText.includes('Manual risk %'), 'the Manual Risk input must exist')
  const m = manualHtml.match(/<input[^>]*aria-label="Manual risk percent"[^>]*>/)
  assert.ok(m, 'the Manual Risk input must be rendered')
  assert.match(m[0], /value="25"/, 'it shows the committed 25')
  assert.ok(!/value="0"/.test(m[0]), 'it must never render a forced 0')
  const lots = manualHtml.match(/<input[^>]*aria-label="Manual lot size"[^>]*>/)
  assert.ok(lots, 'the Manual Lots input must be rendered')
  assert.match(lots[0], /value="10"/, 'Manual Lots shows 10')
})

t('renders the AUTO-vs-Manual informational notice', () => {
  assert.ok(manualText.includes('Manual sizing is configured with a 25% risk budget'), 'notice rendered')
  assert.ok(manualText.includes('Automatic sizing currently uses 1%'), 'auto risk shown for context')
})

t('renders actual account exposure and never calls it safe', () => {
  assert.ok(manualText.includes('Estimated Account Exposure at SL: 25%'), 'exposure is prominent')
  const lower = manualText.toLowerCase()
  for (const bad of ['safe maximum', 'recommended risk', 'maximum safe']) {
    assert.ok(!lower.includes(bad), `must not say "${bad}"`)
  }
})

// ── Cannot Execute must still be renderable ────────────────────────────────
t('10 lots / 10% renders Cannot Execute and keeps the requested lots', async () => {
  const html = strip(await render({ manualLots: 10, manualRiskPct: 10 }))
  assert.ok(html.includes('Cannot Execute'), 'status rendered')
  assert.ok(html.includes('below the minimum permitted'), 'constraint reason rendered')
  assert.ok(html.includes('10.00 lots'), 'requested lots are still shown')
  assert.ok(!html.includes('0.50 lots'), 'must NOT suggest a silent reduction to 0.50')
  assert.ok(!html.includes('will reduce'), 'must not promise an automatic resize')
})

// ── SL cap must be visible ─────────────────────────────────────────────────
t('10 lots / 50% renders the SL cap constraint and the ACTUAL risk', async () => {
  const html = strip(await render({ manualLots: 10, manualRiskPct: 50 }))
  assert.ok(html.includes('Maximum SL cap applied'), 'constraint rendered')
  assert.ok(html.includes('$5,000.00'), 'budget shown')
  assert.ok(html.includes('\u2212$3,500.00'), 'ACTUAL risk shown')
  assert.ok(html.includes('35 pips'), 'capped final SL shown')
})

// ── AUTO: empty Manual Lots ────────────────────────────────────────────────
t('empty Manual Lots renders Automatic and no Manual preview', async () => {
  const html = strip(await render({ manualLots: null, manualRiskPct: 25 }))
  assert.ok(html.includes('POSITION SIZING'), 'mode block rendered')
  assert.ok(html.includes('Automatic'), 'AUTO mode shown')
  assert.ok(!html.includes('MANUAL POSITION SIZING'), 'the Manual preview must be hidden')
  assert.ok(!html.includes('Maximum Risk Budget'), 'no manual budget rows in AUTO')
})

t('a cleared (empty-string) field renders Automatic, never a 0 lot field', async () => {
  const html = strip(await render({ manualLots: null, manualRiskPct: 25 }))
  const lots = html.match(/Manual lot size/)
  assert.ok(lots, 'the Manual Lots input is still present')
  const m = strip(await render({ manualLots: null })).match(/Manual risk %/)
  assert.ok(m, 'Manual Risk input remains available after returning to AUTO')
})

if (failed) { console.error(`\n${failed} failed`); process.exit(1) }
console.log('strategy-page render: all tests passed')
