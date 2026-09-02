-- ============================================================
-- 20260902_expectancy_intelligence.sql
-- Expectancy Engine + Trade Authority + Safety Score + Loss
-- Diagnosis + Counterfactual Replay + Qualified Setup Alerts.
--
-- EVERYTHING HERE IS ADDITIVE: existing tables, risk guards,
-- gating order and execution paths are untouched. The new layer
-- records its own statistics and decisions in shadow mode and
-- feeds the Auto Trade page + Telegram qualified-setup alerts.
--
-- Design notes:
--  * `user_id` is nullable. NULL rows are GLOBAL statistics that
--    any authenticated user may read (platform-wide signal
--    reconciliation stats are already global in this app). All
--    writes go through the service-role key (server only), so no
--    INSERT/UPDATE policies are granted to clients.
--  * The Expectancy engine computes R-multiple samples from two
--    sources: (a) closed broker `trades` (actual realised P&L /
--    planned 1R risk) and (b) resolved `prediction_logs`
--    (SL/TP touch semantics with MFE/MAE). Segment statistics are
--    snapshotted into expectancy_statistics with an upsert key of
--    (segment_key, computed_from, window_days) so recomputes are
--    idempotent.
-- ============================================================

-- ── 1. trade_setups: lifecycle of every setup that reached the
-- authority layer. status: DETECTED → QUALIFIED → ALERTED →
-- ACTED | EXPIRED | REJECTED | SUPPRESSED (one row per unique
-- setup_key per lifetime window).
create table if not exists public.trade_setups (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid references auth.users(id) on delete cascade,
  setup_key       text not null,           -- stable signature of the setup
  pair            text not null,
  direction       text not null check (direction in ('BUY', 'SELL', 'HOLD')),
  timeframe       text not null default '5m',
  status          text not null default 'DETECTED'
                  check (status in ('DETECTED', 'QUALIFIED', 'ALERTED', 'ACTED', 'EXPIRED', 'REJECTED', 'SUPPRESSED')),
  -- Full decision snapshot — answers "why was this taken / not taken".
  snapshot        jsonb not null default '{}'::jsonb,
  signal_id       text,                     -- optional ref (signals.id / signal_id_ref)
  trade_id        uuid references public.trades(id),  -- set when ACTED
  alert_sent_at   timestamptz,
  detected_at     timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  expires_at      timestamptz               -- authority re-evaluates after this
);

create unique index if not exists trade_setups_dedup
  on public.trade_setups (setup_key) where status in ('DETECTED', 'QUALIFIED', 'ALERTED');
create index if not exists trade_setups_user_idx  on public.trade_setups (user_id, detected_at desc);
create index if not exists trade_setups_status_idx on public.trade_setups (status, detected_at desc);

-- ── 2. expectancy_statistics: materialised segment expectancy. ───────────────
-- segment_key is a stable JSON string of the exact dimension vector. Rows are
-- upserted per (segment_key, computed_from, window_days).
create table if not exists public.expectancy_statistics (
  id                  uuid primary key default gen_random_uuid(),
  segment_key         text not null,        -- json-stringified dimension vector
  segment             jsonb not null default '{}'::jsonb,  -- human-readable dims
  computed_from       text not null check (computed_from in ('closed_trades', 'predictions', 'mixed')),
  window_days         integer not null default 60,
  pair                text,
  direction           text check (direction in ('BUY', 'SELL')),
  session             text,                 -- ASIA | LONDON | NEW_YORK | OTHER
  regime              text,                 -- chop | ranging | weak-trend | trending | strong-trend
  vol_regime          text,                 -- LOW | MEDIUM | HIGH
  setup_type          text,                 -- scalper | scalper-worker | mirror | etc.
  signal_strength_low integer,              -- inclusive confidence band floor
  signal_strength_high integer,             -- exclusive band ceiling
  sample_size         integer not null default 0,
  wins                integer not null default 0,
  losses              integer not null default 0,
  win_rate            numeric(6, 4),
  avg_win_r           numeric(8, 4),
  avg_loss_r          numeric(8, 4),
  expectancy_r        numeric(8, 4),
  profit_factor       numeric(10, 4),
  avg_win_usd         numeric(14, 2),
  avg_loss_usd        numeric(14, 2),
  median_win_r        numeric(8, 4),
  median_loss_r       numeric(8, 4),
  max_drawdown_r      numeric(8, 4),
  recent_expectancy_r numeric(8, 4),        -- last 25% of samples
  long_term_expectancy_r numeric(8, 4),     -- same-window stats seeded earlier
  sample_confidence   text not null default 'insufficient'
                      check (sample_confidence in ('insufficient', 'low', 'moderate', 'strong')),
  expectancy_status   text not null default 'INSUFFICIENT_DATA'
                      check (expectancy_status in ('VERY_STRONG', 'STRONG', 'POSITIVE', 'NEUTRAL', 'NEGATIVE', 'INSUFFICIENT_DATA')),
  computed_at         timestamptz not null default now()
);

create unique index if not exists expectancy_stats_key
  on public.expectancy_statistics (user_id, segment_key, computed_from, window_days);
create index if not exists expectancy_stats_global
  on public.expectancy_statistics (pair, direction, regime, session, vol_regime);
create index if not exists expectancy_stats_computed
  on public.expectancy_statistics (computed_at desc);

-- ── 3. trade_authority_decisions: every authority evaluation. ─────────────────
-- One row per candidate evaluation in shadow or live mode. The snapshot is the
-- complete decision context (auditability: "why was this trade taken/blocked").
create table if not exists public.trade_authority_decisions (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid references auth.users(id) on delete cascade,
  setup_id          uuid references public.trade_setups(id),
  mode              text not null default 'shadow' check (mode in ('shadow', 'live')),
  status            text not null check (status in ('APPROVED', 'DENIED', 'REVIEW', 'NO_OP')),
  pair              text not null,
  direction         text not null check (direction in ('BUY', 'SELL', 'HOLD')),
  override_ai       boolean not null default false,  -- authority would change the AI decision
  signal_score      integer,
  ai_probability    numeric(6, 4),
  ml_win_probability numeric(6, 4),
  agreement_score   integer,
  htf_alignment     text,                  -- ALIGNED | PARTIAL | OPPOSED | AMBIGUOUS | n/a
  regime            text,
  session           text,
  expectancy_r      numeric(8, 4),
  expectancy_status text,
  sample_confidence text,
  safety_score      integer,
  decision_reasons  jsonb not null default '[]'::jsonb,  -- ordered [{reason, severity}]
  snapshot          jsonb not null default '{}'::jsonb,
  created_at        timestamptz not null default now()
);

create index if not exists ta_decisions_created  on public.trade_authority_decisions (created_at desc);
create index if not exists ta_decisions_user     on public.trade_authority_decisions (user_id, created_at desc);
create index if not exists ta_decisions_status   on public.trade_authority_decisions (status, created_at desc);


-- ── 4. safety_scores: safety is scored INDEPENDENTLY of signal strength. ──────
create table if not exists public.safety_scores (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid references auth.users(id) on delete cascade,
  setup_id      uuid references public.trade_setups(id),
  setup_key     text not null,
  pair          text not null,
  direction     text not null check (direction in ('BUY', 'SELL', 'HOLD')),
  total_score   integer not null check (total_score between 0 and 100),
  components    jsonb not null default '{}'::jsonb,  -- {name: {score, weight, reason}}
  created_at    timestamptz not null default now()
);
create index if not exists safety_scores_created on public.safety_scores (created_at desc);
create index if not exists safety_scores_setup   on public.safety_scores (setup_key);

-- ── 5. setup_alerts: notification outbox with hard de-dup. ────────────────────
-- dedup_key is unique per (pair, direction, regime/session signature, time
-- bucket). A second identical qualified setup inside the bucket is suppressed.
create table if not exists public.setup_alerts (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid references auth.users(id) on delete cascade,
  setup_id      uuid references public.trade_setups(id),
  dedup_key     text not null unique,
  pair          text not null,
  direction     text not null check (direction in ('BUY', 'SELL')),
  status        text not null default 'NEW' check (status in ('NEW', 'SENT', 'SUPPRESSED', 'FAILED')),
  severity      text not null default 'QUALIFIED' check (severity in ('A', 'B', 'C', 'QUALIFIED')),
  title         text,
  body          jsonb not null default '{}'::jsonb,
  telegram_sent_at timestamptz,
  telegram_error   text,
  created_at    timestamptz not null default now()
);
create index if not exists setup_alerts_created on public.setup_alerts (created_at desc);
create index if not exists setup_alerts_status  on public.setup_alerts (status, created_at desc);

-- ── 6. trade_diagnoses: automatic explanation for every losing trade. ─────────
-- One diagnosis per (source, source_id) — idempotent per losing outcome.
create table if not exists public.trade_diagnoses (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid references auth.users(id) on delete cascade,
  source        text not null check (source in ('closed_trade', 'prediction', 'reconciliation')),
  source_id     text not null,             -- trades.id / prediction_logs.id / signal_reconciliation.id
  pair          text not null,
  direction     text not null check (direction in ('BUY', 'SELL')),
  outcome       text not null check (outcome in ('WIN', 'LOSS')),
  r_multiple    numeric(8, 4),
  mfe_pips      numeric(10, 2),
  mae_pips      numeric(10, 2),
  diagnosis_code   text not null,          -- e.g. GAP_THROUGH_SL, SL_TOO_TIGHT …
  diagnosis        text not null,
  severity         text not null check (severity in ('INFO', 'WARN', 'CRITICAL')),
  evidence         jsonb not null default '{}'::jsonb,
  created_at       timestamptz not null default now(),
  unique (source, source_id)
);
create index if not exists trade_diagnoses_created on public.trade_diagnoses (created_at desc);
create index if not exists trade_diagnoses_code    on public.trade_diagnoses (diagnosis_code, created_at desc);



-- ── 7. counterfactual_results: replays ("what would have happened"). ───────────
create table if not exists public.counterfactual_results (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid references auth.users(id) on delete cascade,
  replay_key      text not null,           -- dedup: pair|direction|entryBucket|timeBucket
  pair            text not null,
  direction       text not null check (direction in ('BUY', 'SELL')),
  entry           numeric(12, 6),
  sl              numeric(12, 6),
  tp              numeric(12, 6),
  matched_count   integer not null default 0,
  win_count       integer not null default 0,
  loss_count      integer not null default 0,
  win_rate        numeric(6, 4),
  expectancy_r    numeric(8, 4),
  would_hit_tp    numeric(8, 4),           -- % of matches where TP distance was reached
  would_hit_sl    numeric(8, 4),
  avg_mfe_pips    numeric(10, 2),
  avg_mae_pips    numeric(10, 2),
  matches         jsonb not null default '[]'::jsonb,  -- top similar historical setups
  snapshot        jsonb not null default '{}'::jsonb,
  created_at      timestamptz not null default now(),
  unique (replay_key)
);
create index if not exists counterfactual_created on public.counterfactual_results (created_at desc);

-- ── 8. filter_rejections: which gate stopped the signal (bottleneck view). ─────
create table if not exists public.filter_rejections (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid references auth.users(id) on delete cascade,
  pair            text not null,
  direction       text not null check (direction in ('BUY', 'SELL', 'HOLD')),
  filter_name     text not null,           -- adx_chop | spread_gate | ml_win_prob | htf_bias | agreement | regime_min_strength | expectancy | safety | authority
  filter_stage    text not null check (filter_stage in ('pre', 'engine', 'post', 'authority', 'risk', 'execution')),
  rejection_value numeric,
  threshold       numeric,
  reason          text,
  signal_id       text,
  indicator_snapshot jsonb not null default '{}'::jsonb,
  created_at      timestamptz not null default now()
);
create index if not exists filter_rejections_created on public.filter_rejections (created_at desc);
create index if not exists filter_rejections_filter  on public.filter_rejections (filter_name, created_at desc);

-- ── 9. strategy_health: rolling health snapshot (signal scarcity, bottlenecks). ─
create table if not exists public.strategy_health (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid references auth.users(id) on delete cascade,
  "window"    text not null check ("window" in ('1d', '7d', '30d')),
  payload     jsonb not null default '{}'::jsonb,
  recorded_at timestamptz not null default now(),
  unique (user_id, "window")
);
create index if not exists strategy_health_recorded on public.strategy_health (recorded_at desc);

-- ── 10. prediction_logs segmentation columns (populated on insert going forward). ─
alter table public.prediction_logs
  add column if not exists session          text,          -- ASIA | LONDON | NEW_YORK | OTHER
  add column if not exists vol_regime       text,          -- LOW | MEDIUM | HIGH
  add column if not exists spread_condition text,          -- tight | normal | wide
  add column if not exists setup_type       text,          -- scalper | scalper-worker | mirror | generic
  add column if not exists sl_pips          numeric(10, 2),
  add column if not exists r_multiple       numeric(8, 4); -- resolved outcome in R units

-- ── 11. Realtime: qualified setups appear live on the Auto Trade page. ─────────
do $$
begin
  alter publication supabase_realtime add table public.trade_setups;
exception when duplicate_object then null;
end $$;
do $$
begin
  alter publication supabase_realtime add table public.setup_alerts;
exception when duplicate_object then null;
end $$;
do $$
begin
  alter publication supabase_realtime add table public.trade_authority_decisions;
exception when duplicate_object then null;
end $$;

-- ── RLS ────────────────────────────────────────────────────────────────────────
alter table public.trade_setups              enable row level security;
alter table public.expectancy_statistics     enable row level security;
alter table public.trade_authority_decisions enable row level security;
alter table public.safety_scores             enable row level security;
alter table public.setup_alerts              enable row level security;
alter table public.trade_diagnoses           enable row level security;
alter table public.counterfactual_results    enable row level security;
alter table public.filter_rejections         enable row level security;
alter table public.strategy_health           enable row level security;

-- Own rows OR global (user_id IS NULL) rows are readable from the browser.
-- Writes are server-side via the service-role key, so no client policies exist.
create policy "users read own or global trade_setups"
  on public.trade_setups for select using (auth.uid() = user_id or user_id is null);
create policy "users read own or global expectancy_statistics"
  on public.expectancy_statistics for select using (auth.uid() = user_id or user_id is null);
create policy "users read own or global trade_authority_decisions"
  on public.trade_authority_decisions for select using (auth.uid() = user_id or user_id is null);
create policy "users read own or global safety_scores"
  on public.safety_scores for select using (auth.uid() = user_id or user_id is null);
create policy "users read own or global setup_alerts"
  on public.setup_alerts for select using (auth.uid() = user_id or user_id is null);
create policy "users read own or global trade_diagnoses"
  on public.trade_diagnoses for select using (auth.uid() = user_id or user_id is null);
create policy "users read own or global counterfactual_results"
  on public.counterfactual_results for select using (auth.uid() = user_id or user_id is null);
create policy "users read own or global filter_rejections"
  on public.filter_rejections for select using (auth.uid() = user_id or user_id is null);
create policy "users read own or global strategy_health"
  on public.strategy_health for select using (auth.uid() = user_id or user_id is null);



-- ── Single global (user_id IS NULL) snapshot per window at the DB level ──────
-- (NULL user_id rows cannot collide in ordinary unique indexes, so partial
-- unique indexes enforce one materialised global set per scope.)
create unique index if not exists strategy_health_global_window_key
  on public.strategy_health ("window") where user_id is null;
create unique index if not exists expectancy_stats_global_key
  on public.expectancy_statistics (segment_key, computed_from, window_days) where user_id is null;
