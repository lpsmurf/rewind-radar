-- Rewind Radar Video — 006: channel watcher. Seeds the watched channel list and schedules the watcher every 3 hours.
-- Paste into the Supabase SQL editor and Run (after 005). Safe to run more than once.
-- source_runs.source is plain text (no CHECK), so the watcher's 'youtube-watch' rows need no constraint change.

-- The watched channels. `seen` holds processed video ids (newest 300); the watcher fills in channel_id and uploads itself.
-- on conflict do nothing: never overwrite the owner's edits.
insert into public.source_config (key, value) values
  ('watch', '{"channels":[{"handle":"@TheNextNewThingAI"}],"seen":[]}'::jsonb)
on conflict do nothing;

-- Every 3 hours at minute 17. Skipped (not failed) when pg_cron is missing. Like the other source jobs, the CRON_SECRET is read from
-- Supabase Vault when the job runs (never stored here): select vault.create_secret('<your CRON_SECRET>', 'rewind_cron_secret');
do $$ begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    if exists (select 1 from cron.job where jobname = 'rewind-radar-watch') then
      perform cron.unschedule('rewind-radar-watch');
    end if;
    perform cron.schedule(
      'rewind-radar-watch',
      '17 */3 * * *',
      $job$
        select net.http_post(
          url := 'https://onovfynfxuemvsrdetez.supabase.co/functions/v1/api/sources/watch',
          headers := jsonb_build_object(
            'content-type', 'application/json',
            'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'rewind_cron_secret')
          ),
          body := '{}'::jsonb
        );
      $job$
    );
  else
    raise notice 'pg_cron is not installed: the watch job is not scheduled';
  end if;
end $$;
