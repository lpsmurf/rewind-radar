import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(new URL('../supabase/migrations/006_watch.sql', import.meta.url), 'utf8');
const s005 = readFileSync(new URL('../supabase/migrations/005_sources.sql', import.meta.url), 'utf8');

describe('006_watch.sql', () => {
  it('seeds the watched channel without overwriting the owner\'s edits', () => {
    expect(sql).toMatch(/\('watch', '\{"channels":\[\{"handle":"@TheNextNewThingAI"\}\],"seen":\[\]\}'::jsonb\)\s+on conflict do nothing/);
  });
  it('schedules rewind-radar-watch every 3 hours at minute 17, only when pg_cron exists, replacing any older job', () => {
    expect(sql).toMatch(/exists \(select 1 from pg_extension where extname = 'pg_cron'\)/);
    expect(sql).toMatch(/cron\.unschedule\('rewind-radar-watch'\)/);
    expect(sql).toMatch(/'rewind-radar-watch',\s+'17 \*\/3 \* \* \*'/);
    expect(sql).toMatch(/raise notice 'pg_cron is not installed/);
  });
  it('posts to /sources/watch with the vault secret header, built like 005\'s jobs', () => {
    expect(sql).toContain('functions/v1/api/sources/watch');
    expect(sql).toContain("'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'rewind_cron_secret')");
    expect(s005).toContain("'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'rewind_cron_secret')");
    expect(sql.match(/https:\/\/[a-z]+\.supabase\.co/)![0]).toBe(s005.match(/https:\/\/[a-z]+\.supabase\.co/)![0]);
  });
  it('needs no constraint change: source_runs.source is plain text', () => {
    expect(s005).toMatch(/create table if not exists public\.source_runs \(\s+id bigint generated always as identity primary key,\s+at timestamptz not null default now\(\),\s+source text not null,/);
  });
});
