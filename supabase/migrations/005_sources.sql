-- Rewind Radar Video — 005: source pipeline (Phase 3): ingest queue, source config and runs, star snapshots, monthly picks.
-- Paste into the Supabase SQL editor and Run. Safe to run more than once. Server-only tables: only the service role
-- (Edge Function) reads or writes them; the one exception is monthly_picks, which the shelf reads.

-- Tape columns the pipeline needs (week already exists since 001; kept here so this file stands alone).
alter table public.tapes add column if not exists week date;
alter table public.tapes add column if not exists month date;
alter table public.tapes add column if not exists credit_url text;
alter table public.tapes add column if not exists credit_title text;

-- Candidates found by a source, waiting for one-click approval. repo is always lowercased owner/repo.
-- credit_url is '' (not null) when there is none, so the unique key also dedupes credit-less rows.
create table if not exists public.ingest_queue (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  source text not null check (source in ('github', 'youtube', 'web', 'manual')),
  repo text not null check (repo = lower(repo) and char_length(repo) <= 140),
  kind text not null default 'repo' check (kind in ('repo', 'skill')),
  title text not null default '' check (char_length(title) <= 140),
  why text not null default '' check (char_length(why) <= 300),
  credit_url text not null default '' check (char_length(credit_url) <= 500),
  credit_title text not null default '' check (char_length(credit_title) <= 200),
  credit_author text not null default '' check (char_length(credit_author) <= 120),
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'stocked')),
  facts jsonb,
  decided_at timestamptz,
  unique (repo, source, credit_url)
);
create index if not exists ingest_queue_status_idx on public.ingest_queue (status, at desc);
comment on table public.ingest_queue is 'Repos and skills found by the source pipeline, waiting for admin approval. Server-only.';

-- Settings per source, editable without a deploy: queries, channels.
create table if not exists public.source_config (
  key text primary key,
  value jsonb not null default '{}'::jsonb
);
comment on table public.source_config is 'Per-source settings (YouTube queries and channels, the weekly web-search query). Server-only.';
insert into public.source_config (key, value) values
  ('youtube', '{"queries": ["claude code skills", "claude code mcp", "best github repos ai agents"], "channels": []}'::jsonb),
  ('web', '{"query": "best Claude Code skills and GitHub repos this week"}'::jsonb)
on conflict do nothing;

-- One row per source per pipeline run.
create table if not exists public.source_runs (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  source text not null,
  found int not null default 0,
  queued int not null default 0,
  cost_usd numeric(10,6) not null default 0,
  error text
);
create index if not exists source_runs_at_idx on public.source_runs (at desc);
comment on table public.source_runs is 'Audit log of source pipeline runs: candidates found, rows queued, spend, error. Server-only.';

-- Daily star counts, so the monthly shelf can rank by stars gained.
create table if not exists public.star_snapshots (
  repo text not null,
  at date not null default (now() at time zone 'utc')::date,
  stars int not null,
  primary key (repo, at)
);
comment on table public.star_snapshots is 'One star count per repo per day, for "stars gained" in the monthly picks. Server-only.';

-- The month's winners, built on the 1st from the weekly tapes. Public: the Monthly Picks shelf renders from it.
create table if not exists public.monthly_picks (
  month date not null,
  rank int not null check (rank >= 1),
  tape_slug text not null,
  votes int not null default 0,
  stars_gained int not null default 0,
  score numeric not null default 0,
  primary key (month, rank)
);
comment on table public.monthly_picks is 'Monthly Picks shelf: top tapes of a month ranked by votes plus stars gained. Public read.';

-- Anthropic Message Batches submitted for pre-assessment of newly stocked repos.
create table if not exists public.assess_batches (
  id text primary key,
  at timestamptz not null default now(),
  status text not null default 'submitted',
  repos text[] not null default '{}',
  collected_at timestamptz
);
comment on table public.assess_batches is 'Message Batches submitted to pre-assess new repos; collected_at is set once results are cached. Server-only.';

-- Row level security everywhere; only monthly_picks may be read by visitors.
alter table public.ingest_queue   enable row level security;
alter table public.source_config  enable row level security;
alter table public.source_runs    enable row level security;
alter table public.star_snapshots enable row level security;
alter table public.monthly_picks  enable row level security;
alter table public.assess_batches enable row level security;
revoke all on public.ingest_queue   from public, anon, authenticated;
revoke all on public.source_config  from public, anon, authenticated;
revoke all on public.source_runs    from public, anon, authenticated;
revoke all on public.star_snapshots from public, anon, authenticated;
revoke all on public.monthly_picks  from public, anon, authenticated;
revoke all on public.assess_batches from public, anon, authenticated;
drop policy if exists "monthly picks are public" on public.monthly_picks;
create policy "monthly picks are public" on public.monthly_picks for select using (true);
grant select on public.monthly_picks to anon, authenticated;

-- Spend per day per route for the admin panel (a function, because PostgREST caps a plain select at 1000 rows).
create or replace function public.spend_by_day(days int) returns table (day date, route text, calls bigint, cost_usd numeric)
language sql stable set search_path = public as $$
  select (at at time zone 'utc')::date, route, count(*), coalesce(sum(cost_usd), 0)
  from public.ai_usage
  where at >= now() - make_interval(days => greatest(days, 1))
  group by 1, 2
  order by 1 desc, 2;
$$;
revoke execute on function public.spend_by_day(int) from public, anon, authenticated;
grant execute on function public.spend_by_day(int) to service_role;

-- Weekly sources (Tuesday 09:00 UTC) and the monthly shelf (1st, 09:30 UTC). Skipped (not failed) when pg_cron is missing.
-- Unlike radar/refresh, these routes require the CRON_SECRET header. The secret is read from Supabase Vault when the job
-- runs (never stored here): select vault.create_secret('<your CRON_SECRET>', 'rewind_cron_secret');
do $$ begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    if exists (select 1 from cron.job where jobname = 'rewind-radar-sources') then
      perform cron.unschedule('rewind-radar-sources');
    end if;
    perform cron.schedule(
      'rewind-radar-sources',
      '0 9 * * 2',
      $job$
        select net.http_post(
          url := 'https://onovfynfxuemvsrdetez.supabase.co/functions/v1/api/sources/run',
          headers := jsonb_build_object(
            'content-type', 'application/json',
            'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'rewind_cron_secret')
          ),
          body := '{}'::jsonb
        );
      $job$
    );
    if exists (select 1 from cron.job where jobname = 'rewind-radar-monthly') then
      perform cron.unschedule('rewind-radar-monthly');
    end if;
    perform cron.schedule(
      'rewind-radar-monthly',
      '30 9 1 * *',
      $job$
        select net.http_post(
          url := 'https://onovfynfxuemvsrdetez.supabase.co/functions/v1/api/sources/monthly',
          headers := jsonb_build_object(
            'content-type', 'application/json',
            'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'rewind_cron_secret')
          ),
          body := '{}'::jsonb
        );
      $job$
    );
  else
    raise notice 'pg_cron is not installed: sources and monthly jobs not scheduled';
  end if;
end $$;
