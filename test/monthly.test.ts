import { beforeEach, describe, expect, it, vi } from 'vitest';
import { arg, fakeDb, has, type Query } from './helpers/fakeDb.ts';

const { db } = vi.hoisted(() => ({ db: { current: null as any } }));
vi.mock('../lib/admin.ts', () => ({ admin: () => db.current.client }));

import { buildMonthlyPicks, previousMonth, scorePicks } from '../lib/monthly.ts';
import { handle } from '../lib/routes.ts';

const tape = (slug: string, o: Record<string, unknown> = {}) => ({ id: `id-${slug}`, slug, kind: 'repo', source_url: `https://github.com/${slug.replace('gh-', '').replace('-', '/')}`, ...o });

function setup(o: { tapes?: any[]; votes?: Record<string, number>; snaps?: { repo: string; at: string; stars: number }[]; writeError?: boolean } = {}) {
  db.current = fakeDb({
    tapes: () => ({ data: o.tapes ?? [], error: null }),
    // one row per vote cast; the view tape_votes (current week only) must not be used, so it is a trap here
    votes: () => ({ data: Object.entries(o.votes ?? {}).flatMap(([tape_id, n]) => Array.from({ length: n }, () => ({ tape_id }))), error: null }),
    tape_votes: () => ({ data: [{ tape_id: 'id-gh-ann-tool', votes: 999 }], error: null }),
    star_snapshots: () => ({ data: o.snaps ?? [], error: null }),
    monthly_picks: () => ({ data: null, error: o.writeError ? { message: 'boom' } : null }),
  });
  return db.current;
}
const picksWritten = (d: any) => d.calls('monthly_picks').filter((q: Query) => has(q, 'upsert')).flatMap((q: Query) => arg(q, 'upsert'));

describe('previousMonth', () => {
  it('is the first day of the previous calendar month, UTC', () => {
    expect(previousMonth(new Date('2026-11-01T09:30:00Z'))).toBe('2026-10-01');
    expect(previousMonth(new Date('2026-01-01T00:00:00Z'))).toBe('2025-12-01');
    expect(previousMonth(new Date('2026-03-31T23:59:59Z'))).toBe('2026-02-01');
  });
});

describe('scorePicks', () => {
  const t = (slug: string, votes: number, gained: number) => ({ slug, votes, stars_gained: gained });
  it('scores votes x 3 + stars gained', () => {
    expect(scorePicks([t('a', 2, 10)])[0]).toMatchObject({ rank: 1, tape_slug: 'a', votes: 2, stars_gained: 10, score: 16 });
  });
  it('ranks by score, breaking ties by votes, then slug', () => {
    const out = scorePicks([t('lots-of-stars', 0, 30), t('voted', 10, 0), t('b', 5, 15), t('a', 5, 15)]);
    expect(out.map((p) => [p.tape_slug, p.score])).toEqual([['voted', 30], ['a', 30], ['b', 30], ['lots-of-stars', 30]]);
  });
  it('keeps the top 10 only, ranked from 1', () => {
    const out = scorePicks(Array.from({ length: 14 }, (_, i) => t(`t${i}`, i, 0)));
    expect(out).toHaveLength(10);
    expect(out.map((p) => p.rank)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(out[0].tape_slug).toBe('t13');
  });
});

describe('buildMonthlyPicks', () => {
  it('asks for repo and community tapes stocked in that month, by the month column or created_at', async () => {
    const d = setup();
    await buildMonthlyPicks('2026-10-01');
    const q = d.calls('tapes')[0];
    expect(arg(q, 'in', 1)).toEqual(['repo', 'community']);
    expect(String(arg(q, 'or'))).toContain('month.eq.2026-10-01');
    expect(String(arg(q, 'or'))).toContain('created_at.gte.2026-10-01');
    expect(String(arg(q, 'or'))).toContain('created_at.lt.2026-11-01');
  });
  it('scores votes x 3 plus stars gained between the first and last snapshot of the month', async () => {
    const d = setup({
      tapes: [tape('gh-ann-tool'), tape('gh-bob-lib')],
      votes: { 'id-gh-ann-tool': 2, 'id-gh-bob-lib': 1 },
      snaps: [
        { repo: 'ann/tool', at: '2026-10-20', stars: 150 },
        { repo: 'ann/tool', at: '2026-10-03', stars: 100 },
        { repo: 'ann/tool', at: '2026-10-10', stars: 120 },
        { repo: 'bob/lib', at: '2026-10-05', stars: 500 },
      ],
    });
    const out = await buildMonthlyPicks('2026-10-01');
    expect(out).toEqual([
      { month: '2026-10-01', rank: 1, tape_slug: 'gh-ann-tool', votes: 2, stars_gained: 50, score: 56 },
      { month: '2026-10-01', rank: 2, tape_slug: 'gh-bob-lib', votes: 1, stars_gained: 0, score: 3 },
    ]);
    expect(picksWritten(d)).toEqual(out);
  });
  it('counts votes cast within the month from the votes table, not the current-week view', async () => {
    const d = setup({ tapes: [tape('gh-ann-tool')], votes: { 'id-gh-ann-tool': 3 } });
    const out = await buildMonthlyPicks('2026-10-01');
    expect(out[0].votes).toBe(3);
    expect(d.calls('tape_votes')).toHaveLength(0);
    const q = d.calls('votes')[0];
    expect(has(q, 'gte', 'created_at', '2026-10-01T00:00:00.000Z')).toBe(true);
    expect(has(q, 'lt', 'created_at', '2026-11-01T00:00:00.000Z')).toBe(true);
    expect(arg(q, 'in', 1)).toEqual(['id-gh-ann-tool']);
  });
  it('uses the stocking-time stars as the baseline when the month has fewer than 2 snapshots', async () => {
    setup({
      tapes: [tape('gh-ann-tool', { stars: 100 }), tape('gh-bob-lib', { stars: 40 }), tape('gh-cy-none', { stars: 10 })],
      snaps: [{ repo: 'ann/tool', at: '2026-10-20', stars: 160 }, { repo: 'bob/lib', at: '2026-10-05', stars: 30 }],
    });
    const out = await buildMonthlyPicks('2026-10-01');
    expect(out.map((p) => [p.tape_slug, p.stars_gained])).toEqual([['gh-ann-tool', 60], ['gh-bob-lib', 0], ['gh-cy-none', 0]]); // a loss floors at 0, no snapshot at all gains nothing
  });
  it('still uses first-to-last snapshots when there are 2 or more, whatever the stocking stars were', async () => {
    setup({ tapes: [tape('gh-ann-tool', { stars: 5 })], snaps: [{ repo: 'ann/tool', at: '2026-10-03', stars: 100 }, { repo: 'ann/tool', at: '2026-10-20', stars: 130 }] });
    expect((await buildMonthlyPicks('2026-10-01'))[0].stars_gained).toBe(30);
  });
  it('never scores a loss of stars below zero', async () => {
    setup({ tapes: [tape('gh-ann-tool')], snaps: [{ repo: 'ann/tool', at: '2026-10-01', stars: 90 }, { repo: 'ann/tool', at: '2026-10-09', stars: 80 }] });
    expect((await buildMonthlyPicks('2026-10-01'))[0].stars_gained).toBe(0);
  });
  it('gives a tape without a GitHub source zero stars gained but still ranks its votes', async () => {
    setup({ tapes: [tape('c-x', { kind: 'community', source_url: null })], votes: { 'id-c-x': 4 } });
    expect(await buildMonthlyPicks('2026-10-01')).toEqual([{ month: '2026-10-01', rank: 1, tape_slug: 'c-x', votes: 4, stars_gained: 0, score: 12 }]);
  });
  it('replaces the month idempotently: upsert on (month, rank), then drop ranks past the new count', async () => {
    const d = setup({ tapes: [tape('gh-ann-tool')] });
    await buildMonthlyPicks('2026-10-01');
    await buildMonthlyPicks('2026-10-01');
    const writes = d.calls('monthly_picks');
    expect(writes.filter((q: Query) => has(q, 'upsert'))).toHaveLength(2);
    expect(arg(writes[0], 'upsert', 1)).toEqual({ onConflict: 'month,rank' });
    const del = writes.filter((q: Query) => has(q, 'delete'));
    expect(del).toHaveLength(2);
    expect(has(del[0], 'eq', 'month', '2026-10-01')).toBe(true);
    expect(has(del[0], 'gt', 'rank', 1)).toBe(true);
    expect(picksWritten(d)[0]).toEqual(picksWritten(d)[1]);
  });
  it('clears the month when nothing was stocked in it', async () => {
    const d = setup();
    expect(await buildMonthlyPicks('2026-10-01')).toEqual([]);
    const writes = d.calls('monthly_picks');
    expect(writes.some((q: Query) => has(q, 'upsert'))).toBe(false);
    expect(has(writes[0], 'delete')).toBe(true);
    expect(has(writes[0], 'gt', 'rank', 0)).toBe(true); // every rank of the month goes
  });
  it('throws, rather than reporting success, when the write fails', async () => {
    setup({ tapes: [tape('gh-ann-tool')], writeError: true });
    await expect(buildMonthlyPicks('2026-10-01')).rejects.toThrow('boom');
  });
});

describe('POST sources/monthly', () => {
  const post = async (secret?: string) => {
    const r = await handle(new Request('http://localhost/api/sources/monthly', { method: 'POST', headers: secret === undefined ? {} : { 'x-cron-secret': secret } }));
    return { status: r.status, body: (await r.json()) as any };
  };
  beforeEach(() => vi.stubEnv('CRON_SECRET', 's3cret'));

  it('refuses a missing or wrong secret, and touches nothing', async () => {
    const d = setup();
    expect((await post()).status).toBe(403);
    expect((await post('nope')).status).toBe(403);
    expect(d.queries).toHaveLength(0);
  });
  it('is always forbidden when CRON_SECRET is unset', async () => {
    vi.stubEnv('CRON_SECRET', '');
    const d = setup();
    expect((await post('')).status).toBe(403);
    expect(d.queries).toHaveLength(0);
  });
  it('builds the previous calendar month', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-01T09:30:00Z'));
    try {
      const d = setup({ tapes: [tape('gh-ann-tool')] });
      expect(await post('s3cret')).toEqual({ status: 200, body: { ok: true, month: '2026-10-01', picked: 1 } });
      expect(picksWritten(d)[0].month).toBe('2026-10-01');
    } finally {
      vi.useRealTimers();
    }
  });
  it('500s when the build fails', async () => {
    setup({ tapes: [tape('gh-ann-tool')], writeError: true });
    expect((await post('s3cret')).status).toBe(500);
  });
});
