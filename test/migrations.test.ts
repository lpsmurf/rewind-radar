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
    expect(sql).toMatch(/grant select on public\.chat_messages to anon, authenticated/);
    expect(sql).not.toMatch(/for (insert|update|delete)/i);
  });
  it('publishes to realtime idempotently and schedules a guarded hourly cleanup', () => {
    expect(sql).toMatch(/pg_publication_tables/);
    expect(sql).toMatch(/rewind-radar-chat-cleanup/);
    expect(sql).toMatch(/cron\.unschedule/);
    expect(sql).toMatch(/pg_extension where extname = 'pg_cron'/);
    expect(sql).toMatch(/'0 \* \* \* \*'/);
  });
});
