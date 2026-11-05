-- Rewind Radar Video — paste into Supabase SQL editor and Run.
create extension if not exists pgcrypto;

create table if not exists public.tapes (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('skill','repo','community','memory','skene')),
  slug text not null unique,
  title text not null,
  genre text not null default 'Dev Workflow',
  blurb text not null default '',
  body_md text,
  source_url text,
  stars int,
  language text,
  ring text check (ring in ('adopt','trial','assess','hold')),
  rating int check (rating between 1 and 5),
  trust text not null default 'clean' check (trust in ('clean','caution','flagged')),
  submitter text,
  rentals int not null default 0,
  week date not null default (date_trunc('week', now()))::date,
  created_at timestamptz not null default now()
);

create table if not exists public.votes (
  visitor_id text not null check (length(visitor_id) between 8 and 64),
  tape_id uuid not null references public.tapes(id) on delete cascade,
  week date not null default (date_trunc('week', now()))::date,
  created_at timestamptz not null default now(),
  primary key (visitor_id, tape_id, week)
);

create table if not exists public.rentals (
  id bigint generated always as identity primary key,
  tape_id uuid not null references public.tapes(id) on delete cascade,
  visitor_id text not null check (length(visitor_id) between 8 and 64),
  at timestamptz not null default now()
);

create or replace function public.bump_rentals() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  update public.tapes set rentals = rentals + 1 where id = new.tape_id;
  return new;
end $$;
drop trigger if exists rentals_bump on public.rentals;
create trigger rentals_bump after insert on public.rentals
  for each row execute function public.bump_rentals();

create or replace view public.tape_votes with (security_invoker = on) as
  select tape_id, count(*)::int as votes
  from public.votes
  where week = (date_trunc('week', now()))::date
  group by tape_id;

alter table public.tapes   enable row level security;
alter table public.votes   enable row level security;
alter table public.rentals enable row level security;

drop policy if exists "tapes are public"   on public.tapes;
drop policy if exists "votes are public"   on public.votes;
drop policy if exists "anyone can vote"    on public.votes;
drop policy if exists "anyone can rent"    on public.rentals;
create policy "tapes are public" on public.tapes   for select using (true);
create policy "votes are public" on public.votes   for select using (true);
create policy "anyone can vote"  on public.votes   for insert with check (true);
create policy "anyone can rent"  on public.rentals for insert with check (true);

grant select on public.tapes, public.votes, public.tape_votes to anon, authenticated;
grant insert on public.votes, public.rentals to anon, authenticated;

do $$ begin
  begin alter publication supabase_realtime add table public.votes; exception when duplicate_object then null; end;
  begin alter publication supabase_realtime add table public.tapes; exception when duplicate_object then null; end;
end $$;
