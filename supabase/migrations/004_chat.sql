-- Rewind Radar Video — 004: visitor chat (messages live 24 h).
-- Paste into the Supabase SQL editor and Run. Safe to run more than once.

-- No network address or visitor id stored: sender_key is the per-tab presence key, login is the GitHub name shown in the chat.
create table if not exists public.chat_messages (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  sender_key text not null check (char_length(sender_key) <= 80),
  login text not null check (char_length(login) <= 39),
  tier text not null check (tier in ('light', 'member')),
  body text not null check (char_length(body) between 1 and 140),
  reports int not null default 0,
  hidden boolean not null default false
);
create index if not exists chat_messages_at_idx on public.chat_messages (at);
alter table public.chat_messages enable row level security;

-- Anyone may read recent, visible messages. No insert/update/delete policies: only the service role (Edge Function) writes.
drop policy if exists "recent chat is public" on public.chat_messages;
create policy "recent chat is public" on public.chat_messages for select
  using (not hidden and at > now() - interval '24 hours');
revoke all on public.chat_messages from public, anon, authenticated;
grant select on public.chat_messages to anon, authenticated;

do $$ begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'chat_messages') then
    alter publication supabase_realtime add table public.chat_messages;
  end if;
end $$;

-- Hourly cleanup of anything older than 24 h. Skipped (not failed) when pg_cron is not installed.
do $$ begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    if exists (select 1 from cron.job where jobname = 'rewind-radar-chat-cleanup') then
      perform cron.unschedule('rewind-radar-chat-cleanup');
    end if;
    perform cron.schedule('rewind-radar-chat-cleanup', '0 * * * *', $job$ delete from public.chat_messages where at < now() - interval '24 hours' $job$);
  else
    raise notice 'pg_cron is not installed: chat cleanup not scheduled';
  end if;
end $$;
