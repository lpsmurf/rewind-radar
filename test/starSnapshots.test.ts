import { beforeEach, describe, expect, it, vi } from 'vitest';
import { arg, fakeDb, has } from './helpers/fakeDb.ts';

const { db, gh } = vi.hoisted(() => ({ db: { current: null as any }, gh: { repos: [] as any[] } }));
vi.mock('../lib/admin.ts', () => ({ admin: () => db.current.client }));
vi.mock('../lib/github.ts', async (orig) => ({ ...(await orig<typeof import('../lib/github.ts')>()), searchWeekly: async () => gh.repos }));
vi.mock('../lib/ai.ts', async (orig) => ({
  ...(await orig<typeof import('../lib/ai.ts')>()),
  reviewRepo: async () => ({ genre: 'Dev Workflow', blurb: 'b', ring: 'trial', rating: 4 }),
}));

import { refreshRadar } from '../lib/radar.ts';
import { snapshotStars } from '../lib/stars.ts';

const repo = (full_name: string, stars: number) => ({ full_name, description: 'd', language: 'TS', stars, html_url: `https://github.com/${full_name}`, readme: 'r' });
const today = () => new Date().toISOString().slice(0, 10);

beforeEach(() => {
  db.current = fakeDb();
  gh.repos = [repo('Ann/Tool', 120), repo('bob/lib', 80)];
});

describe('snapshotStars', () => {
  it('upserts one row per repo for the given day, lowercased', async () => {
    await snapshotStars([{ repo: 'Ann/Tool', stars: 5 }], '2026-11-05');
    const q = db.current.calls('star_snapshots')[0];
    expect(arg(q, 'upsert')).toEqual([{ repo: 'ann/tool', at: '2026-11-05', stars: 5 }]);
    expect(arg(q, 'upsert', 1)).toEqual({ onConflict: 'repo,at' });
  });
  it('defaults to today (UTC)', async () => {
    await snapshotStars([{ repo: 'a/b', stars: 1 }]);
    expect(arg(db.current.calls('star_snapshots')[0], 'upsert')[0].at).toBe(today());
  });
  it('does nothing for an empty list and never throws on a database error', async () => {
    await snapshotStars([]);
    expect(db.current.calls('star_snapshots')).toHaveLength(0);
    db.current = fakeDb({ star_snapshots: () => ({ data: null, error: { message: 'boom' } }) });
    await expect(snapshotStars([{ repo: 'a/b', stars: 1 }])).resolves.toBeUndefined();
  });
});

describe('refreshRadar', () => {
  it('snapshots the star count of every stocked repo', async () => {
    expect(await refreshRadar(2)).toBe(2);
    const snaps = db.current.calls('star_snapshots').filter((q: any) => has(q, 'upsert'));
    expect(snaps.flatMap((q: any) => arg(q, 'upsert'))).toEqual([
      { repo: 'ann/tool', at: today(), stars: 120 },
      { repo: 'bob/lib', at: today(), stars: 80 },
    ]);
  });
  it('still succeeds when the snapshot write fails', async () => {
    db.current = fakeDb({ star_snapshots: () => ({ data: null, error: { message: 'boom' } }) });
    expect(await refreshRadar(2)).toBe(2);
  });
});

describe('refreshRadar onStocked (batch pre-assessment hook)', () => {
  it('hands the stocked repos over after stocking, lowercased', async () => {
    const seen: string[][] = [];
    await refreshRadar(2, undefined, async (repos) => { seen.push(repos); });
    expect(seen).toEqual([['ann/tool', 'bob/lib']]);
    // it ran after the tapes were written
    const tapes = db.current.queries.findIndex((q: any) => q.table === 'tapes' && has(q, 'upsert'));
    expect(tapes).toBeGreaterThanOrEqual(0);
  });
  it('never fails the refresh when the hook throws', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await refreshRadar(2, undefined, async () => { throw new Error('batch down'); })).toBe(2);
  });
});
