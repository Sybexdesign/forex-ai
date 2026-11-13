// tests/phase42-integrity-guards.test.mjs
// Phase 4.2 — regression guards for changes that cannot be exercised by a unit
// test because they are deployment configuration, MQL5 source or SQL.
//
// Every assertion here maps to a specific production defect found in the 4.2
// baseline audit, so a future edit that reintroduces it fails the build.
// Run: npm run test:phase42-guards
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8')

// ── A — vercel.json must only ask for schedules Hobby can honour ───────────
{
  const cfg = JSON.parse(read('vercel.json'))
  assert.ok(Array.isArray(cfg.crons), 'A: crons present')

  // Production evidence: outcome_reconciliation.updated_at was 1,608 hours
  // (67 days) stale while the endpoint answered 200 on demand. `*/10` was never
  // executed because the Hobby plan does not support sub-daily schedules.
  for (const c of cfg.crons) {
    const fields = c.schedule.trim().split(/\s+/)
    assert.equal(fields.length, 5, `A: ${c.path} schedule is 5-field cron`)
    const [min, hour] = fields
    assert.match(min, /^\d+$/, `A: ${c.path} must not step minutes (${c.schedule}) — Hobby cannot run sub-daily`)
    assert.match(hour, /^\d+$/, `A: ${c.path} must not step hours (${c.schedule})`)
    assert.ok(!c.schedule.includes('*/'), `A: ${c.path} has no step schedule (${c.schedule})`)
  }
  console.log('PASS A: every configured cron is daily (Vercel Hobby compatible)')
}

// ── B — the refresh endpoint must not trust a forgeable header ────────────
{
  const src = read('app/api/outcome-reconciliation/refresh/route.ts')
  assert.ok(!src.includes("'header_only_INSECURE'"), 'B: the insecure auth mode is gone')
  assert.ok(!/ok:\s*!!req\.headers\.get\('x-vercel-cron'\)/.test(src),
    'B: x-vercel-cron is never sufficient to authorise')
  assert.match(src, /cron_secret_not_configured/, 'B: unconfigured production is denied explicitly')
  assert.match(src, /function timingSafeEqual/, 'B: comparison is timing-safe')
  assert.match(src, /authorization/i, 'B: secret accepted via Authorization header')
  assert.match(src, /x-cron-secret/, 'B: secret accepted via dedicated header')
  assert.match(src, /status = auth\.authMode === 'cron_secret_not_configured' \? 503 : 401/,
    'B: misconfiguration returns 503, bad caller returns 401')
  console.log('PASS B: refresh auth requires the exact secret and never trusts a header')
}

// ── C — the worker is the scheduler, and it authenticates properly ────────
{
  const w = read('workers/scalper.mjs')
  assert.match(w, /async function refreshOutcomeReconciliation/, 'C: worker owns the refresh tick')
  assert.match(w, /await refreshOutcomeReconciliation\(\)/, 'C: refresh is called from the sweep')
  assert.match(w, /Authorization: `Bearer \$\{secret\}`/, 'C: worker sends the secret as a Bearer token')
  assert.ok(!/refresh\?secret=/.test(w), 'C: worker never puts the secret in a query string')
  assert.match(w, /RECON_REFRESH_MS/, 'C: cadence is explicit')
  assert.match(w, /RECON_STALE_WARN_MS/, 'C: staleness threshold is explicit')
  assert.match(w, /if \(!secret\)/, 'C: a missing secret blocks rather than falling back')
  assert.ok(!/x-vercel-cron/.test(w), 'C: worker does not rely on the forgeable header')
  console.log('PASS C: worker refreshes reconciliation every 10 min with the exact secret')
}

// ── D — EA v9.4 aggregates EVERY deal, not the first exit leg ─────────────
{
  const ea = read('public/SybexForexAI_EA_v9.4.mq5')
  assert.match(ea, /bool AggregatePositionDeals/, 'D: aggregator exists')
  assert.match(ea, /DEAL_ENTRY_OUT_BY/, 'D: broker-forced exits are included')
  assert.match(ea, /DEAL_ENTRY_INOUT/, 'D: reversal exits are included')
  assert.match(ea, /DEAL_ENTRY_IN\b/, 'D: the entry leg is included (entry commission)')
  assert.match(ea, /DEAL_COMMISSION/, 'D: commission read from the broker')
  assert.match(ea, /DEAL_SWAP/, 'D: swap read from the broker')
  assert.match(ea, /DEAL_FEE/, 'D: fees read from the broker')

  // The v9.3.1 defect: only the first DEAL_ENTRY_OUT was read, then `break`.
  assert.ok(!/break; \/\/ found the close deal/.test(ea),
    'D: the single-deal break is gone')
  assert.ok(!/HistorySelect\(TimeCurrent\(\) - 1200/.test(ea),
    'D: the 20-minute history window is replaced by a bounded 7-day lookback')

  // Versioned contract so server and EA cannot disagree silently.
  assert.match(ea, /executionPayloadVersion\\":2/, 'D: payload version is transmitted')
  assert.match(ea, /#property version   "9\.40"/, 'D: EA version is 9.40')

  for (const f of ['grossProfit', 'commission', 'swap', 'netProfit', 'dealTickets', 'partial']) {
    assert.ok(ea.includes('\\"' + f + '\\"'), `D: payload emits ${f}`)
  }
  console.log('PASS D: EA v9.4 aggregates every deal and transmits the cost components')
}

// ── E — the Phase 4.2 RPC migration is additive and preserves the contract ─
{
  const sql = read('supabase/migrations/20261113_phase42_rpc_broker_deal_accounting.sql')

  // Destructive statements would violate the Phase 4.2 database safety rules.
  for (const banned of ['DROP TABLE', 'TRUNCATE', 'DELETE FROM', 'ALTER TABLE']) {
    assert.ok(!sql.toUpperCase().includes(banned), `E: migration contains no ${banned}`)
  }

  // It must only replace the one function, and keep the existing grants.
  assert.match(sql, /CREATE OR REPLACE FUNCTION public\.mt5_webhook_sync/, 'E: replaces the live RPC')
  assert.match(sql, /GRANT EXECUTE ON FUNCTION public\.mt5_webhook_sync\(text, jsonb\) TO anon;/, 'E: anon grant preserved')
  assert.match(sql, /GRANT EXECUTE ON FUNCTION public\.mt5_webhook_sync\(text, jsonb\) TO authenticated;/, 'E: authenticated grant preserved')

  // The accounting behaviour.
  assert.match(sql, /executionPayloadVersion/, 'E: reads the payload version')
  assert.match(sql, /grossProfit/, 'E: prefers explicit gross')
  assert.match(sql, /v_cp_commission/, 'E: parses commission')


  assert.match(sql, /v_cp_swap/, 'E: parses swap')
  assert.match(sql, /v_payload_version >= 2/, 'E: components are gated on the v2 contract')
  assert.match(sql, /commission = v_cp_commission/, 'E: writes commission')
  assert.match(sql, /swap       = v_cp_swap/, 'E: writes swap')
  assert.match(sql, /other_fees = v_cp_fee/, 'E: writes fees')

  // Idempotency: the match predicate must still require an unaccounted row.
  assert.match(sql, /AND pl_usd    IS NULL/, 'E: re-delivery cannot overwrite an accounted row')

  // It must NOT invent a net figure when costs are absent.
  assert.match(sql, /ELSE NULL/, 'E: net is NULL when a cost term is missing')
  console.log('PASS E: Phase 4.2 RPC migration is additive, idempotent and non-destructive')
}
// ── F — every P&L surface uses the scoped populations ──────────────────────
{
  // Phase 4.2D. The Dashboard and the Journal must not disagree about the same
  // account. Both previously filtered only on `result !== 'OPEN'` and then
  // summed `pl_usd || 0`, which counted 1,143 ticket-less simulation rows as
  // trades and averaged unknown results in as breakevens.
  const journal = read('components/pages/JournalPage.tsx')
  // Assertions must ignore prose: the comments above explain the old defect by
  // quoting it, so a naive text match would flag the documentation itself.
  const code = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  const journalCode = code(journal)
  assert.match(journalCode, /buildJournalStats/, 'F: Journal statistics come from the scoped helper')
  assert.ok(!/pl_usd \|\| 0/.test(journalCode), 'F: Journal has no pl_usd||0 coercion')
  assert.ok(!/result && t\.result !== 'OPEN'/.test(journalCode), 'F: Journal no longer defines closedTrades locally')
  assert.match(journalCode, /realisedValue/, 'F: per-row money uses the net-preferred value')

  const dashCode = code(read('components/pages/DashboardPage.tsx'))
  assert.match(read('components/pages/DashboardPage.tsx'), /buildScopedAnalytics/, 'F: Dashboard uses the scoped analytics')
  assert.ok(!/pl_usd \|\| 0/.test(dashCode), 'F: Dashboard has no pl_usd||0 coercion')

  // The order-gating path is deliberately NOT routed through the analytics
  // helper. Changing when the bot may trade is a separate decision that needs
  // its own approval, so this guard documents the boundary instead of silently
  // tightening it. If someone does route it through, they must update the
  // integrity checks at the same time.
  const shell = read('components/AppShell.tsx')
  assert.match(shell, /todayPL/, 'F: AppShell still publishes todayPL to the scanner')
  assert.ok(
    !/buildJournalStats|buildScopedAnalytics/.test(shell),
    'F: order-gating todayPL is unchanged — routing it through the analytics helper changes live trading and needs approval',
  )
  console.log('PASS F: P&L surfaces share one classifier; order-gating path untouched by design')
}

console.log('\nphase42-integrity-guards: all groups passed')
