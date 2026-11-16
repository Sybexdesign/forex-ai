# ACTIVE TRADING HOURS — AUDIT

**Repository:** SybexForexAI
**Audit baseline commit:** `00cd0ab` (`main`, 3 commits ahead of `origin/main`)
**Audit type:** read-only trace. **No file was modified to produce this document.**
**Date:** 2026-12-11

---

## 0. Headline finding

> The saved "ACTIVE TRADING HOURS (UTC)" setting exists, is persisted correctly, and
> is **displayed** as an AI constraint — but it is enforced in **exactly one place,
> as a warning that cannot block anything**. Signal generation, worker execution and
> order submission all proceed regardless of it.

The section's own subtitle says it aloud (`components/pages/StrategyPage.tsx:705`):

> *"AI will only generate signals during these hours. Outside this window signals are
> marked as low-priority."*

"Low-priority" is not a gate. The audit below proves there is no gate.

---

## 1. The authoritative setting

### 1.1 Shape

It is **not** a named session ("LONDON"). It is a pair of integer UTC hours:

| Artifact | Location |
|---|---|
| Type | `lib/supabase.ts:81-82` — `sessionStart: number; sessionEnd: number` |
| Default | `lib/supabase.ts:117-118` — `sessionStart: 7, sessionEnd: 20` (`DEFAULT_STRATEGY`) |
| Persistence | `strategies.settings` JSONB, per `user_id` (`app/api/strategy/route.ts:22-27`, `POST` at `:69-79`) |
| Worker mirror | `workers/scalper.mjs:111-112` — `sessionStart: 0, sessionEnd: 24` (a *different* default) |

The UI presents four presets (`StrategyPage.tsx:734-741`):

```ts
{ label: 'London', start: 7,  end: 16 },
{ label: 'NY',     start: 13, end: 22 },
{ label: 'Asian',  start: 23, end: 8  },   // crosses midnight
{ label: 'All Day',start: 0,  end: 23 },
```

Selecting "London" therefore saves `sessionStart = 7, sessionEnd = 16`. **That is the
exact saved configuration the spec's "LONDON" example refers to.** No new setting is
required, and none may be invented (§3.1 of the brief).

### 1.2 Lifecycle — create → save → load → generator → worker → execution

| Step | Where | Verdict |
|---|---|---|
| Create | `StrategyPage.tsx:159` `useState<StrategySettings>({ ...strategy })` | ✅ |
| Edit | `set()` at `:205-209` clamps start/end to `0..23` | ✅ |
| Save | `handleSave` → `onSave(local)` (`:217-223`) → `useForex.save()` → `POST /api/strategy` | ✅ |
| Persist | `app/api/strategy/route.ts:69-79` upserts `settings` wholesale; **no session validation** | ⚠️ any shape is accepted |
| Local cache | `hooks/useForex.ts:205-207,233` — `localStorage['forexai_strategy_v2']` seeds state **before** the DB read | ❌ second source of truth |
| Load (client) | `hooks/useForex.ts:247` `GET /api/strategy?userId=` | ✅ |
| Load (server, generic) | `app/api/strategy/route.ts:15-47` | ✅ |
| Active-strategy selection | **no concept exists** — one row per `user_id` | ✅ (single strategy, so `strategies.settings` *is* the active config) |
| Signal generator | ✗ never reads it | ❌ |
| Worker | reads it into `liveStrategy` but never evaluates it | ❌ |
| Execution | ✗ never reads it | ❌ |

**Active-strategy note.** There is exactly one strategy row per user (`upsert … onConflict: 'user_id'`,
`app/api/strategy/route.ts:77-79`). "Which strategy is active" is therefore unambiguous
and needs no new selection mechanism. If the row is absent, `GET` returns
`DEFAULT_STRATEGY` (`:17`, `:40`) — a defined 07:00–20:00 UTC window, not 24 h.

---

## 2. Enforcement matrix across the pipeline

| # | Stage | Requirement | Implemented? | Evidence |
|---|---|---|---|---|
| A | Signal generation | block outside saved window | ❌ | `app/api/scalper/signal/route.ts:474` takes `strategy` as a **string** (`'Scalp'`/`'Breakout'`), never the settings object; no session reference in the file |
| B | AI decision context | AI must receive the saved config | ❌ | prompt builders at `:59-90` are static strategy templates; no session injected |
| C | Signal persistence | persist config hash, session, UTC eval time, eligibility | ❌ | no such columns or payload fields exist (§5) |
| D | Worker execution | reload config, re-evaluate, reject outside window | ❌ | `liveStrategy.sessionStart/sessionEnd` are assigned (`workers/scalper.mjs:111-112`) and **never read again** — `grep -n 'sessionStart' workers/scalper.mjs` returns only those two definition lines |
| E | Order submission | final independent server-side check | ❌ | `app/api/orders/route.ts` has no session check; the only hours logic in the order path is the inert warning in §3 |
| F | UI status | derived from the same server logic | ❌ | `StrategyPage` renders the saved numbers plus a decorative bar (`:753-775`); no current UTC time, no active/inactive state, no next boundary |

**Nothing in the pipeline is gated by the saved hours.** The only code that even
*looks* at them is `lib/risk.ts`, and it cannot block.

---

## 3. The one existing check, and why it is inert

`lib/risk.ts:89-99`:

```ts
// 5. Session hours check
const now = new Date()
const currentHour = now.getUTCHours()
if (currentHour < strategy.sessionStart || currentHour >= strategy.sessionEnd) {
  checks.push({
    allowed: true,                 // ← allows
    severity: 'WARN',              // ← warns
    reason: `Outside configured trading hours (…). Signal may be unreliable.`,
  })
}
```

`isTradeAllowed()` (`lib/risk.ts:108-110`) blocks only on `severity === 'BLOCK' &&
!allowed`. A `WARN` therefore has **no effect on submission**. The only caller is
`/api/orders` (`:410-431`), which consumes `getWarnings()` as advisory text.

### H-1 — out-of-hours trading is permitted (Critical)

This is the whole requirement. A London-selected user can have an order submitted at
02:00 UTC.

### H-2 — midnight-crossing windows are inverted (Critical)

For every preset except Asian, `sessionStart < sessionEnd`. For **Asian** (23 → 8),
`lib/risk.ts:91` evaluates `currentHour < 23 || currentHour >= 8`, true for every hour
except 23:00–23:59. **The Asian window is reported "outside" for its entire actual
duration (00:00–07:59)** — the inverse of the saved configuration.

### H-3 — the "All Day" preset excludes an hour (High)

`{ start: 0, end: 23 }` with an exclusive end means 23:00–23:59 UTC is "outside". The
label and the behaviour disagree, and the *displayed* bar (`StrategyPage.tsx:756-758`)
uses `end - start + 1` — an **inclusive** end — so drawing and check disagree too:
three conflicting boundary conventions in one feature.


### H-4 — worker default is a different window from the app default (High)

`lib/supabase.ts:117-118` → `7..20`. `workers/scalper.mjs:111-112` → `0..24`.
`end: 24` is outside the UI's `0..23` range and is not representable by the setting it
mirrors. The comment at `scalper.mjs:99-101` claims these defaults "mirror
DEFAULT_STRATEGY in lib/supabase.ts" — for these two fields they do not.

### H-5 — the client can display hours the server will not use (High)

`hooks/useForex.ts:233` initialises strategy state from
`localStorage['forexai_strategy_v2']` and only later reconciles with
`GET /api/strategy` (`:247`). Between those moments the UI shows cached hours, and the
dashboard's signal actions use that cached object. Once the server enforces the saved
window, a stale cache produces a UI that believes it is inside a window the server
would reject. The read path has two sources of truth.

### H-6 — no UTC clock anywhere in the UI (Medium)

The value is labelled "UTC" and the browser never shows the current UTC hour or the
evaluated state. A user at 07:55 UTC cannot tell whether the window is open.

### H-7 — invalid configuration is accepted silently (High)

`POST /api/strategy` (`:69-79`) validates only sizing fields
(`normaliseSizingSettings`). `sessionStart: 'banana'`, `sessionEnd: 99`, or a missing
key are all stored as-is. `lib/risk.ts:91` then compares a number with a string, which
evaluates to `false` for every comparison → the WARN never fires and the window
silently becomes 24 h. **Fail-open by type confusion.**

### H-8 — the decision is never persisted (Medium)

Nothing records which window was in force when a signal was generated or an order
submitted, so no post-hoc audit can prove the gate ran or what it saw.

---

## 4. Boundary and daylight-saving analysis

### 4.1 Boundary convention (must be fixed once)

| Source | Convention | Effective window, London preset |
|---|---|---|
| `lib/risk.ts:91` | start inclusive, **end exclusive** | 07:00–15:59 ✅ |
| `StrategyPage.tsx:756-758` | start inclusive, **end inclusive** (`end - start + 1`) | 07:00–16:59 ❌ |
| Spec acceptance table | 07:59 block · 08:00 permit · 15:59 permit · **16:00 block** | start inclusive, end exclusive ✅ |

**Decision:** start inclusive, end exclusive. It matches the spec's acceptance table
and the only existing server-side check; the drawing is cosmetic and will be aligned.

### 4.2 Daylight saving

The setting is a **fixed UTC hour band**, not a named local session. There is no offset
to convert, so DST cannot shift eligibility:

- "London preset" = 07:00–16:00 **UTC** all year. Under BST that is 08:00–17:00 London
  local; under GMT it is 07:00–16:00 local.
- This is deliberate, and it is what the label "ACTIVE TRADING HOURS (UTC)" means. The
  brief explicitly forbids inventing a fixed local offset for named sessions ("Do not
  introduce a new fixed UTC offset based on assumptions about London daylight saving
  time").
- `lib/uk-time.mjs` stays a *display* helper and must never become an eligibility input.

**Verification:** tests assert that identical UTC instants either side of the
Europe/London DST transition produce identical eligibility for the same saved window.

### 4.3 Midnight crossing

Asian `23 → 8` must be evaluated as `h >= 23 || h < 8`. A naive `h >= start && h < end`
returns false for all 24 hours — the exact bug in H-2.


---

## 5. Where the decision must be persisted (constraint)

There is **no `signals` table** in any migration (`grep 'CREATE TABLE.*signals'
supabase/migrations/*.sql` → no matches). `app/api/signals/route.ts` queries one
anyway and therefore always fails soft to `[]`/500 — it is an orphan endpoint, not a
persistence path.

Existing durable surfaces available without a migration:

| Surface | Columns | Suitable for |
|---|---|---|
| `trades` | `signal_at`, `signal_confidence`, `signal_id_ref`, `source`, `authority_*`, `notes` | per-order lineage |
| `filter_rejections` | `filter_name`, `filter_stage`, `reason`, `indicator_snapshot` (JSONB), `pair`, `user_id` | pre-signal gate rejections (already written by `logGateRejection`, `app/api/scalper/signal/route.ts:425-467`) |
| `worker_logs` | `level`, `message`, `session`, `metadata` (JSONB) | worker decisions |

**Decision:** reuse `filter_rejections` for generation-time refusals and `worker_logs`
for worker decisions, encoding the full audit payload (window, instant, hash,
eligibility) in the existing JSONB fields. **No migration enters the application
path.** A dedicated `signal_session_audit` table/columns is prepared as a migration
file only, for the owner to review separately.

---

## 6. Consistency requirement (the single implementation rule)

The same `(settings, instant)` pair must yield the same answer in:

| Consumer | Today | After |
|---|---|---|
| Strategy UI | decorative bar | same module, server-evaluated |
| Signal generation API | none | same module |
| AI context | none | same module |
| Worker | none | same module |
| Final order gate | inert WARN | same module |

**One pure module, no I/O, no `next/server` import, importable by the worker (ESM),
the routes and the client component.** This is the same pattern already used for
`lib/analytics-scope.mjs`, `lib/order-authority.mjs` and `lib/lot-size.mjs`, so it is
consistent with the codebase rather than a new convention.

---

## 7. Defect → fix traceability matrix

| ID | Defect | Severity | Fix | Owner gate |
|---|---|---|---|---|
| H-1 | No enforcement anywhere | **Critical** | shared module + gates at A/D/E | deploy approval |
| H-2 | Midnight wrap inverted | **Critical** | wrap-aware interval in shared module | — |
| H-3 | All Day excludes 23:00–23:59; bar vs check disagree | High | preset → `0..24`; bar drawn from the same interval | — |
| H-4 | Worker default `0..24` ≠ app default `7..20` | High | worker default aligned to `DEFAULT_STRATEGY`; `24` accepted as end-of-day | — |
| H-5 | localStorage pre-seeds a second source of truth | High | server evaluation endpoint; UI marks cached values as provisional | — |
| H-6 | No UTC clock / state shown | Medium | UI adds current UTC, state, next open/close | — |
| H-7 | Invalid config stored, fails open | High | validate on write (`0..24`, integer, start ≠ end) + fail closed on read | — |
| H-8 | Decision not persisted | Medium | `filter_rejections` / `worker_logs` JSONB | — |
| — | Dedicated audit columns | Low | **prepared migration only** | review |

---

## 8. What must NOT be done

- Do not add a second trading-hours setting; `strategies.settings.sessionStart/End` is
  authoritative.
- Do not replace the UTC hour band with a named session or a local-time window.
- Do not change `minStrength`, `riskPct`, `maxLoss`, SL/TP, lot sizing, Prop Firm
  overlap rules, direction confirmation or order authority. The session gate is
  **additive**: it can only remove trades, never add them, never resize one.
- Do not weaken signal expiry or stale-signal protection (§3.D) — the gate is applied
  *in addition* to them.
- Do not fail **open** for any reason: unknown config, missing user, missing timestamp,
  parse error, DB error.

---

## 9. Reproducing every claim

```bash
sed -n '81,82p;117,118p' lib/supabase.ts                     # setting shape + default
sed -n '700,780p' components/pages/StrategyPage.tsx          # UI, presets, decorative bar
sed -n '85,100p' lib/risk.ts                                 # the inert WARN
sed -n '105,115p' workers/scalper.mjs                        # worker default 0..24
grep -n 'sessionStart' workers/scalper.mjs                   # → only the 2 definition lines
grep -n 'session' app/api/scalper/signal/route.ts            # → none
grep -n 'session' app/api/orders/route.ts                    # → none
grep -rn 'CREATE TABLE.*signals' supabase/migrations/        # → none
```

