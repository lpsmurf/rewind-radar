import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(new URL('../supabase/migrations/005_sources.sql', import.meta.url), 'utf8');
const TABLES = ['ingest_queue', 'source_config', 'source_runs', 'star_snapshots', 'monthly_picks', 'assess_batches', 'admin_failures'];

describe('005_sources.sql', () => {
  it('creates every Phase 3 table idempotently, with RLS on, a comment, and nothing for public', () => {
    for (const t of TABLES) {
      expect(sql).toMatch(new RegExp(`create table if not exists public\\.${t} \\(`));
      expect(sql).toMatch(new RegExp(`alter table public\\.${t}\\s+enable row level security`));
      expect(sql).toMatch(new RegExp(`comment on table public\\.${t} is`));
      expect(sql).toMatch(new RegExp(`revoke all on public\\.${t}\\s+from public, anon, authenticated`));
    }
  });
  it('queues candidates once per repo, source and credit link', () => {
    expect(sql).toMatch(/source text not null check \(source in \('github', 'youtube', 'web', 'manual'\)\)/);
    expect(sql).toMatch(/status text not null default 'pending' check \(status in \('pending', 'approving', 'approved', 'rejected', 'stocked'\)\)/);
    expect(sql).toMatch(/unique \(repo, source, credit_url\)/);
  });
  it('only monthly_picks is readable by anon', () => {
    expect(sql.match(/grant select on [^;]* to anon/g)).toEqual(['grant select on public.monthly_picks to anon']);
    expect(sql.match(/create policy/g)).toHaveLength(1);
    expect(sql).toMatch(/primary key \(month, rank\)/);
  });
  it('seeds source_config without overwriting the owner\'s edits', () => {
    expect(sql).toMatch(/'youtube'[\s\S]*claude code skills[\s\S]*on conflict do nothing/);
    expect(sql).toMatch(/'web'/);
  });
  it('adds tape columns and the service-role-only spend function', () => {
    for (const c of ['week date', 'month date', 'credit_url text', 'credit_title text']) expect(sql).toMatch(new RegExp(`add column if not exists ${c}`));
    expect(sql).toMatch(/create or replace function public\.spend_by_day\(days int\)/);
    expect(sql).toMatch(/revoke execute on function public\.spend_by_day\(int\) from public, anon, authenticated/);
    expect(sql).toMatch(/grant execute on function public\.spend_by_day\(int\) to service_role/);
  });
  it('schedules both crons behind a pg_cron guard, unscheduling first', () => {
    expect(sql).toMatch(/pg_extension where extname = 'pg_cron'/);
    expect(sql).toMatch(/rewind-radar-sources[\s\S]*'0 9 \* \* 2'[\s\S]*\/functions\/v1\/api\/sources\/run/);
    expect(sql).toMatch(/rewind-radar-monthly[\s\S]*'30 9 1 \* \*'[\s\S]*\/functions\/v1\/api\/sources\/monthly/);
    expect(sql).toMatch(/x-cron-secret/);
    expect(sql.match(/cron\.unschedule/g)!.length).toBeGreaterThanOrEqual(2);
  });
});
