import { beforeEach, describe, expect, it, vi } from 'vitest';
import { arg, fakeDb, has, usageTable, type Query } from './helpers/fakeDb.ts';
import { toolReply } from './helpers/anthropic.ts';
import { POSTIZ, stubGitHub } from './helpers/github.ts';

const { create, db, reg, batch } = vi.hoisted(() => ({ create: vi.fn(), db: { current: null as any }, reg: { sources: [] as any[] }, batch: { submit: vi.fn(), collect: vi.fn(), order: [] as string[] } }));
vi.mock('../lib/batchAssess.ts', () => ({ submitAssessBatch: batch.submit, collectAssessBatches: batch.collect }));
vi.mock('@anthropic-ai/sdk', () => ({ default: class { messages = { create }; } }));
vi.mock('../lib/admin.ts', () => ({ admin: () => db.current.client }));
vi.mock('../lib/sources/index.ts', () => ({ SOURCES: reg.sources }));

import { handle } from '../lib/routes.ts';

let ips = 0;
const call = async (method: string, path: string, o: { body?: unknown; token?: string | null; ip?: string; headers?: Record<string, string> } = {}) => {
  const headers: Record<string, string> = { 'content-type': 'application/json', 'x-forwarded-for': o.ip ?? `10.9.0.${++ips}`, ...o.headers };
  if (o.token !== null) headers['x-admin-token'] = o.token ?? 'open-sesame';
  const r = await handle(new Request('http://localhost/api/' + path, { method, headers, body: method === 'POST' ? JSON.stringify(o.body ?? {}) : undefined }));
  return { status: r.status, body: (await r.json()) as any };
};

const ROW = { id: 7, source: 'youtube', repo: 'gitroomhq/postiz-app', kind: 'repo', title: 'Postiz', why: 'scheduler', credit_url: 'https://youtu.be/x', credit_title: 'A video', credit_author: 'Ann', status: 'pending' };
const REVIEW = { genre: 'Dev Workflow', blurb: 'Schedules posts.', ring: 'trial', rating: 4 };
const writes = (d: any, table: string, op: string) => d.calls(table).filter((q: Query) => has(q, op)).map((q: Query) => arg(q, op));

function setup(o: { row?: any; spent?: number; tapeInsert?: { code?: string } } = {}) {
  db.current = fakeDb({
    'rpc:ai_spend_today': () => ({ data: o.spent ?? 0, error: null }),
    'rpc:spend_by_day': () => ({ data: [{ day: '2026-11-05', route: 'radar', calls: 3, cost_usd: 0.02 }], error: null }),
    ai_usage: usageTable(),
    ingest_queue: (q: Query) => {
      if (has(q, 'update')) return { data: 'row' in o && !o.row ? null : { id: 7 }, error: null };
      if (has(q, 'upsert')) return { data: [], error: null };
      if (has(q, 'maybeSingle')) return { data: 'row' in o ? o.row : ROW, error: null };
      return { data: [ROW], error: null };
    },
    tapes: (q: Query) => (has(q, 'insert') ? (o.tapeInsert ? { data: null, error: { code: o.tapeInsert.code, message: 'x' } } : { data: { id: 'tape-1' }, error: null }) : { data: [], error: null }),
    source_runs: (q: Query) => (has(q, 'insert') ? { data: null, error: null } : { data: [{ id: 1, source: 'web', found: 2, queued: 1, cost_usd: 0.01, error: null, at: '2026-11-04T09:00:00Z' }], error: null }),
  });
  return db.current;
}

beforeEach(() => {
  create.mockReset();
  create.mockResolvedValue(null);
  reg.sources.length = 0;
  batch.collect.mockReset().mockResolvedValue({ batches: 0, cached: 0, skipped: 0 });
  vi.stubEnv('ADMIN_TOKEN', 'open-sesame');
  vi.stubEnv('CRON_SECRET', 's3cret');
});

describe('admin auth (every /admin route)', () => {
  const routes: [string, string][] = [['GET', 'admin/queue'], ['POST', 'admin/queue/7/approve'], ['POST', 'admin/queue/7/reject'], ['POST', 'admin/paste'], ['GET', 'admin/spend'], ['GET', 'admin/runs']];
  it.each(routes)('%s %s refuses a wrong or missing token, and touches nothing', async (m, p) => {
    const d = setup();
    expect((await call(m, p, { token: 'nope' })).status).toBe(403);
    expect((await call(m, p, { token: null })).status).toBe(403);
    expect(d.queries).toHaveLength(0);
    expect(create).not.toHaveBeenCalled();
  });
  it.each(routes)('%s %s is always forbidden when ADMIN_TOKEN is unset', async (m, p) => {
    vi.stubEnv('ADMIN_TOKEN', '');
    setup();
    expect((await call(m, p, { token: '' })).status).toBe(403);
    expect((await call(m, p, { token: 'undefined' })).status).toBe(403);
  });
  it('allows 60 attempts an hour per IP, wrong tokens included', async () => {
    setup();
    for (let i = 0; i < 60; i++) expect((await call('GET', 'admin/runs', { token: 'wrong', ip: '10.8.0.1' })).status).toBe(403);
    expect((await call('GET', 'admin/runs', { ip: '10.8.0.1' })).status).toBe(429);
    expect((await call('GET', 'admin/runs', { ip: '10.8.0.2' })).status).toBe(200);
  });
});

describe('GET /admin/queue', () => {
  it('lists pending rows by default, newest first', async () => {
    const d = setup();
    const r = await call('GET', 'admin/queue');
    expect(r).toEqual({ status: 200, body: { items: [ROW] } });
    const q = d.calls('ingest_queue')[0];
    expect(q.calls).toContainEqual(['eq', 'status', 'pending']);
    expect(q.calls).toContainEqual(['order', 'at', { ascending: false }]);
  });
  it('filters by ?status= and rejects an unknown one', async () => {
    const d = setup();
    expect((await call('GET', 'admin/queue?status=stocked')).status).toBe(200);
    expect(d.calls('ingest_queue')[0].calls).toContainEqual(['eq', 'status', 'stocked']);
    expect((await call('GET', 'admin/queue?status=bogus')).status).toBe(400);
  });
  it('500s when the database fails', async () => {
    const d = setup();
    d.on('ingest_queue', () => ({ data: null, error: { message: 'down' } }));
    expect((await call('GET', 'admin/queue')).status).toBe(500);
  });
});

describe('POST /admin/queue/:id/approve', () => {
  beforeEach(() => {
    stubGitHub(POSTIZ);
    create.mockResolvedValue(toolReply('review_repo', REVIEW));
  });

  it('stocks a tape with the credit, reviewed by Haiku and metered as "admin", then marks the row stocked', async () => {
    const d = setup();
    const r = await call('POST', 'admin/queue/7/approve');
    expect(r).toEqual({ status: 200, body: { ok: true, slug: 'gh-gitroomhq-postiz-app' } });
    expect(writes(d, 'tapes', 'insert')).toEqual([
      expect.objectContaining({
        kind: 'repo',
        slug: 'gh-gitroomhq-postiz-app',
        title: 'gitroomhq/postiz-app',
        genre: 'Dev Workflow',
        blurb: 'Schedules posts.',
        ring: 'trial',
        rating: 4,
        source_url: 'https://github.com/gitroomhq/postiz-app',
        trust: 'clean',
        archived: false,
        credit_url: 'https://youtu.be/x',
        credit_title: 'A video',
        week: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
        month: expect.stringMatching(/^\d{4}-\d{2}-01$/),
      }),
    ]);
    expect(writes(d, 'ai_usage', 'insert').map((x: any) => x.route)).toEqual(['admin']);
    expect(writes(d, 'ingest_queue', 'update')).toEqual([expect.objectContaining({ status: 'stocked', decided_at: expect.any(String) })]);
  });
  it('snapshots the stars of a stocked repo, and none for one that was already in the store', async () => {
    const d = setup();
    await call('POST', 'admin/queue/7/approve');
    expect(writes(d, 'star_snapshots', 'upsert')).toEqual([[expect.objectContaining({ repo: 'gitroomhq/postiz-app', stars: expect.any(Number), at: new Date().toISOString().slice(0, 10) })]]);
    const d2 = setup({ tapeInsert: { code: '23505' } });
    await call('POST', 'admin/queue/7/approve');
    expect(writes(d2, 'star_snapshots', 'upsert')).toHaveLength(0);
  });
  it('404s an unknown id and 400s a bad one', async () => {
    setup({ row: null });
    expect((await call('POST', 'admin/queue/7/approve')).status).toBe(404);
    expect((await call('POST', 'admin/queue/abc/approve')).status).toBe(400);
  });
  it('409s a row that is already stocked or rejected, without any AI call', async () => {
    setup({ row: { ...ROW, status: 'stocked' } });
    expect((await call('POST', 'admin/queue/7/approve')).status).toBe(409);
    expect(create).not.toHaveBeenCalled();
  });
  it('503s without spending when the daily budget is gone', async () => {
    vi.stubEnv('AI_DAILY_BUDGET_USD', '1');
    const d = setup({ spent: 2 });
    expect((await call('POST', 'admin/queue/7/approve')).status).toBe(503);
    expect(create).not.toHaveBeenCalled();
    expect(writes(d, 'tapes', 'insert')).toHaveLength(0);
  });
  it('404s when the repo has disappeared from GitHub, leaving the row pending', async () => {
    stubGitHub({});
    const d = setup();
    expect((await call('POST', 'admin/queue/7/approve')).status).toBe(404);
    expect(writes(d, 'ingest_queue', 'update')).toHaveLength(0);
  });
  it('409s a tape that already exists and still marks the row stocked', async () => {
    const d = setup({ tapeInsert: { code: '23505' } });
    expect((await call('POST', 'admin/queue/7/approve')).status).toBe(409);
    expect(writes(d, 'ingest_queue', 'update')).toEqual([expect.objectContaining({ status: 'stocked' })]);
  });
  it('500s and leaves the row pending when the review or the insert fails', async () => {
    create.mockRejectedValue(new Error('anthropic down'));
    const d = setup();
    expect((await call('POST', 'admin/queue/7/approve')).status).toBe(500);
    expect(writes(d, 'ingest_queue', 'update')).toHaveLength(0);
    create.mockResolvedValue(toolReply('review_repo', REVIEW));
    const d2 = setup({ tapeInsert: { code: '42P01' } });
    expect((await call('POST', 'admin/queue/7/approve')).status).toBe(500);
    expect(writes(d2, 'ingest_queue', 'update')).toHaveLength(0);
  });
});

describe('POST /admin/queue/:id/reject', () => {
  it('marks the row rejected', async () => {
    const d = setup();
    expect((await call('POST', 'admin/queue/7/reject')).body).toEqual({ ok: true });
    expect(writes(d, 'ingest_queue', 'update')).toEqual([expect.objectContaining({ status: 'rejected', decided_at: expect.any(String) })]);
    expect(d.calls('ingest_queue')[0].calls).toContainEqual(['eq', 'id', 7]);
  });
  it('404s an unknown row and 400s a bad id', async () => {
    setup({ row: null });
    expect((await call('POST', 'admin/queue/7/reject')).status).toBe(404);
    expect((await call('POST', 'admin/queue/0/reject')).status).toBe(400);
  });
});

describe('POST /admin/paste', () => {
  it('queues pasted GitHub links through the manual source, with no AI and no budget check', async () => {
    stubGitHub(POSTIZ);
    const d = setup({ spent: 99 });
    d.on('ingest_queue', (q: Query) => ({ data: has(q, 'upsert') ? [{ id: 1 }] : [], error: null }));
    const r = await call('POST', 'admin/paste', { body: { urls: ['https://github.com/gitroomhq/postiz-app', 'not a link'] } });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, found: 1, queued: 1, ignored: 1 });
    expect(writes(d, 'ingest_queue', 'upsert')[0]).toEqual([expect.objectContaining({ source: 'manual', repo: 'gitroomhq/postiz-app' })]);
    expect(create).not.toHaveBeenCalled();
  });
  it('400s a missing list, a non-string entry and more than 20 links', async () => {
    setup();
    expect((await call('POST', 'admin/paste', { body: {} })).status).toBe(400);
    expect((await call('POST', 'admin/paste', { body: { urls: [] } })).status).toBe(400);
    expect((await call('POST', 'admin/paste', { body: { urls: [5] } })).status).toBe(400);
    expect((await call('POST', 'admin/paste', { body: { urls: Array(21).fill('https://github.com/a/b') } })).status).toBe(400);
  });
  it('reports a failing queue insert as a 500', async () => {
    stubGitHub(POSTIZ);
    const d = setup();
    d.on('ingest_queue', () => ({ data: null, error: { message: 'down' } }));
    const r = await call('POST', 'admin/paste', { body: { urls: ['https://github.com/gitroomhq/postiz-app'] } });
    expect(r.status).toBe(500);
  });
});

describe('GET /admin/spend and /admin/runs', () => {
  it('returns spend per day per route through the RPC, default 14 days', async () => {
    const d = setup();
    const r = await call('GET', 'admin/spend');
    expect(r.body).toEqual({ days: 14, rows: [{ day: '2026-11-05', route: 'radar', calls: 3, cost_usd: 0.02 }] });
    expect(d.calls('rpc:spend_by_day')[0].calls[0][1]).toEqual({ days: 14 });
    await call('GET', 'admin/spend?days=3');
    expect(d.calls('rpc:spend_by_day')[1].calls[0][1]).toEqual({ days: 3 });
  });
  it('clamps days to 1..90 and falls back on junk', async () => {
    const d = setup();
    await call('GET', 'admin/spend?days=500');
    await call('GET', 'admin/spend?days=abc');
    expect(d.calls('rpc:spend_by_day').map((q: Query) => (q.calls[0][1] as any).days)).toEqual([90, 14]);
  });
  it('500s when the spend RPC fails', async () => {
    const d = setup();
    d.on('rpc:spend_by_day', () => ({ data: null, error: { message: 'missing function' } }));
    expect((await call('GET', 'admin/spend')).status).toBe(500);
  });
  it('lists the last 20 source runs', async () => {
    const d = setup();
    const r = await call('GET', 'admin/runs');
    expect(r.body.runs).toHaveLength(1);
    expect(d.calls('source_runs')[0].calls).toContainEqual(['limit', 20]);
  });
  it('500s when the runs read fails', async () => {
    const d = setup();
    d.on('source_runs', () => ({ data: null, error: { message: 'down' } }));
    expect((await call('GET', 'admin/runs')).status).toBe(500);
  });
});

describe('POST /sources/run', () => {
  const run = (secret?: string) => call('POST', 'sources/run', { token: null, headers: secret === undefined ? {} : { 'x-cron-secret': secret } });
  it('403s without the cron secret, with a wrong one, or when CRON_SECRET is unset', async () => {
    const d = setup();
    expect((await run()).status).toBe(403);
    expect((await run('nope')).status).toBe(403);
    vi.stubEnv('CRON_SECRET', '');
    expect((await run('')).status).toBe(403);
    expect(d.queries).toHaveLength(0);
  });
  it('collects pending assessment batches before it runs the sources, and a collect failure does not stop the run', async () => {
    batch.order.length = 0;
    batch.collect.mockReset().mockImplementation(async () => { batch.order.push('collect'); throw new Error('anthropic down'); });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    reg.sources.push({ name: 'web', run: async () => { batch.order.push('source'); return []; } });
    setup();
    expect((await run('s3cret')).status).toBe(200);
    expect(batch.order).toEqual(['collect', 'source']);
  });
  it('runs every registered source and returns the summary', async () => {
    stubGitHub(POSTIZ);
    const d = setup();
    d.on('ingest_queue', (q: Query) => ({ data: has(q, 'upsert') ? [{ id: 1 }] : [], error: null }));
    d.on('source_config', () => ({ data: { value: { queries: ['q'] } }, error: null }));
    reg.sources.push({ name: 'web', run: async (c: any) => [{ repo: 'gitroomhq/postiz-app', kind: 'repo', credit_url: String(((await c.config('web')) as any)?.queries) }] });
    const r = await run('s3cret');
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, queued: 1, sources: [{ name: 'web', found: 1, queued: 1 }] });
    expect(writes(d, 'ingest_queue', 'upsert')[0][0].credit_url).toBe('q'); // ctx.config read source_config
  });
  it('skips sources while the budget is spent', async () => {
    vi.stubEnv('AI_DAILY_BUDGET_USD', '1');
    setup({ spent: 2 });
    const fn = vi.fn(async () => []);
    reg.sources.push({ name: 'web', run: fn });
    const r = await run('s3cret');
    expect(fn).not.toHaveBeenCalled();
    expect(r.body.sources[0]).toMatchObject({ error: 'skipped: budget' });
  });
  it('answers 202 and works on in the background when EdgeRuntime.waitUntil exists', async () => {
    const d = setup();
    const waits: Promise<unknown>[] = [];
    vi.stubGlobal('EdgeRuntime', { waitUntil: (p: Promise<unknown>) => waits.push(p) });
    reg.sources.push({ name: 'web', run: async () => [] });
    expect((await run('s3cret')).status).toBe(202);
    await Promise.all(waits);
    expect(writes(d, 'source_runs', 'insert')).toHaveLength(1);
  });
});
