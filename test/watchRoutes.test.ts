import { beforeEach, describe, expect, it, vi } from 'vitest';
import { arg, fakeDb, has, usageTable, type Query } from './helpers/fakeDb.ts';
import { toolReply } from './helpers/anthropic.ts';
import { repoRoutes, stubGitHub } from './helpers/github.ts';

const { create, db, watch, batch } = vi.hoisted(() => ({
  create: vi.fn(),
  db: { current: null as any },
  watch: { run: vi.fn(), ctx: null as any },
  batch: { submit: vi.fn(), collect: vi.fn() },
}));
vi.mock('../lib/batchAssess.ts', () => ({ submitAssessBatch: batch.submit, collectAssessBatches: batch.collect }));
vi.mock('@anthropic-ai/sdk', () => ({ default: class { messages = { create }; } }));
vi.mock('../lib/admin.ts', () => ({ admin: () => db.current.client }));
vi.mock('../lib/sources/watch.ts', () => ({
  watchChannels: async (ctx: any, opts?: unknown) => {
    watch.ctx = ctx;
    return watch.run(ctx, opts);
  },
}));

import { handle } from '../lib/routes.ts';

let ips = 0;
const call = async (method: string, path: string, o: { token?: string | null; headers?: Record<string, string> } = {}) => {
  const headers: Record<string, string> = { 'content-type': 'application/json', 'x-forwarded-for': `10.7.0.${++ips}`, ...o.headers };
  if (o.token !== null) headers['x-admin-token'] = o.token ?? 'open-sesame-open-sesame-open-sesame';
  const r = await handle(new Request('http://localhost/api/' + path, { method, headers, body: '{}' }));
  return { status: r.status, body: (await r.json()) as any };
};
const SUMMARY = { channels: 1, videos_checked: 1, repos_found: 2, added: 1, restored: 0, duplicates: 1, errors: 0, not_found: 0, cost_usd: 0.004 };
const REVIEW = { genre: 'Dev Workflow', blurb: 'Schedules posts.', ring: 'trial', rating: 4 };
const CREDIT = { url: 'https://www.youtube.com/watch?v=v1', title: 'Weekly repos · The Channel' };
const writes = (d: any, table: string, op: string) => d.calls(table).filter((q: Query) => has(q, op)).map((q: Query) => arg(q, op));

function setup(existing: { slug: string; kind: string; archived: boolean }[] = []) {
  db.current = fakeDb({
    'rpc:ai_spend_today': () => ({ data: 0, error: null }),
    ai_usage: usageTable(),
    admin_failures: (q: Query) => ({ data: has(q, 'select') ? [] : null, error: null }),
    source_config: () => ({ data: { value: { channels: [], seen: [] } }, error: null }),
    tapes: (q: Query) => {
      if (has(q, 'upsert') || has(q, 'insert')) return { data: { id: 'tape-1' }, error: null };
      const slugs: string[] = (q.calls.find((c) => c[0] === 'in') as any)?.[2] ?? [];
      return { data: existing.filter((t) => slugs.includes(t.slug)), error: null };
    },
  });
  return db.current;
}

beforeEach(() => {
  create.mockReset().mockResolvedValue(toolReply('review_repo', REVIEW));
  watch.run.mockReset().mockResolvedValue(SUMMARY);
  batch.submit.mockReset().mockResolvedValue(null);
  vi.stubEnv('ADMIN_TOKEN', 'open-sesame-open-sesame-open-sesame');
  vi.stubEnv('CRON_SECRET', 's3cret');
});

describe('POST /sources/watch', () => {
  const run = (secret?: string) => call('POST', 'sources/watch', { token: null, headers: secret === undefined ? {} : { 'x-cron-secret': secret } });
  it('403s without the cron secret, with a wrong one, or when CRON_SECRET is unset, and runs nothing', async () => {
    setup();
    expect((await run()).status).toBe(403);
    expect((await run('nope')).status).toBe(403);
    expect((await call('POST', 'sources/watch', { headers: { 'x-cron-secret': '' } })).status).toBe(403); // the admin token is not enough
    vi.stubEnv('CRON_SECRET', '');
    expect((await run('')).status).toBe(403);
    expect(watch.run).not.toHaveBeenCalled();
  });
  it('runs the watcher and returns its summary', async () => {
    setup();
    expect(await run('s3cret')).toEqual({ status: 200, body: { ok: true, ...SUMMARY } });
  });
  it('answers 202 and works on in the background when EdgeRuntime.waitUntil exists', async () => {
    setup();
    const waits: Promise<unknown>[] = [];
    vi.stubGlobal('EdgeRuntime', { waitUntil: (p: Promise<unknown>) => waits.push(p) });
    expect((await run('s3cret')).status).toBe(202);
    await Promise.all(waits);
    expect(watch.run).toHaveBeenCalledTimes(1);
  });
  it('500s without details when the run throws', async () => {
    setup();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    watch.run.mockRejectedValue(new Error('secret detail'));
    expect(await run('s3cret')).toEqual({ status: 500, body: { error: 'Watch run failed' } });
  });
});

describe('POST /admin/watch/run', () => {
  it('refuses a wrong or missing token and runs nothing', async () => {
    setup();
    expect((await call('POST', 'admin/watch/run', { token: 'nope' })).status).toBe(403);
    expect((await call('POST', 'admin/watch/run', { token: null })).status).toBe(403);
    expect(watch.run).not.toHaveBeenCalled();
  });
  it('runs the watcher now and returns the summary', async () => {
    setup();
    expect(await call('POST', 'admin/watch/run')).toEqual({ status: 200, body: { ok: true, ...SUMMARY } });
  });
});

describe('the watcher\'s stock path (live ctx)', () => {
  const stockVia = async (repo: string) => {
    await call('POST', 'admin/watch/run');
    return watch.ctx.stock(repo, CREDIT);
  };
  it('skips a live tape with no GitHub call and no AI', async () => {
    const seen = stubGitHub({});
    setup([{ slug: 'gh-acme-widget', kind: 'repo', archived: false }]);
    expect(await stockVia('acme/widget')).toEqual({ status: 'duplicate', slug: 'gh-acme-widget' });
    expect(seen).toHaveLength(0);
    expect(create).not.toHaveBeenCalled();
  });
  it('stocks a new repo credited to the video, metered as "watch", with its cost', async () => {
    stubGitHub(repoRoutes('acme/widget'));
    const d = setup();
    const r = await stockVia('acme/widget');
    expect(r).toMatchObject({ status: 'added', slug: 'gh-acme-widget', cost_usd: expect.any(Number) });
    expect(writes(d, 'tapes', 'insert')[0]).toMatchObject({ credit_url: CREDIT.url, credit_title: CREDIT.title });
    expect(writes(d, 'ai_usage', 'insert').map((x: any) => x.route)).toEqual(['watch']);
  });
  it('brings an archived tape back in place', async () => {
    stubGitHub(repoRoutes('acme/widget'));
    const d = setup([{ slug: 'gh-acme-widget', kind: 'repo', archived: true }]);
    expect(await stockVia('acme/widget')).toMatchObject({ status: 'restored', slug: 'gh-acme-widget' });
    expect(writes(d, 'tapes', 'upsert')[0]).toMatchObject({ slug: 'gh-acme-widget', archived: false });
  });
  it('is not_found when GitHub does not have the repo, and error when stocking throws', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    stubGitHub({});
    setup();
    expect(await stockVia('acme/ghost')).toEqual({ status: 'not_found' });
    stubGitHub({ ...repoRoutes('acme/widget') });
    create.mockRejectedValue(new Error('anthropic down'));
    expect(await stockVia('acme/widget')).toEqual({ status: 'error' });
  });
  it('writes a source_runs row named youtube-watch and saves the config', async () => {
    const d = setup();
    await call('POST', 'admin/watch/run');
    await watch.ctx.logRun({ found: 3, queued: 2, cost_usd: 0.01 });
    expect(writes(d, 'source_runs', 'insert')).toEqual([{ source: 'youtube-watch', found: 3, queued: 2, cost_usd: 0.01, error: null }]);
    await watch.ctx.saveConfig('watch', { channels: [], seen: ['a'] });
    expect(writes(d, 'source_config', 'upsert')).toEqual([{ key: 'watch', value: { channels: [], seen: ['a'] } }]);
  });
  it('batch pre-assesses what the run put on the shelves', async () => {
    stubGitHub(repoRoutes('acme/widget'));
    setup();
    watch.run.mockImplementation(async (ctx: any) => (await ctx.stock('acme/widget', CREDIT), SUMMARY));
    await call('POST', 'admin/watch/run');
    expect(batch.submit).toHaveBeenCalledWith(['acme/widget']);
  });
});

describe('PUT /admin/config/watch', () => {
  const STORED = { channels: [{ handle: '@TheNextNewThingAI', channel_id: 'UC' + 'a'.repeat(22), uploads: 'UU' + 'a'.repeat(22) }], seen: ['v1'] };
  const put = (body: unknown) => handle(new Request('http://localhost/api/admin/config/watch', {
    method: 'PUT',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': `10.6.0.${++ips}`, 'x-admin-token': 'open-sesame-open-sesame-open-sesame' },
    body: JSON.stringify(body),
  })).then(async (r) => ({ status: r.status, body: (await r.json()) as any }));
  it('saves the new list but keeps seen and resolved ids for handles that stay', async () => {
    const d = setup();
    d.on('source_config', (q: Query) => (has(q, 'upsert') ? { data: null, error: null } : { data: { value: STORED }, error: null }));
    const r = await put({ channels: [{ handle: '@TheNextNewThingAI' }, { handle: '@NewOne' }] });
    expect(r.status).toBe(200);
    expect(writes(d, 'source_config', 'upsert')).toEqual([{ key: 'watch', value: { channels: [STORED.channels[0], { handle: '@NewOne' }], seen: ['v1'] } }]);
  });
  it('400s a bad handle and writes nothing', async () => {
    const d = setup();
    expect((await put({ channels: ['not a channel'] })).status).toBe(400);
    expect(writes(d, 'source_config', 'upsert')).toEqual([]);
  });
});

describe('watch days', () => {
  it('cron runs ignore a days body and use the 14 day default', async () => {
    setup();
    const r = await handle(new Request('http://localhost/api/sources/watch', { method: 'POST', headers: { 'x-cron-secret': 's3cret', 'x-forwarded-for': '10.8.0.1' }, body: JSON.stringify({ days: 120 }) }));
    expect(r.status).toBe(200);
    expect(watch.run.mock.calls.at(-1)![1]).toBeUndefined();
  });

  it('the admin run passes a days body on, and none when the body is empty or wrong', async () => {
    setup();
    const post = (body: string) => handle(new Request('http://localhost/api/admin/watch/run', { method: 'POST', headers: { 'x-admin-token': 'open-sesame-open-sesame-open-sesame', 'x-forwarded-for': `10.8.1.${++ips}` }, body }));
    await post(JSON.stringify({ days: 120 }));
    expect(watch.run.mock.calls.at(-1)![1]).toEqual({ days: 120 });
    await post('{}');
    expect(watch.run.mock.calls.at(-1)![1]).toEqual({});
    await post('not json');
    expect(watch.run.mock.calls.at(-1)![1]).toEqual({});
    await post(JSON.stringify({ days: 'x' }));
    expect(watch.run.mock.calls.at(-1)![1]).toEqual({});
  });
});
