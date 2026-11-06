import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { arg, fakeDb, has, usageTable, type Query } from './helpers/fakeDb.ts';
import { toolReply } from './helpers/anthropic.ts';
import { POSTIZ, repoRoutes, stubGitHub } from './helpers/github.ts';

const { create, db, reg, batch } = vi.hoisted(() => ({ create: vi.fn(), db: { current: null as any }, reg: { sources: [] as any[] }, batch: { submit: vi.fn(), collect: vi.fn(), order: [] as string[] } }));
vi.mock('../lib/batchAssess.ts', () => ({ submitAssessBatch: batch.submit, collectAssessBatches: batch.collect }));
vi.mock('@anthropic-ai/sdk', () => ({ default: class { messages = { create }; } }));
vi.mock('../lib/admin.ts', () => ({ admin: () => db.current.client }));
vi.mock('../lib/sources/index.ts', () => ({ SOURCES: reg.sources }));

import { handle } from '../lib/routes.ts';

let ips = 0;
const call = async (method: string, path: string, o: { body?: unknown; token?: string | null; ip?: string; headers?: Record<string, string> } = {}) => {
  const headers: Record<string, string> = { 'content-type': 'application/json', 'x-forwarded-for': o.ip ?? `10.9.0.${++ips}`, ...o.headers };
  if (o.token !== null) headers['x-admin-token'] = o.token ?? 'open-sesame-open-sesame-open-sesame';
  const r = await handle(new Request('http://localhost/api/' + path, { method, headers, body: method === 'POST' || method === 'PUT' ? JSON.stringify(o.body ?? {}) : undefined }));
  return { status: r.status, body: (await r.json()) as any };
};

const ROW = { id: 7, source: 'youtube', repo: 'gitroomhq/postiz-app', kind: 'repo', title: 'Postiz', why: 'scheduler', credit_url: 'https://youtu.be/x', credit_title: 'A video', credit_author: 'Ann', status: 'pending' };
const REVIEW = { genre: 'Dev Workflow', blurb: 'Schedules posts.', ring: 'trial', rating: 4 };
const writes = (d: any, table: string, op: string) => d.calls(table).filter((q: Query) => has(q, op)).map((q: Query) => arg(q, op));

function setup(o: { row?: any; spent?: number; tapeInsert?: { code?: string }; tapes?: any[] } = {}) {
  let claimed = false; // the atomic claim (update ... where status='pending') only succeeds once
  db.current = fakeDb({
    'rpc:ai_spend_today': () => ({ data: o.spent ?? 0, error: null }),
    'rpc:spend_by_day': () => ({ data: [{ day: '2026-11-05', route: 'radar', calls: 3, cost_usd: 0.02 }], error: null }),
    ai_usage: usageTable(),
    ingest_queue: (q: Query) => {
      if (has(q, 'update')) {
        if (arg(q, 'update')?.status === 'approving') {
          const row = 'row' in o ? o.row : ROW;
          if (!row || row.status !== 'pending' || claimed) return { data: null, error: null };
          claimed = true;
          return { data: { ...row, status: 'approving' }, error: null };
        }
        return { data: 'row' in o && !o.row ? null : { id: 7 }, error: null };
      }
      if (has(q, 'upsert')) return { data: [], error: null };
      if (has(q, 'maybeSingle')) return { data: 'row' in o ? o.row : ROW, error: null };
      return { data: [ROW], error: null };
    },
    tapes: (q: Query) => (has(q, 'upsert') ? { data: { id: 'tape-1' }, error: null } : has(q, 'select') && !has(q, 'insert') && o.tapes ? { data: o.tapes, error: null } : has(q, 'insert') ? (o.tapeInsert ? { data: null, error: { code: o.tapeInsert.code, message: 'x' } } : { data: { id: 'tape-1' }, error: null }) : { data: [], error: null }),
    admin_failures: (q: Query) => ({ data: has(q, 'select') ? [] : null, error: null }),
    source_runs: (q: Query) => (has(q, 'insert') ? { data: null, error: null } : { data: [{ id: 1, source: 'web', found: 2, queued: 1, cost_usd: 0.01, error: null, at: '2026-11-04T09:00:00Z' }], error: null }),
  });
  return db.current;
}

beforeEach(() => {
  create.mockReset();
  create.mockResolvedValue(null);
  reg.sources.length = 0;
  batch.collect.mockReset().mockResolvedValue({ batches: 0, cached: 0, skipped: 0 });
  vi.stubEnv('ADMIN_TOKEN', 'open-sesame-open-sesame-open-sesame');
  vi.stubEnv('CRON_SECRET', 's3cret');
});

describe('admin auth (every /admin route)', () => {
  const routes: [string, string][] = [['GET', 'admin/config/youtube'], ['PUT', 'admin/config/web'], ['GET', 'admin/queue'], ['POST', 'admin/queue/7/approve'], ['POST', 'admin/queue/7/reject'], ['POST', 'admin/paste'], ['POST', 'admin/stock'], ['GET', 'admin/spend'], ['GET', 'admin/runs']];
  it.each(routes)('%s %s refuses a wrong or missing token, and touches nothing', async (m, p) => {
    const d = setup();
    expect((await call(m, p, { token: 'nope' })).status).toBe(403);
    expect((await call(m, p, { token: null })).status).toBe(403);
    expect(d.queries.filter((q: Query) => q.table !== 'admin_failures')).toHaveLength(0); // only the failure counter is touched
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

describe('admin hardening', () => {
  afterEach(() => vi.useRealTimers());
  const failureLog = () => {
    const rows: { at: string; ip: string }[] = [];
    const d = setup();
    d.on('admin_failures', (q: Query) => {
      if (has(q, 'insert')) { rows.push({ at: new Date().toISOString(), ...arg(q, 'insert') }); return { data: null, error: null }; }
      const since = (q.calls.find((c) => c[0] === 'gt') as any)?.[2] ?? '';
      return { data: rows.filter((r) => r.at > since).reverse().slice(0, 20), error: null };
    });
    return { d, rows };
  };
  const fail = async (n: number) => { for (let i = 0; i < n; i++) await call('GET', 'admin/runs', { token: 'wrong', ip: `10.5.${n}.${i}` }); };

  it('compares the cron secret on radar/refresh with sameSecret, not ===', () => {
    const src = readFileSync(new URL('../lib/routes.ts', import.meta.url), 'utf8');
    expect(src).toMatch(/const forced = [^\n]*sameSecret\(/);
    expect(src).not.toMatch(/x-cron-secret'\) === /);
  });
  it('treats an ADMIN_TOKEN shorter than 32 characters as unset (403 even for the right token) and logs once', async () => {
    vi.stubEnv('ADMIN_TOKEN', 'too-short-9-xyz');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const d = setup();
    expect((await call('GET', 'admin/runs', { token: 'too-short-9-xyz' })).status).toBe(403);
    expect((await call('GET', 'admin/runs', { token: 'too-short-9-xyz' })).status).toBe(403);
    expect(d.calls('source_runs')).toHaveLength(0);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toMatch(/ADMIN_TOKEN/);
    expect(JSON.stringify(warn.mock.calls)).not.toContain('too-short-9-xyz');
    warn.mockRestore();
  });
  it('records each wrong token in admin_failures with the caller IP', async () => {
    const { rows } = failureLog();
    await call('GET', 'admin/runs', { token: 'nope', ip: '10.4.0.1' });
    expect(rows).toEqual([expect.objectContaining({ ip: '10.4.0.1' })]);
    await call('GET', 'admin/runs', { ip: '10.4.0.1' }); // the right token adds nothing
    expect(rows).toHaveLength(1);
  });
  it('after 20 failures in an hour (from any IP) every admin route answers 429, then recovers after 15 minutes', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-05T10:00:00Z'));
    failureLog();
    await fail(19);
    expect((await call('GET', 'admin/runs', { ip: '10.3.0.1' })).status).toBe(200); // 19 is still fine
    await call('GET', 'admin/runs', { token: 'wrong', ip: '10.3.0.2' }); // the 20th
    for (const [m, p] of [['GET', 'admin/runs'], ['GET', 'admin/queue'], ['POST', 'admin/queue/7/approve'], ['POST', 'admin/paste'], ['PUT', 'admin/config/web']]) {
      expect((await call(m, p, { ip: '10.3.1.' + p.length })).status, p).toBe(429);
    }
    vi.setSystemTime(new Date('2026-11-05T10:16:00Z'));
    expect((await call('GET', 'admin/runs', { ip: '10.3.2.1' })).status).toBe(200);
  });
  it('does not lock out on failures older than an hour', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-05T10:00:00Z'));
    failureLog();
    await fail(20);
    vi.setSystemTime(new Date('2026-11-05T11:01:00Z'));
    expect((await call('GET', 'admin/runs', { ip: '10.3.3.1' })).status).toBe(200);
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
    expect(writes(d, 'ingest_queue', 'update')).toEqual([
      expect.objectContaining({ status: 'approving' }),
      expect.objectContaining({ status: 'stocked', decided_at: expect.any(String) }),
    ]);
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
  it('409s a row that is already stocked, rejected or being approved, without any AI call', async () => {
    for (const status of ['stocked', 'rejected', 'approving']) {
      setup({ row: { ...ROW, status } });
      expect((await call('POST', 'admin/queue/7/approve')).status).toBe(409);
    }
    expect(create).not.toHaveBeenCalled();
  });
  it('claims the row atomically (status pending -> approving) before anything is spent', async () => {
    const d = setup();
    await call('POST', 'admin/queue/7/approve');
    const claim = d.calls('ingest_queue')[0];
    expect(arg(claim, 'update')).toEqual({ status: 'approving' });
    expect(claim.calls).toContainEqual(['eq', 'id', 7]);
    expect(claim.calls).toContainEqual(['eq', 'status', 'pending']);
    expect(claim.calls.some((c: any[]) => c[0] === 'select')).toBe(true);
  });
  it('a double approve makes one reviewRepo call and the second click gets a 409', async () => {
    setup();
    const [a, b] = await Promise.all([call('POST', 'admin/queue/7/approve'), call('POST', 'admin/queue/7/approve')]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    expect(create).toHaveBeenCalledTimes(1);
  });
  it('un-archives and refreshes an archived tape (upsert on its slug), and stocks the row', async () => {
    const d = setup({ tapes: [{ slug: 'gh-gitroomhq-postiz-app', kind: 'repo', archived: true }] });
    const r = await call('POST', 'admin/queue/7/approve');
    expect(r).toEqual({ status: 200, body: { ok: true, slug: 'gh-gitroomhq-postiz-app' } });
    expect(writes(d, 'tapes', 'insert')).toHaveLength(0);
    expect(d.calls('tapes').find((q: Query) => has(q, 'upsert'))!.calls).toContainEqual(['upsert', expect.objectContaining({ slug: 'gh-gitroomhq-postiz-app', archived: false, credit_url: 'https://youtu.be/x' }), { onConflict: 'slug' }]);
    expect(create).toHaveBeenCalledTimes(1);
    expect(writes(d, 'ingest_queue', 'update').at(-1)).toMatchObject({ status: 'stocked' });
  });
  it('marks the row stocked with the existing slug and spends nothing when the tape is already live (community slug too)', async () => {
    const d = setup({ tapes: [{ slug: 'c-gitroomhq-postiz-app', kind: 'community', archived: false }] });
    const r = await call('POST', 'admin/queue/7/approve');
    expect(r).toEqual({ status: 200, body: { ok: true, slug: 'c-gitroomhq-postiz-app', existing: true } });
    expect(create).not.toHaveBeenCalled();
    expect(writes(d, 'ai_usage', 'insert')).toHaveLength(0);
    expect(writes(d, 'tapes', 'insert')).toHaveLength(0);
    expect(d.calls('tapes').some((q: Query) => has(q, 'upsert'))).toBe(false);
    expect(writes(d, 'ingest_queue', 'update').at(-1)).toMatchObject({ status: 'stocked' });
  });
  it('503s without spending when the daily budget is gone', async () => {
    vi.stubEnv('AI_DAILY_BUDGET_USD', '1');
    const d = setup({ spent: 2 });
    expect((await call('POST', 'admin/queue/7/approve')).status).toBe(503);
    expect(create).not.toHaveBeenCalled();
    expect(writes(d, 'tapes', 'insert')).toHaveLength(0);
    expect(writes(d, 'ingest_queue', 'update').at(-1)).toMatchObject({ status: 'pending' });
  });
  it('404s when the repo has disappeared from GitHub, leaving the row pending', async () => {
    stubGitHub({});
    const d = setup();
    expect((await call('POST', 'admin/queue/7/approve')).status).toBe(404);
    expect(writes(d, 'ingest_queue', 'update').at(-1)).toMatchObject({ status: 'pending' });
  });
  it('409s a tape that already exists and still marks the row stocked', async () => {
    const d = setup({ tapeInsert: { code: '23505' } });
    expect((await call('POST', 'admin/queue/7/approve')).status).toBe(409);
    expect(writes(d, 'ingest_queue', 'update').at(-1)).toMatchObject({ status: 'stocked' });
  });
  it('500s and puts the row back to pending when the review or the insert fails', async () => {
    create.mockRejectedValue(new Error('anthropic down'));
    const d = setup();
    expect((await call('POST', 'admin/queue/7/approve')).status).toBe(500);
    expect(writes(d, 'ingest_queue', 'update').at(-1)).toMatchObject({ status: 'pending' });
    expect(d.calls('ingest_queue').filter((q: Query) => has(q, 'update')).at(-1)!.calls).toContainEqual(['eq', 'status', 'approving']);
    create.mockResolvedValue(toolReply('review_repo', REVIEW));
    const d2 = setup({ tapeInsert: { code: '42P01' } });
    expect((await call('POST', 'admin/queue/7/approve')).status).toBe(500);
    expect(writes(d2, 'ingest_queue', 'update').at(-1)).toMatchObject({ status: 'pending' });
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

describe('POST /admin/stock', () => {
  const stock = (urls: unknown, o: { ip?: string } = {}) => call('POST', 'admin/stock', { body: { urls }, ...o });
  /** The tapes table answers the slug lookup with `existing` (matched on the .in('slug', ...) list), and inserts fine. */
  const withTapes = (existing: { slug: string; kind: string; archived: boolean }[] = [], o: Parameters<typeof setup>[0] = {}) => {
    const d = setup(o);
    d.on('tapes', (q: Query) => {
      if (has(q, 'upsert') || has(q, 'insert')) return { data: { id: 'tape-1' }, error: null };
      const slugs: string[] = (q.calls.find((c) => c[0] === 'in') as any)?.[2] ?? [];
      return { data: existing.filter((t) => slugs.includes(t.slug)), error: null };
    });
    return d;
  };
  beforeEach(() => {
    create.mockResolvedValue(toolReply('review_repo', REVIEW));
    batch.submit.mockReset().mockResolvedValue(null);
  });

  it('stocks a new repo: reviewed by Haiku, metered as "admin", star snapshot, trust and shelf dates like approve', async () => {
    stubGitHub(POSTIZ);
    const d = withTapes();
    const r = await stock(['https://github.com/gitroomhq/postiz-app']);
    expect(r).toEqual({
      status: 200,
      body: { results: [{ input: 'https://github.com/gitroomhq/postiz-app', repo: 'gitroomhq/postiz-app', status: 'added', slug: 'gh-gitroomhq-postiz-app', genre: 'Dev Workflow' }], added: 1, skipped: 0 },
    });
    expect(writes(d, 'tapes', 'insert')).toEqual([
      expect.objectContaining({ kind: 'repo', slug: 'gh-gitroomhq-postiz-app', genre: 'Dev Workflow', ring: 'trial', rating: 4, trust: 'clean', archived: false, credit_url: null, week: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/), month: expect.stringMatching(/^\d{4}-\d{2}-01$/) }),
    ]);
    expect(writes(d, 'star_snapshots', 'upsert')).toEqual([[expect.objectContaining({ repo: 'gitroomhq/postiz-app' })]]);
    expect(writes(d, 'ai_usage', 'insert').map((x: any) => x.route)).toEqual(['admin']);
    expect(create).toHaveBeenCalledTimes(1);
  });
  it('accepts bare owner/repo, and submits the added repos for batch pre-assessment', async () => {
    stubGitHub({ ...repoRoutes('acme/widget'), ...repoRoutes('acme/gadget') });
    withTapes();
    const r = await stock(['acme/widget', 'https://github.com/acme/gadget']);
    expect(r.body.results.map((x: any) => x.status)).toEqual(['added', 'added']);
    expect(batch.submit).toHaveBeenCalledTimes(1);
    expect([...batch.submit.mock.calls[0][0]].sort()).toEqual(['acme/gadget', 'acme/widget']);
  });
  it('calls a live tape a duplicate (gh- or c- slug) before spending anything: no GitHub call, no AI', async () => {
    const seen = stubGitHub({});
    const d = withTapes([{ slug: 'gh-acme-widget', kind: 'repo', archived: false }, { slug: 'c-acme-gadget', kind: 'community', archived: false }]);
    const r = await stock(['acme/widget', 'https://github.com/Acme/Gadget']);
    expect(r.body.results).toEqual([
      { input: 'acme/widget', repo: 'acme/widget', status: 'duplicate', slug: 'gh-acme-widget' },
      { input: 'https://github.com/Acme/Gadget', repo: 'Acme/Gadget', status: 'duplicate', slug: 'c-acme-gadget' },
    ]);
    expect(r.body).toMatchObject({ added: 0, skipped: 2 });
    expect(seen).toHaveLength(0);
    expect(create).not.toHaveBeenCalled();
    expect(writes(d, 'tapes', 'insert')).toHaveLength(0);
    expect(writes(d, 'ai_usage', 'insert')).toHaveLength(0);
  });
  it('restores an archived tape: un-archived and refreshed by upsert on its own slug, kind kept', async () => {
    stubGitHub(repoRoutes('acme/widget'));
    const d = withTapes([{ slug: 'gh-acme-widget', kind: 'repo', archived: true }]);
    const r = await stock(['acme/widget']);
    expect(r.body.results).toEqual([expect.objectContaining({ status: 'restored', slug: 'gh-acme-widget', genre: 'Dev Workflow' })]);
    expect(r.body).toMatchObject({ added: 1, skipped: 0 });
    expect(writes(d, 'tapes', 'insert')).toHaveLength(0);
    expect(d.calls('tapes').find((q: Query) => has(q, 'upsert'))!.calls).toContainEqual(['upsert', expect.objectContaining({ slug: 'gh-acme-widget', kind: 'repo', archived: false }), { onConflict: 'slug' }]);
  });
  it('dedupes within the paste, case-insensitively, and reports the repeat as a duplicate without a second call', async () => {
    stubGitHub(repoRoutes('acme/widget'));
    withTapes();
    const r = await stock(['acme/widget', 'https://github.com/ACME/Widget', 'https://github.com/acme/widget.git']);
    expect(r.body.results.map((x: any) => x.status)).toEqual(['added', 'duplicate', 'duplicate']);
    expect(create).toHaveBeenCalledTimes(1);
    expect(r.body).toMatchObject({ added: 1, skipped: 2 });
  });
  it('marks lines that are not repos as invalid, with no calls', async () => {
    const seen = stubGitHub({});
    withTapes();
    const r = await stock(['not a link', 'https://github.com/orgs/foo', '']);
    expect(r.body.results.map((x: any) => x.status)).toEqual(['invalid', 'invalid', 'invalid']);
    expect(r.body.results[0]).toMatchObject({ input: 'not a link' });
    expect(seen).toHaveLength(0);
    expect(create).not.toHaveBeenCalled();
  });
  it('reports a repo GitHub does not know as not_found, and carries on', async () => {
    stubGitHub(repoRoutes('acme/widget'));
    withTapes();
    const r = await stock(['acme/ghost', 'acme/widget']);
    expect(r.body.results.map((x: any) => x.status)).toEqual(['not_found', 'added']);
    expect(create).toHaveBeenCalledTimes(1);
  });
  it('one GitHub error (e.g. rate limit) becomes an error item and the others continue', async () => {
    stubGitHub({ ...repoRoutes('acme/widget'), '/repos/acme/flaky': 403, ...repoRoutes('acme/gadget') });
    withTapes();
    const r = await stock(['acme/widget', 'acme/flaky', 'acme/gadget']);
    expect(r.body.results.map((x: any) => x.status)).toEqual(['added', 'error', 'added']);
    expect(r.body.results[1].message).toEqual(expect.any(String));
    expect(r.body).toMatchObject({ added: 2, skipped: 1 });
  });
  it('a failing review is an error item for that repo only', async () => {
    stubGitHub({ ...repoRoutes('acme/widget'), ...repoRoutes('acme/gadget') });
    withTapes();
    create.mockRejectedValueOnce(new Error('anthropic down'));
    const r = await stock(['acme/widget', 'acme/gadget']);
    expect(r.body.results.filter((x: any) => x.status === 'error')).toHaveLength(1);
    expect(r.body.results.filter((x: any) => x.status === 'added')).toHaveLength(1);
  });
  it('503s with the busy line, and stocks and spends nothing, when the daily budget is gone', async () => {
    vi.stubEnv('AI_DAILY_BUDGET_USD', '1');
    const seen = stubGitHub(repoRoutes('acme/widget'));
    const d = withTapes([], { spent: 2 });
    const r = await stock(['acme/widget']);
    expect(r.status).toBe(503);
    expect(r.body.error).toMatch(/out of quarters/);
    expect(create).not.toHaveBeenCalled();
    expect(seen).toHaveLength(0);
    expect(writes(d, 'tapes', 'insert')).toHaveLength(0);
  });
  it('marks a pending queue row for the same repo as stocked', async () => {
    stubGitHub(repoRoutes('acme/widget'));
    const d = withTapes();
    await stock(['acme/widget']);
    const q = d.calls('ingest_queue').find((x: Query) => has(x, 'update'))!;
    expect(arg(q, 'update')).toEqual(expect.objectContaining({ status: 'stocked', decided_at: expect.any(String) }));
    expect(q.calls).toContainEqual(['eq', 'repo', 'acme/widget']);
    expect(q.calls).toContainEqual(['eq', 'status', 'pending']);
  });
  it('also clears the queue row for a duplicate (already stocked elsewhere)', async () => {
    stubGitHub({});
    const d = withTapes([{ slug: 'gh-acme-widget', kind: 'repo', archived: false }]);
    await stock(['acme/widget']);
    expect(d.calls('ingest_queue').some((x: Query) => has(x, 'update'))).toBe(true);
  });
  it('meters one "admin" usage row per review', async () => {
    stubGitHub({ ...repoRoutes('acme/widget'), ...repoRoutes('acme/gadget') });
    const d = withTapes();
    await stock(['acme/widget', 'acme/gadget']);
    expect(writes(d, 'ai_usage', 'insert').map((x: any) => x.route)).toEqual(['admin', 'admin']);
  });
  it('400s a missing list, a non-string entry and 21 links, touching nothing', async () => {
    const d = withTapes();
    expect((await stock(undefined)).status).toBe(400);
    expect((await stock([])).status).toBe(400);
    expect((await stock([5])).status).toBe(400);
    expect((await stock(Array(21).fill('acme/widget'))).status).toBe(400);
    expect(d.calls('tapes')).toHaveLength(0);
  });
  it('is limited per IP like the other admin routes', async () => {
    withTapes();
    for (let i = 0; i < 60; i++) await stock([], { ip: '10.7.7.7' });
    expect((await stock([], { ip: '10.7.7.7' })).status).toBe(429);
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

describe('GET and PUT /admin/config/:key', () => {
  const CHAN = 'UC' + 'a'.repeat(22);
  const YT = { queries: ['claude code skills'], channels: [CHAN] };
  const cfgDb = (...v: unknown[]) => {
    const value = v.length ? v[0] : YT;
    const d = setup();
    d.on('source_config', (q: Query) => (has(q, 'upsert') ? { data: null, error: null } : { data: value === undefined ? null : { value }, error: null }));
    return d;
  };
  const put = (key: string, body: unknown) => call('PUT', `admin/config/${key}`, { body });

  it('reads the stored value for youtube and web', async () => {
    const d = cfgDb();
    expect((await call('GET', 'admin/config/youtube')).body).toEqual({ key: 'youtube', value: YT });
    expect(d.calls('source_config')[0].calls).toContainEqual(['eq', 'key', 'youtube']);
    expect((await call('GET', 'admin/config/web')).status).toBe(200);
  });
  it('gives null for a missing row, 404 for any other key, 500 when the read fails', async () => {
    cfgDb(undefined);
    expect((await call('GET', 'admin/config/web')).body).toEqual({ key: 'web', value: null });
    expect((await call('GET', 'admin/config/github')).status).toBe(404);
    expect((await call('PUT', 'admin/config/github', { body: {} })).status).toBe(404);
    const d = cfgDb();
    d.on('source_config', () => ({ data: null, error: { message: 'down' } }));
    expect((await call('GET', 'admin/config/youtube')).status).toBe(500);
  });
  it('saves a valid youtube config (trimmed) with an upsert on the key', async () => {
    const d = cfgDb();
    const r = await put('youtube', { queries: ['  mcp servers  '], channels: [CHAN] });
    expect(r.body).toEqual({ ok: true, key: 'youtube', value: { queries: ['mcp servers'], channels: [CHAN] } });
    expect(writes(d, 'source_config', 'upsert')).toEqual([{ key: 'youtube', value: { queries: ['mcp servers'], channels: [CHAN] } }]);
  });
  it('rejects bad youtube shapes with 400 and writes nothing', async () => {
    const d = cfgDb();
    const bad: unknown[] = [
      {},
      { queries: 'a', channels: [] },
      { queries: ['a', 'b', 'c', 'd', 'e', 'f'], channels: [] },
      { queries: ['x'.repeat(101)], channels: [] },
      { queries: [''], channels: [] },
      { queries: [5], channels: [] },
      { queries: [], channels: ['not a channel'] },
      { queries: [], channels: ['https://www.youtube.com/watch?v=dQw4w9WgXcQ'] },
      { queries: [], channels: ['https://www.youtube.com/c/Name'] },
      { queries: [], channels: Array.from({ length: 11 }, (_, i) => 'UC' + String(i).padStart(22, 'a')) },
      { queries: [], channels: [`https://www.youtube.com/channel/${CHAN}x`] },
      { queries: [], channels: [] },
    ];
    for (const b of bad) expect((await put('youtube', b)).status, JSON.stringify(b)).toBe(400);
    expect(writes(d, 'source_config', 'upsert')).toEqual([]);
  });
  it('normalises youtube channels: UC id for ids and links, @handle otherwise, repeats dropped', async () => {
    cfgDb();
    const r = await put('youtube', { queries: [], channels: [`https://www.youtube.com/channel/${CHAN}`, CHAN, 'https://www.youtube.com/@TheNextNewThingAI/videos', 'thenextnewthingai', '@Other'] });
    expect(r.body).toEqual({ ok: true, key: 'youtube', value: { queries: [], channels: [CHAN, '@TheNextNewThingAI', '@Other'] } });
    const bad = await put('youtube', { queries: [], channels: ['https://www.youtube.com/user/Name'] });
    expect(bad.status).toBe(400);
    expect(bad.body).toMatchObject({ error: 'Use a channel link, @handle or channel ID' });
  });
  it('accepts a channel-only or query-only youtube config', async () => {
    cfgDb();
    expect((await put('youtube', { queries: [], channels: [CHAN] })).status).toBe(200);
    expect((await put('youtube', { queries: ['a'], channels: [] })).status).toBe(200);
  });
  it('saves a web query of up to 300 characters and rejects the rest', async () => {
    const d = cfgDb();
    expect((await put('web', { query: ' best skills ' })).body.value).toEqual({ query: 'best skills' });
    expect((await put('web', { query: 'x'.repeat(300) })).status).toBe(200);
    for (const b of [{}, { query: '' }, { query: '   ' }, { query: 'x'.repeat(301) }, { query: 5 }, { queries: ['a'] }]) {
      expect((await put('web', b)).status, JSON.stringify(b)).toBe(400);
    }
    expect(writes(d, 'source_config', 'upsert')).toHaveLength(2);
  });
  it('500s when the write fails', async () => {
    const d = cfgDb();
    d.on('source_config', () => ({ data: null, error: { message: 'down' } }));
    expect((await put('web', { query: 'q' })).status).toBe(500);
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
