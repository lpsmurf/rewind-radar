import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(new URL('../supabase/migrations/004_chat.sql', import.meta.url), 'utf8');

describe('004_chat.sql', () => {
  it('creates the table with length limits and no visitor identity columns', () => {
    expect(sql).toMatch(/create table if not exists public\.chat_messages/);
    expect(sql).toMatch(/char_length\(sender_key\) <= 80/);
    expect(sql).toMatch(/char_length\(body\) between 1 and 140/);
    expect(sql).not.toMatch(/\bip\b|visitor_id/i);
  });
  it('only stores light or member tiers and logins up to 39 characters', () => {
    expect(sql).toMatch(/tier in \('light', 'member'\)/);
    expect(sql).toMatch(/char_length\(login\) <= 39/);
  });
  it('turns RLS on and only lets anon read recent visible rows', () => {
    expect(sql).toMatch(/alter table public\.chat_messages enable row level security/);
    expect(sql).toMatch(/using \(not hidden and at > now\(\) - interval '24 hours'\)/);
    expect(sql).toMatch(/revoke all on public\.chat_messages from public, anon, authenticated/);
    expect(sql).toMatch(/grant select \(id, at, sender_key, login, tier, body, hidden\) on public\.chat_messages to anon, authenticated/); // never sender_id
    expect(sql).not.toMatch(/create policy[^;]*for (insert|update|delete)/i); // the row lock "for update" in report_chat is not a policy
  });
  it('publishes to realtime idempotently and schedules a guarded hourly cleanup', () => {
    expect(sql).toMatch(/pg_publication_tables/);
    expect(sql).toMatch(/rewind-radar-chat-cleanup/);
    expect(sql).toMatch(/cron\.unschedule/);
    expect(sql).toMatch(/pg_extension where extname = 'pg_cron'/);
    expect(sql).toMatch(/'0 \* \* \* \*'/);
  });

  it('keeps one report per reporter and a report_chat function only service_role may run', () => {
    expect(sql).toMatch(/create table if not exists public\.chat_reports/);
    expect(sql).toMatch(/primary key \(message_id, reporter\)/);
    expect(sql).toMatch(/references public\.chat_messages\(id\) on delete cascade/);
    expect(sql).toMatch(/alter table public\.chat_reports enable row level security/);
    expect(sql).toMatch(/revoke all on public\.chat_reports from public, anon, authenticated/);
    expect(sql).toMatch(/function public\.report_chat\(p_id bigint, p_reporter text\) returns boolean/);
    expect(sql).toMatch(/security definer/);
    expect(sql).toMatch(/on conflict do nothing/);
    expect(sql).toMatch(/for update/); // serialises concurrent reports so the third one always sees the count
    expect(sql).toMatch(/sender_id = p_reporter/); // no reporting your own message
    expect(sql).toMatch(/>= 3 then\s+delete from public\.chat_messages/);
    expect(sql).toMatch(/revoke execute on function public\.report_chat\(bigint, text\) from public, anon, authenticated/);
    expect(sql).toMatch(/grant execute on function public\.report_chat\(bigint, text\) to service_role/);
  });
  it('sums chat spend for the day in a function only service_role may run', () => {
    expect(sql).toMatch(/function public\.chat_spend_today\(\) returns numeric/);
    expect(sql).toMatch(/route = 'chat'/);
    expect(sql).toMatch(/revoke execute on function public\.chat_spend_today\(\) from public, anon, authenticated/);
    expect(sql).toMatch(/grant execute on function public\.chat_spend_today\(\) to service_role/);
  });
});
