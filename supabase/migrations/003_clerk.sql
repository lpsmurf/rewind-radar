-- Rewind Radar Video — 003: clerk repo assessments, AI spend meter, tape search.
-- Paste into the Supabase SQL editor and Run. Safe to run more than once.

-- Cached repo assessments (server-only).
create table if not exists public.assessments (
  repo text primary key,                 -- lowercased owner/repo
  data jsonb not null,                   -- Assessment
  facts jsonb not null,                  -- RepoSummary
  model text not null,
  prompt_version int not null,
  input_tokens int not null default 0,
  output_tokens int not null default 0,
  cache_read_tokens int not null default 0,
  cache_write_tokens int not null default 0,
  cost_usd numeric(10,6) not null default 0,
  hits int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.assessments enable row level security;

-- Every Anthropic call the API makes (no visitor data).
create table if not exists public.ai_usage (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  route text not null,
  model text not null,
  repo text,
  input_tokens int not null default 0,
  output_tokens int not null default 0,
  cache_read_tokens int not null default 0,
  cache_write_tokens int not null default 0,
  cost_usd numeric(10,6) not null default 0
);
create index if not exists ai_usage_at_idx on public.ai_usage (at);
alter table public.ai_usage enable row level security;
-- no anon/authenticated policies on either table: only the service role (Edge Function) reads/writes them.

create or replace function public.ai_spend_today() returns numeric
language sql stable set search_path = public as $$
  select coalesce(sum(cost_usd), 0) from public.ai_usage
  where at >= (date_trunc('day', now() at time zone 'utc') at time zone 'utc');
$$;
revoke execute on function public.ai_spend_today() from public, anon, authenticated;

-- Full-text search over tapes for the clerk.
alter table public.tapes add column if not exists tsv tsvector
  generated always as (to_tsvector('english',
    coalesce(title, '') || ' ' || coalesce(blurb, '') || ' ' || coalesce(genre, '') || ' ' || replace(coalesce(slug, ''), '-', ' '))) stored;
create index if not exists tapes_tsv_idx on public.tapes using gin (tsv);

-- Clerk candidates: best text matches (match=true) topped up with this week's most-voted and newest repos (match=false).
create or replace function public.search_tapes(q text, n int default 30)
returns table (slug text, title text, genre text, blurb text, kind text, match boolean)
language sql stable set search_path = public as $$
  with query as (
    select replace(plainto_tsquery('english', coalesce(q, ''))::text, ' & ', ' | ')::tsquery as tq
  ), hits as (
    select t.id, ts_rank(t.tsv, query.tq) as score, true as match
    from public.tapes t, query
    where not t.archived and numnode(query.tq) > 0 and t.tsv @@ query.tq
    order by score desc
    limit greatest(1, least(n, 100))
  ), top as (
    select v.tape_id as id, (v.votes::real / 1000) as score, false as match
    from public.tape_votes v order by v.votes desc limit 10
  ), fresh as (
    select t.id, 0::real as score, false as match
    from public.tapes t where not t.archived and t.kind = 'repo'
    order by t.created_at desc limit 10
  ), picked as (
    select distinct on (id) id, score, match
    from (select * from hits union all select * from top union all select * from fresh) u
    order by id, match desc, score desc
  )
  select t.slug, t.title, t.genre, t.blurb, t.kind, p.match
  from picked p join public.tapes t on t.id = p.id
  where not t.archived
  order by p.match desc, p.score desc
  limit greatest(1, least(n, 100)) + 20;
$$;
grant execute on function public.search_tapes(text, int) to anon, authenticated;
