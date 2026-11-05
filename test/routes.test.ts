import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeDb, has, type Query } from './helpers/fakeDb.ts';
import { jsonReply, toolReply } from './helpers/anthropic.ts';
import { LPSMURF, POSTIZ, stubGitHub } from './helpers/github.ts';

const { create, db } = vi.hoisted(() => ({ create: vi.fn(), db: { current: null as any } }));
vi.mock('@anthropic-ai/sdk', () => ({ default: class { messages = { create }; } }));
vi.mock('../lib/admin.ts', () => ({ admin: () => db.current.client }));

import { handle } from '../lib/routes.ts';
import { CLERK_LINES } from '../lib/clerkGuard.ts';
import { HAIKU } from '../lib/ai.ts';
import { SAMPLE } from './helpers/samples.ts';

const CANDS = [
  { slug: 'diagram-design', title: 'Diagram Design', genre: 'Design', blurb: 'Diagrams as SVG', kind: 'skill', match: true },
  { slug: 'gh-acme-new', title: 'acme/new', genre: 'Dev Workflow', blurb: 'new', kind: 'repo', match: false },
];
let n = 0;
const vid = () => `visitor-${++n}-${Math.random().toString(16).slice(2, 8)}`;
let ips = 0;
/** Each call gets its own client IP unless one is passed: rate limits key on the IP now. */
const post = async (path: string, body: Record<string, unknown>, xff: string = `10.0.0.${++ips}`, extra: Record<string, string> = {}) => {
  const r = await handle(new Request('http://localhost/api/' + path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': xff, ...extra }, body: JSON.stringify(body) }));
  return { status: r.status, body: (await r.json()) as any };
};

function setup(o: { spent?: number; inStore?: { slug: string; kind: string; genre: string } | null; searchError?: boolean } = {}) {
  db.current = fakeDb({
    'rpc:search_tapes': () => (o.searchError ? { data: null, error: { message: 'missing function' } } : { data: CANDS, error: null }),
    'rpc:ai_spend_today': () => ({ data: o.spent ?? 0, error: null }),
    assessments: () => ({ data: null, error: null }),
    tapes: (q: Query) => (has(q, 'in') ? { data: o.inStore ?? null, error: null } : { data: CANDS, error: null }),
  });
  return db.current;
}

beforeEach(() => create.mockReset());

describe('POST /clerk: plain questions', () => {
  it('answers junk with a canned line and no AI or DB call', async () => {
    const d = setup();
    const r = await post('clerk', { question: '???', visitorId: vid() });
    expect(r).toEqual({ status: 200, body: { answer: CLERK_LINES.junk, slugs: [], aisle: 'counter' } });
    expect(create).not.toHaveBeenCalled();
    expect(d.queries).toHaveLength(0);
  });

  it('searches candidates, asks Haiku and records usage', async () => {
    const d = setup();
    create.mockResolvedValue(toolReply('recommend', { on_topic: true, answer: 'Rent Diagram Design.', slugs: ['diagram-design'], aisle: 'Design' }));
    const r = await post('clerk', { question: 'a skill for making diagrams', visitorId: vid() });
    expect(r.body).toEqual({ answer: 'Rent Diagram Design.', slugs: ['diagram-design'], aisle: 'Design' });
    expect(d.calls('rpc:search_tapes')[0].calls[0][1]).toEqual({ q: 'a skill for making diagrams', n: 30 });
    expect(create.mock.calls[0][0].model).toBe(HAIKU);
    expect(d.calls('ai_usage').some((q: Query) => has(q, 'insert'))).toBe(true);
  });

  it('redirects off-topic questions in character', async () => {
    setup();
    create.mockResolvedValue(toolReply('recommend', { on_topic: false, answer: 'Here is your essay...', slugs: [], aisle: 'counter' }));
    const r = await post('clerk', { question: 'write my history essay', visitorId: vid() });
    expect(r.body).toEqual({ answer: CLERK_LINES.offTopic, slugs: [], aisle: 'counter' });
  });

  it('falls back to search-only free mode when the budget is spent', async () => {
    vi.stubEnv('AI_DAILY_BUDGET_USD', '1');
    setup({ spent: 2 });
    const r = await post('clerk', { question: 'a skill for making diagrams', visitorId: vid() });
    expect(r.body).toEqual({ answer: CLERK_LINES.free, slugs: ['diagram-design'], aisle: 'Design' });
    expect(create).not.toHaveBeenCalled();
  });

  it('still works before migration 003 (no search function): live catalog fallback', async () => {
    const d = setup({ searchError: true });
    create.mockResolvedValue(toolReply('recommend', { on_topic: true, answer: 'ok', slugs: [], aisle: 'counter' }));
    await post('clerk', { question: 'diagrams', visitorId: vid() });
    const q = d.calls('tapes')[0];
    expect(has(q, 'eq', 'archived', false)).toBe(true);
  });
});

describe('POST /clerk: pasted repos', () => {
  it('returns a full assessment for a GitHub URL', async () => {
    stubGitHub(POSTIZ);
    setup();
    create.mockResolvedValue(jsonReply(SAMPLE));
    const r = await post('clerk', { question: 'https://github.com/gitroomhq/postiz-app', visitorId: vid() });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      answer: SAMPLE.plain,
      slugs: ['diagram-design'],
      aisle: 'counter',
      in_store: null,
      cached: false,
      assessment: { ring: 'hold', plain: SAMPLE.plain }, // SAMPLE has ai_directed_text: true, so adopt/trial is capped
      repo: { full_name: 'gitroomhq/postiz-app', license: 'AGPL-3.0' },
    });
    expect(r.body.fit).toBeUndefined();
  });

  it('adds a personal fit when a GitHub username is connected', async () => {
    stubGitHub({ ...POSTIZ, ...LPSMURF });
    setup();
    create
      .mockResolvedValueOnce(jsonReply(SAMPLE))
      .mockResolvedValueOnce(toolReply('fit_check', { fit: 'some', why: 'You build TS tools.', helps: ['x'], first_step: 'Try it.' }));
    const r = await post('clerk', { question: 'gitroomhq/postiz-app', visitorId: vid(), github: 'lpsmurf' });
    expect(r.body.fit).toEqual({ fit: 'some', why: 'You build TS tools.', helps: ['x'], first_step: 'Try it.' });
    expect(create.mock.calls[1][0].model).toBe(HAIKU);
  });

  it('ignores an invalid connected username', async () => {
    stubGitHub(POSTIZ);
    setup();
    create.mockResolvedValue(jsonReply(SAMPLE));
    const r = await post('clerk', { question: 'https://github.com/gitroomhq/postiz-app', visitorId: vid(), github: 'not a user!' });
    expect(r.body.fit).toBeUndefined();
    expect(create).toHaveBeenCalledOnce();
  });

  it('points at the shelf when the repo is already stocked', async () => {
    stubGitHub(POSTIZ);
    setup({ inStore: { slug: 'gh-gitroomhq-postiz-app', kind: 'repo', genre: 'Growth & GTM' } });
    create.mockResolvedValue(jsonReply(SAMPLE));
    const r = await post('clerk', { question: 'https://github.com/gitroomhq/postiz-app', visitorId: vid() });
    expect(r.body).toMatchObject({ in_store: 'gh-gitroomhq-postiz-app', aisle: 'new' });
    expect(r.body.slugs).toContain('gh-gitroomhq-postiz-app');
  });

  it('404s an unknown repo URL', async () => {
    stubGitHub({});
    setup();
    const r = await post('clerk', { question: 'https://github.com/nobody/nothing', visitorId: vid() });
    expect(r.status).toBe(404);
    expect(r.body.error).toBe(CLERK_LINES.noRepo);
  });

  it('treats a bare owner/repo GitHub does not know as a normal question', async () => {
    stubGitHub({});
    const d = setup();
    create.mockResolvedValue(toolReply('recommend', { on_topic: true, answer: 'Try these.', slugs: [], aisle: 'counter' }));
    const r = await post('clerk', { question: 'CI/CD', visitorId: vid() });
    expect(r.body.answer).toBe('Try these.');
    expect(d.calls('rpc:search_tapes')).toHaveLength(1);
  });

  it('answers 500 "on break" when the assessments table cannot be read', async () => {
    stubGitHub(POSTIZ);
    const d = setup();
    d.on('assessments', () => ({ data: null, error: { message: 'relation does not exist' } }));
    const r = await post('clerk', { question: 'https://github.com/gitroomhq/postiz-app', visitorId: vid() });
    expect(r).toEqual({ status: 500, body: { error: 'The clerk is on break.' } });
    expect(create).not.toHaveBeenCalled();
  });

  it('503s when GitHub rate-limits us and nothing is cached', async () => {
    stubGitHub({ '/repos/gitroomhq/postiz-app': 403 });
    setup();
    const r = await post('clerk', { question: 'https://github.com/gitroomhq/postiz-app', visitorId: vid() });
    expect(r.status).toBe(503);
  });

  it('limits a client IP to 5 new assessments an hour', async () => {
    stubGitHub(POSTIZ);
    setup();
    create.mockResolvedValue(jsonReply(SAMPLE));
    const ip = '9.9.9.9';
    const question = 'https://github.com/gitroomhq/postiz-app'; // a bare owner/repo never gets a 429 any more
    for (let i = 0; i < 5; i++) expect((await post('clerk', { question, visitorId: vid() }, ip)).status).toBe(200);
    const r = await post('clerk', { question, visitorId: vid() }, ip);
    expect(r.status).toBe(429);
    expect(r.body.error).toBe(CLERK_LINES.rateLimit);
  });

  it('says so politely when the budget is spent', async () => {
    vi.stubEnv('AI_DAILY_BUDGET_USD', '1');
    stubGitHub(POSTIZ);
    setup({ spent: 3 });
    const r = await post('clerk', { question: 'https://github.com/gitroomhq/postiz-app', visitorId: vid() });
    expect(r.body).toEqual({ answer: CLERK_LINES.budget, slugs: [], aisle: 'counter' });
  });
});

describe('every Anthropic route is budget-gated and metered', () => {
  const usageRoutes = (d: any) => d.calls('ai_usage').filter((q: Query) => has(q, 'insert')).map((q: Query) => q.calls.find((c) => c[0] === 'insert')![1] as any);
  const PROFILE = { ...LPSMURF, ...POSTIZ };
  const spentSetup = () => {
    vi.stubEnv('AI_DAILY_BUDGET_USD', '1');
    return setup({ spent: 2 });
  };

  it('/profile records Sonnet usage as route "profile"', async () => {
    stubGitHub(PROFILE);
    const d = setup();
    create.mockResolvedValue(toolReply('profile_radar', { answer: 'Nice shelf.', picks: [], aisle: 'counter' }));
    const r = await post('profile', { github: 'lpsmurf', visitorId: vid() });
    expect(r.status).toBe(200);
    expect(usageRoutes(d)).toMatchObject([{ route: 'profile' }]);
  });

  it('/profile over budget answers 503 with no Anthropic call', async () => {
    stubGitHub(PROFILE);
    spentSetup();
    const r = await post('profile', { github: 'lpsmurf', visitorId: vid() });
    expect(r.status).toBe(503);
    expect(r.body.error).toBe(CLERK_LINES.budgetBusy);
    expect(create).not.toHaveBeenCalled();
  });

  it('/profile fails closed when the spend meter errors', async () => {
    stubGitHub(PROFILE);
    const d = setup();
    d.on('rpc:ai_spend_today', () => ({ data: null, error: { message: 'boom' } }));
    const r = await post('profile', { github: 'lpsmurf', visitorId: vid() });
    expect(r.status).toBe(503);
    expect(create).not.toHaveBeenCalled();
  });

  it('/submit records usage as "submit"; over budget gives 503 and inserts nothing', async () => {
    stubGitHub(POSTIZ);
    const d = setup();
    d.on('tapes', () => ({ data: { id: 1 }, error: null }));
    create.mockResolvedValue(toolReply('review_submission', { genre: 'Dev Workflow', blurb: 'b', ring: 'trial', rating: 4, trust: 'clean' }));
    const body = { title: 'Postiz', url: 'https://github.com/gitroomhq/postiz-app', visitorId: vid() };
    expect((await post('submit', body)).status).toBe(200);
    expect(usageRoutes(d)).toMatchObject([{ route: 'submit' }]);

    create.mockClear();
    const d2 = spentSetup();
    const r = await post('submit', { ...body, visitorId: vid() });
    expect(r.status).toBe(503);
    expect(r.body.error).toBe(CLERK_LINES.budgetBusy);
    expect(create).not.toHaveBeenCalled();
    expect(d2.calls('tapes').some((q: Query) => has(q, 'insert'))).toBe(false);
  });

  it('/propose records usage as "propose"; over budget gives 503 and inserts nothing', async () => {
    const d = setup();
    d.on('proposals', () => ({ data: { id: 1 }, error: null }));
    create.mockResolvedValue(toolReply('screen_proposal', { allowed: true, reason: '', kind: 'idea', genre: 'Dev Workflow', pitch: 'p' }));
    const body = { title: 'A cool idea', pitch: 'pitch', visitorId: 'visitor-propose-1' };
    expect((await post('propose', body)).status).toBe(200);
    expect(usageRoutes(d)).toMatchObject([{ route: 'propose' }]);

    create.mockClear();
    const d2 = spentSetup();
    const r = await post('propose', body);
    expect(r.status).toBe(503);
    expect(create).not.toHaveBeenCalled();
    expect(d2.calls('proposals')).toHaveLength(0);
  });
});

describe('POST radar/refresh', () => {
  const refresh = () =>
    handle(new Request('http://localhost/api/radar/refresh', { method: 'POST', headers: { 'x-cron-secret': 's3cret' } })).then(async (r) => ({
      status: r.status,
      body: (await r.json()) as any,
    }));
  const radarDb = (spent = 0) => {
    const d = setup({ spent });
    d.on('radar_runs', (q: Query) => (has(q, 'insert') ? { data: { id: 7 }, error: null } : { data: null, error: null }));
    return d;
  };

  it('skips the run without inserting a radar_runs row when the budget is spent', async () => {
    vi.stubEnv('CRON_SECRET', 's3cret');
    vi.stubEnv('AI_DAILY_BUDGET_USD', '1');
    const d = radarDb(2);
    expect(await refresh()).toEqual({ status: 200, body: { ok: true, skipped: true, reason: 'budget' } });
    expect(d.calls('radar_runs').some((q: Query) => has(q, 'insert'))).toBe(false);
    expect(create).not.toHaveBeenCalled();
  });

  it('records each review as route "radar"', async () => {
    vi.stubEnv('CRON_SECRET', 's3cret');
    const d = radarDb();
    vi.stubGlobal('fetch', async (u: unknown) =>
      String(u).includes('/search/repositories')
        ? new Response(JSON.stringify({ items: [{ full_name: 'a/b', owner: { login: 'a' }, description: 'd', language: 'TS', stargazers_count: 5, html_url: 'https://github.com/a/b' }] }))
        : new Response('readme'),
    );
    create.mockResolvedValue(toolReply('review_repo', { genre: 'Dev Workflow', blurb: 'b', ring: 'trial', rating: 4 }));
    const r = await refresh();
    expect(r.body).toMatchObject({ ok: true, stocked: 1 });
    const rows = d.calls('ai_usage').filter((q: Query) => has(q, 'insert'));
    expect(rows.map((q: Query) => (q.calls.find((c) => c[0] === 'insert')![1] as any).route)).toEqual(['radar']);
  });
});

describe('rate limits key on the client IP, not the body', () => {
  const ask = (xff: string) => post('clerk', { question: 'a skill for making diagrams', visitorId: vid() }, xff);
  const okReply = () => create.mockResolvedValue(toolReply('recommend', { on_topic: true, answer: 'ok', slugs: [], aisle: 'counter' }));

  it('shares one bucket across different visitorIds from the same IP', async () => {
    setup();
    okReply();
    for (let i = 0; i < 15; i++) expect((await ask('7.7.7.7')).status).toBe(200);
    expect((await ask('7.7.7.7')).status).toBe(429);
    expect((await ask('7.7.7.8')).status).toBe(200);
  });

  it('keys on the last x-forwarded-for hop, so a spoofed first hop does not help', async () => {
    setup();
    okReply();
    for (let i = 0; i < 15; i++) expect((await ask(`1.2.3.${i}, 6.6.6.6`)).status).toBe(200);
    expect((await ask('1.2.3.4,  6.6.6.6 ')).status).toBe(429);
  });

  it('prefers cf-connecting-ip over a spoofed x-forwarded-for', async () => {
    setup();
    okReply();
    const cf = { 'cf-connecting-ip': '8.8.4.4' };
    const askCf = (xff: string) => post('clerk', { question: 'a skill for making diagrams', visitorId: vid() }, xff, cf);
    for (let i = 0; i < 15; i++) expect((await askCf(`3.3.3.${i}`)).status).toBe(200);
    expect((await askCf('4.4.4.4')).status).toBe(429);
  });

  it('falls back to a shared "anon" bucket without the header', async () => {
    setup();
    okReply();
    const bare = () => handle(new Request('http://localhost/api/clerk', { method: 'POST', body: JSON.stringify({ question: 'a skill for diagrams', visitorId: vid() }) }));
    for (let i = 0; i < 15; i++) expect((await bare()).status).toBe(200);
    expect((await bare()).status).toBe(429);
  });
});

describe('bare owner/repo never produces an error response', () => {
  const askOk = () => create.mockResolvedValue(toolReply('recommend', { on_topic: true, answer: 'Try these.', slugs: [], aisle: 'counter' }));

  it('"tcp/ip" with GitHub 404 never reaches the budget or Sonnet and gets an ask-path answer', async () => {
    stubGitHub({});
    const d = setup();
    askOk();
    const r = await post('clerk', { question: 'tcp/ip', visitorId: vid() });
    expect(r).toEqual({ status: 200, body: { answer: 'Try these.', slugs: [], aisle: 'counter' } });
    expect(d.calls('rpc:ai_spend_today')).toHaveLength(1); // the ask path's own check only
    expect(d.calls('ai_usage').filter((q: Query) => has(q, 'select'))).toHaveLength(0);
    expect(create).toHaveBeenCalledOnce();
    expect(create.mock.calls[0][0].model).toBe(HAIKU);
  });

  it('a rate-limited bare ref gets an ask-path answer, not a 429', async () => {
    stubGitHub(POSTIZ);
    setup();
    create.mockResolvedValue(jsonReply(SAMPLE));
    const ip = '5.5.5.5';
    for (let i = 0; i < 5; i++) await post('clerk', { question: 'gitroomhq/postiz-app', visitorId: vid() }, ip);
    askOk();
    const r = await post('clerk', { question: 'gitroomhq/postiz-app', visitorId: vid() }, ip);
    expect(r).toEqual({ status: 200, body: { answer: 'Try these.', slugs: [], aisle: 'counter' } });
  });

  it('an over-budget bare ref gets the free-mode answer, not the budget line', async () => {
    vi.stubEnv('AI_DAILY_BUDGET_USD', '1');
    stubGitHub(POSTIZ);
    setup({ spent: 3 });
    const r = await post('clerk', { question: 'gitroomhq/postiz-app', visitorId: vid() });
    expect(r.status).toBe(200);
    expect(r.body.answer).not.toBe(CLERK_LINES.budget);
    expect(r.body.answer).toBe(CLERK_LINES.free);
  });

  it('a GitHub failure on a bare ref falls through to the ask path', async () => {
    stubGitHub({ '/repos/gitroomhq/postiz-app': 403 });
    setup();
    askOk();
    const r = await post('clerk', { question: 'gitroomhq/postiz-app', visitorId: vid() });
    expect(r).toEqual({ status: 200, body: { answer: 'Try these.', slugs: [], aisle: 'counter' } });
  });

  it('an unreadable assessments table on a bare ref also falls through', async () => {
    stubGitHub(POSTIZ);
    const d = setup();
    d.on('assessments', () => ({ data: null, error: { message: 'boom' } }));
    askOk();
    expect((await post('clerk', { question: 'gitroomhq/postiz-app', visitorId: vid() })).status).toBe(200);
  });

  it('explicit URLs keep their error responses', async () => {
    stubGitHub({ '/repos/gitroomhq/postiz-app': 403 });
    setup();
    expect((await post('clerk', { question: 'https://github.com/gitroomhq/postiz-app', visitorId: vid() })).status).toBe(503);
  });
});
