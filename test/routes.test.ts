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
const post = async (path: string, body: Record<string, unknown>) => {
  const r = await handle(new Request('http://localhost/api/' + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }));
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

  it('503s when GitHub rate-limits us and nothing is cached', async () => {
    stubGitHub({ '/repos/gitroomhq/postiz-app': 403 });
    setup();
    const r = await post('clerk', { question: 'https://github.com/gitroomhq/postiz-app', visitorId: vid() });
    expect(r.status).toBe(503);
  });

  it('limits a visitor to 5 new assessments an hour', async () => {
    stubGitHub(POSTIZ);
    setup();
    create.mockResolvedValue(jsonReply(SAMPLE));
    const visitorId = vid();
    for (let i = 0; i < 5; i++) expect((await post('clerk', { question: 'gitroomhq/postiz-app', visitorId })).status).toBe(200);
    const r = await post('clerk', { question: 'gitroomhq/postiz-app', visitorId });
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
