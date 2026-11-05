-- Rewind Radar Video — 002: twice-weekly radar refresh + visitor proposals.
-- Paste into the Supabase SQL editor and Run. Safe to run more than once.
create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Retired New Releases stay in the DB (votes kept) but leave the wall.
alter table public.tapes add column if not exists archived boolean not null default false;

-- One row per radar refresh; the API refuses to re-run within 60 hours.
create table if not exists public.radar_runs (
  id bigint generated always as identity primary key,
  ran_at timestamptz not null default now(),
  stocked int not null default 0
);
alter table public.radar_runs enable row level security;
drop policy if exists "radar runs are public" on public.radar_runs;
create policy "radar runs are public" on public.radar_runs for select using (true);
grant select on public.radar_runs to anon, authenticated;

-- Request Box: ideas / skills / repos proposed by visitors (inserted by the API after a Claude spam check).
create table if not exists public.proposals (
  id uuid primary key default gen_random_uuid(),
  visitor_id text not null check (length(visitor_id) between 8 and 64),
  kind text not null default 'idea' check (kind in ('idea', 'skill', 'repo')),
  title text not null check (length(title) between 3 and 80),
  pitch text not null default '' check (length(pitch) <= 400),
  link text,
  submitter text,
  genre text,
  votes int not null default 0,
  created_at timestamptz not null default now()
);
create table if not exists public.proposal_votes (
  visitor_id text not null check (length(visitor_id) between 8 and 64),
  proposal_id uuid not null references public.proposals(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (visitor_id, proposal_id)
);
create or replace function public.bump_proposal_votes() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  update public.proposals set votes = votes + 1 where id = new.proposal_id;
  return new;
end $$;
drop trigger if exists proposal_votes_bump on public.proposal_votes;
create trigger proposal_votes_bump after insert on public.proposal_votes
  for each row execute function public.bump_proposal_votes();

alter table public.proposals      enable row level security;
alter table public.proposal_votes enable row level security;
drop policy if exists "proposals are public"        on public.proposals;
drop policy if exists "proposal votes are public"   on public.proposal_votes;
drop policy if exists "anyone can back a proposal"  on public.proposal_votes;
create policy "proposals are public"       on public.proposals      for select using (true);
create policy "proposal votes are public"  on public.proposal_votes for select using (true);
create policy "anyone can back a proposal" on public.proposal_votes for insert with check (true);
grant select on public.proposals, public.proposal_votes to anon, authenticated;
grant insert on public.proposal_votes to anon, authenticated;

do $$ begin
  begin alter publication supabase_realtime add table public.proposals; exception when duplicate_object then null; end;
end $$;

-- Twice a week: Monday and Thursday 09:00 UTC.
do $$ begin
  if exists (select 1 from cron.job where jobname = 'rewind-radar-refresh') then
    perform cron.unschedule('rewind-radar-refresh');
  end if;
end $$;
select cron.schedule(
  'rewind-radar-refresh',
  '0 9 * * 1,4',
  $job$
    select net.http_post(
      url := 'https://onovfynfxuemvsrdetez.supabase.co/functions/v1/api/radar/refresh',
      headers := '{"content-type": "application/json"}'::jsonb,
      body := '{}'::jsonb
    );
  $job$
);
