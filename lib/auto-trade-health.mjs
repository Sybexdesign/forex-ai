// lib/auto-trade-health.mjs
// Pure, deterministic Auto Trade / Signal health classifier (Phase I). All DB
// I/O stays in app/api/data-health/route.ts; this module turns normalised inputs
// into the health verdict + payload so the rules are unit-testable.
//
// • Worker alive when heartbeat ≤ 180 s old.
// • Every broker_configs row is an ACCOUNT. Health targets the account actually
//   viewed/traded (?configId=… else newest ACTIVE). Sibling accounts never mask
//   each other: fresh primary + stale active sibling → WARNING; each account is
//   listed independently in `accounts`.
// • Engine stalled ONLY when worker alive, market open (or unknown) and no
//   signal check for > 300 s. HOLD runs are healthy evaluation, never a stall.
// • PII-safe: accounts are anonymised acct-<n>; raw config/user ids never emitted.
// Observability only — never drives execution.
// ─────────────────────────────────────────────────────────────────────────────
const WORKER_MAX_AGE_MS = 180_000
const FEED_MAX_AGE_MS = 600_000
const ENGINE_MAX_AGE_MS = 300_000
const iso = (ms) => (ms == null || ms === '' || !Number.isFinite(Number(ms)) ? null : new Date(Number(ms)).toISOString())

/**
 * @param {object} o — { nowMs, configId, accounts:[{id,isActive,lastSyncMs}],
 *   workerLastSeenMs, lastSigCheckMs, marketOpen,
 *   events:{lastSignalMs,lastActionableMs,lastHoldMs,lastOrderMs},
 *   gates:{staleCandleSkip,staleSignalReject,duplicateSignalReject,entryDriftReject} }
 */
export function classifyAutoTradeHealth(o = {}) {
  const nowMs = Number.isFinite(o.nowMs) ? o.nowMs : Date.now()
  const configId = typeof o.configId === 'string' && o.configId ? o.configId : null
  const raw = Array.isArray(o.accounts) ? o.accounts : []

  // Internal index of accounts (ids used ONLY for selection — never returned).
  const feedRows = raw
    .map((r) => ({
      id: String(r.id),
      isActive: !!r.isActive,
      lastSyncMs: Number.isFinite(Number(r.lastSyncMs)) ? Number(r.lastSyncMs) : null,
    }))
    .sort((a, b) => (b.lastSyncMs ?? 0) - (a.lastSyncMs ?? 0))
  const accounts = feedRows.map((r, i) => ({
    account: `acct-${i + 1}`,
    isActive: r.isActive,
    lastSyncAt: iso(r.lastSyncMs),
    feedAgeSec: r.lastSyncMs ? Math.max(0, Math.round((nowMs - r.lastSyncMs) / 1000)) : null,
    fresh: !!r.lastSyncMs && (nowMs - r.lastSyncMs) <= FEED_MAX_AGE_MS,
  }))
  const activeAccounts = accounts.filter((a) => a.isActive)
  const staleActive = activeAccounts.filter((a) => !a.fresh)
  const staleInactive = accounts.filter((a) => !a.isActive && !a.fresh)

  // Primary selection: explicit configId → newest ACTIVE → newest overall.
  let primaryIndex = -1
  if (configId) {
    const hit = feedRows.findIndex((r) => r.id === configId)
    if (hit >= 0) primaryIndex = hit
  }
  if (primaryIndex < 0) {
    const actIdx = feedRows.findIndex((r) => r.isActive)
    primaryIndex = actIdx >= 0 ? actIdx : (feedRows.length ? 0 : -1)
  }
  const primary = primaryIndex >= 0 ? accounts[primaryIndex] : null
  const feedAgeSec = primary?.feedAgeSec ?? null
  const feedFresh = !!primary?.fresh
  const anyActiveStale = staleActive.length > 0

  // Worker / engine inputs.
  const wl = o.workerLastSeenMs
  const workerAlive = wl != null && Number.isFinite(wl) && (nowMs - wl) <= WORKER_MAX_AGE_MS
  const workerAgeSec = wl != null && Number.isFinite(wl)
    ? Math.max(0, Math.round((nowMs - wl) / 1000)) : null
  const marketOpen = o.marketOpen === true || o.marketOpen === false ? o.marketOpen : null
  const lsc = o.lastSigCheckMs
  const sigCheckAgeSec = lsc != null && Number.isFinite(lsc)
    ? Math.max(0, Math.round((nowMs - lsc) / 1000)) : null
  const engineStalled = workerAlive && marketOpen !== false &&
    (sigCheckAgeSec === null || sigCheckAgeSec > ENGINE_MAX_AGE_MS / 1000)

  const primaryStale = feedAgeSec !== null && !feedFresh
  // When an account is EXPLICITLY selected (?configId=) its status reflects that
  // account alone; sibling staleness is reported in accounts[] but does not
  // degrade the selected view. Without a selector, a fresh primary + stale
  // active sibling degrades to WARNING (no healthy account masks a stale one).
  const siblingDegrade = !configId && anyActiveStale
  const marketStale = primaryStale || siblingDegrade
  const status = !workerAlive ? 'WORKER OFFLINE'
    : marketStale ? (primaryStale ? 'MARKET DATA STALE' : 'WARNING')
    : engineStalled ? 'SIGNAL ENGINE STALLED'
    : 'HEALTHY'

  const ev = o.events || {}
  const g = o.gates || {}
  return {
    status,
    scope: configId ? { mode: 'config', configId } : { mode: 'primary-active' },
    accounts,
    worker: { alive: workerAlive, lastHeartbeatAt: iso(wl), heartbeatAgeSec: workerAgeSec },
    marketData: {
      lastUpdateAt: primary?.lastSyncAt ?? null,
      feedAgeSec,
      fresh: feedFresh,
      account: primary?.account ?? null,
      accountCount: accounts.length,
      activeAccountCount: activeAccounts.length,
      staleActiveAccounts: staleActive.length,
      staleInactiveAccounts: staleInactive.length,
    },
    signals: {
      engineRunning: sigCheckAgeSec !== null && sigCheckAgeSec <= ENGINE_MAX_AGE_MS / 1000,
      sigCheckAgeSec,
      lastSignalAt: iso(ev.lastSignalMs),
      lastActionableAt: iso(ev.lastActionableMs),
      lastHoldAt: iso(ev.lastHoldMs),
      note: marketOpen === false
        ? 'Market closed — no signal evaluation expected (not a stall).'
        : 'Engine is running; HOLD signals are normal strategy output, not a stall.',
    },
    execution: {
      lastOrderAt: iso(ev.lastOrderMs),
      // Phase J — distinct observable counters (routine stale-candle skips are
      // NOT execution rejections).
      staleCandleSkipCount: Number(g.staleCandleSkip) || 0,
      staleSignalRejectCount: Number(g.staleSignalReject) || 0,
      duplicateSignalRejectCount: Number(g.duplicateSignalReject) || 0,
      entryDriftRejectCount: Number(g.entryDriftReject) || 0,
    },
  }
}
