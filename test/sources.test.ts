import { beforeEach, describe, expect, it, vi } from 'vitest';
import { arg, fakeDb, has, usageTable, type Query } from './helpers/fakeDb.ts';
import { POSTIZ, stubGitHub } from './helpers/github.ts';

const { db } = vi.hoisted(() => ({ db: { current: null as any } }));
vi.mock('../lib/admin.ts', () => ({ admin: () => db.current.client }));

import { verifyCandidate, verifyAll } from '../lib/sources/verify.ts';
import { runSources, manualSource } from '../lib/sources/pipeline.ts';
import { SOURCES } from '../lib/sources/index.ts';
import type { Source, SourceCtx } from '../lib/sources/types.ts';
import { HAIKU } from '../lib/ai.ts';

// GitHub answers any letter case; the stub is keyed by path, so list the cases the tests use.
const MIXED = {
  '/repos/GitRoomHQ/Postiz-App': POSTIZ['/repos/gitroomhq/postiz-app'],
  '/repos/GitRoomHQ/Postiz-App/readme': POSTIZ['/repos/gitroomhq/postiz-app/readme'],
  '/repos/GitRoomHQ/Postiz-App/contents': POSTIZ['/repos/gitroomhq/postiz-app/contents'],
};
const POSTIZ_C = { repo: 'gitroomhq/postiz-app', kind: 'repo' as const, credit_url: 'https://youtu.be/x', credit_title: 'A video', credit_author: 'Ann' };

describe('verifyCandidate', () => {
  it('returns the facts with the canonical owner/repo case', async () => {
    stubGitHub(MIXED);
    const f = await verifyCandidate({ repo: 'GitRoomHQ/Postiz-App', kind: 'repo' });
    expect(f?.full_name).toBe('gitroomhq/postiz-app');
  });
  it('accepts a github.com URL', async () => {
    stubGitHub(POSTIZ);
    expect((await verifyCandidate({ repo: 'https://github.com/gitroomhq/postiz-app', kind: 'repo' }))?.stars).toBeGreaterThan(0);
  });
  it('returns null for a repo GitHub does not know and for text that is no repo, without inventing one', async () => {
    const seen = stubGitHub({});
    expect(await verifyCandidate({ repo: 'nobody/invented-thing', kind: 'repo' })).toBeNull();
    expect(await verifyCandidate({ repo: 'a great skill', kind: 'skill' })).toBeNull();
    expect(seen.every((s) => s.url.includes('nobody/invented-thing'))).toBe(true);
  });
  it('verifyAll runs at most N lookups at once and keeps order', async () => {
    let live = 0;
    let peak = 0;
    vi.stubGlobal('fetch', async (u: unknown) => {
      live++;
      peak = Math.max(peak, live);
      await new Promise((r) => setTimeout(r, 5));
      live--;
      const url = String(u);
      if (!/\/repos\/o\/r\d+$/.test(url)) return new Response('', { status: url.includes('/repos/o/') ? 200 : 404 });
      return new Response(JSON.stringify({ full_name: url.split('/repos/')[1], html_url: url, stargazers_count: 1 }));
    });
    const cands = Array.from({ length: 10 }, (_, i) => ({ repo: `o/r${i}`, kind: 'repo' as const }));
    const out = await verifyAll(cands, 3);
    expect(peak).toBeLessThanOrEqual(3 * 3); // each lookup makes 3 parallel GitHub calls
    expect(out.map((f) => f?.full_name)).toEqual(cands.map((c) => c.repo));
  });
});

// ---------- pipeline ----------
const ctx = (o: Partial<SourceCtx> = {}): Omit<SourceCtx, 'onUsage'> => ({
  budget: async () => true,
  config: async () => null,
  now: new Date('2026-11-10T09:00:00Z'),
  ...o,
});
const fake = (name: string, run: Source['run']): Source => ({ name, run });
const inserted = (d: any) => d.calls('ingest_queue').filter((q: Query) => has(q, 'upsert')).flatMap((q: Query) => arg(q, 'upsert'));
const runRows = (d: any) => d.calls('source_runs').filter((q: Query) => has(q, 'insert')).map((q: Query) => arg(q, 'insert'));

function setup(live: string[] = []) {
  db.current = fakeDb({
    tapes: () => ({ data: live.map((slug) => ({ slug })), error: null }),
    ingest_queue: (q: Query) => ({ data: has(q, 'upsert') ? arg(q, 'upsert').map((_: unknown, i: number) => ({ id: i + 1 })) : [], error: null }),
    source_runs: () => ({ data: null, error: null }),
    ai_usage: usageTable(),
  });
  return db.current;
}

describe('runSources', () => {
  beforeEach(() => stubGitHub(POSTIZ));

  it('queues a verified candidate as a pending row', async () => {
    stubGitHub({ ...POSTIZ, ...MIXED });
    const d = setup();
    const s = await runSources([fake('youtube', async () => [{ ...POSTIZ_C, repo: 'GitRoomHQ/Postiz-App', title: 'Postiz', why: 'scheduler' }])], ctx());
    expect(s).toMatchObject({ queued: 1, sources: [{ name: 'youtube', found: 1, queued: 1, cost_usd: 0 }] });
    expect(inserted(d)).toEqual([
      expect.objectContaining({
        source: 'youtube',
        repo: 'gitroomhq/postiz-app',
        kind: 'repo',
        title: 'Postiz',
        why: 'scheduler',
        credit_url: 'https://youtu.be/x',
        credit_title: 'A video',
        credit_author: 'Ann',
        facts: expect.objectContaining({ full_name: 'gitroomhq/postiz-app', license: 'AGPL-3.0' }),
      }),
    ]);
    expect(inserted(d)[0].status).toBeUndefined(); // the column default (pending) applies
    expect(inserted(d)[0].facts.readme).toBeUndefined(); // facts stay small
    const q = d.calls('ingest_queue').find((q: Query) => has(q, 'upsert'))!;
    expect(arg(q, 'upsert', 1)).toEqual({ onConflict: 'repo,source,credit_url', ignoreDuplicates: true });
    expect(runRows(d)).toEqual([expect.objectContaining({ source: 'youtube', found: 1, queued: 1, cost_usd: 0, error: null })]);
  });

  it('drops invented repos, live tapes and duplicates inside one batch', async () => {
    const d = setup(['gh-gitroomhq-postiz-app']);
    const s = await runSources(
      [fake('web', async () => [POSTIZ_C, { repo: 'ghost/not-real', kind: 'repo' }, POSTIZ_C])],
      ctx(),
    );
    expect(s.sources[0]).toMatchObject({ found: 3, queued: 0 });
    expect(inserted(d)).toHaveLength(0);
    expect(d.calls('tapes')[0].calls).toContainEqual(['in', 'slug', ['gh-gitroomhq-postiz-app', 'c-gitroomhq-postiz-app']]);
  });

  it('collapses an identical candidate listed twice', async () => {
    const d = setup();
    await runSources([fake('web', async () => [POSTIZ_C, POSTIZ_C])], ctx());
    expect(inserted(d)).toHaveLength(1);
  });

  it('keeps going when one source fails, and logs its error', async () => {
    const d = setup();
    const boom = fake('youtube', async () => { throw new Error('quota exceeded'); });
    const ok = fake('web', async () => [POSTIZ_C]);
    const s = await runSources([boom, ok], ctx());
    expect(s.sources.map((x) => [x.name, x.queued, x.error])).toEqual([['youtube', 0, 'quota exceeded'], ['web', 1, undefined]]);
    expect(runRows(d).map((r: any) => [r.source, r.error])).toEqual([['youtube', 'quota exceeded'], ['web', null]]);
  });

  it('skips a source when the budget is spent, without running it', async () => {
    const d = setup();
    const run = vi.fn(async () => [POSTIZ_C]);
    const s = await runSources([fake('web', run)], ctx({ budget: async () => false }));
    expect(run).not.toHaveBeenCalled();
    expect(s.sources[0]).toMatchObject({ name: 'web', found: 0, queued: 0, error: 'skipped: budget' });
    expect(runRows(d)[0].error).toBe('skipped: budget');
  });

  it('meters each source under route source:<name> and logs its cost', async () => {
    const d = setup();
    const usage = { input_tokens: 10_000, output_tokens: 1_000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, server_tool_use: null } as any;
    const s = await runSources([fake('web', async (c) => { c.onUsage(HAIKU, usage); return []; })], ctx());
    const rows = d.calls('ai_usage').filter((q: Query) => has(q, 'insert')).map((q: Query) => arg(q, 'insert'));
    expect(rows).toEqual([expect.objectContaining({ route: 'source:web', model: HAIKU })]);
    expect(s.sources[0].cost_usd).toBeCloseTo(0.0015, 6);
    expect(runRows(d)[0].cost_usd).toBeCloseTo(0.0015, 6);
  });

  it('still meters usage when the source then fails', async () => {
    const d = setup();
    const usage = { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } as any;
    await runSources([fake('web', async (c) => { c.onUsage(HAIKU, usage); throw new Error('later'); })], ctx());
    expect(d.calls('ai_usage').some((q: Query) => has(q, 'insert'))).toBe(true);
  });

  it('survives a failing queue insert: error logged, nothing queued', async () => {
    const d = setup();
    d.on('ingest_queue', () => ({ data: null, error: { message: 'db down' } }));
    const s = await runSources([fake('web', async () => [POSTIZ_C])], ctx());
    expect(s.sources[0]).toMatchObject({ found: 1, queued: 0, error: 'db down' });
  });
});

describe('manualSource and the registry', () => {
  it('turns pasted GitHub links into manual candidates and ignores the rest', async () => {
    const src = manualSource(['https://github.com/GitRoomHQ/Postiz-App', 'https://example.com/x', 'junk']);
    expect(src.name).toBe('manual');
    const out = await src.run({ ...ctx(), onUsage: () => {} });
    expect(out).toEqual([{ repo: 'GitRoomHQ/Postiz-App', kind: 'repo' }]);
  });
  it('exports the list that later slices register into', () => {
    expect(Array.isArray(SOURCES)).toBe(true);
  });
});
