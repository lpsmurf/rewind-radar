import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { arg, fakeDb, has, usageTable, type Query } from './helpers/fakeDb.ts';
import { jsonReply, textReply, toolReply } from './helpers/anthropic.ts';
import { LPSMURF, POSTIZ, searchItem, stubGitHub, stubGitHubAndSearch, stubSearch } from './helpers/github.ts';
import { GitHubError } from '../lib/github.ts';

const { create, db, gh, batch } = vi.hoisted(() => ({ create: vi.fn(), db: { current: null as any }, gh: { real: false }, batch: { submit: vi.fn(), collect: vi.fn() } }));
vi.mock('../lib/batchAssess.ts', () => ({ submitAssessBatch: batch.submit, collectAssessBatches: batch.collect }));
vi.mock('@anthropic-ai/sdk', () => ({ default: class { messages = { create }; } }));
vi.mock('../lib/admin.ts', () => ({ admin: () => db.current.client }));
// The username check is tested in github.test.ts / identity.test.ts; here "ghost*" never exist and "outage*" hits a GitHub outage.
vi.mock('../lib/github.ts', async (orig) => {
  const real = await orig<typeof import('../lib/github.ts')>();
  const fake = (login: string) => (login.startsWith('outage') ? undefined : !login.startsWith('ghost'));
  return {
    ...real,
    // gh.real = true runs the real cache and fetch (see "the username check, end to end")
    peekGithubUser: (login: string) => (gh.real ? real.peekGithubUser(login) : fake(login)),
    githubUserExists: async (login: string) => {
      if (gh.real) return real.githubUserExists(login);
      if (login.startsWith('outage')) throw new real.GitHubError(503);
      return !login.startsWith('ghost');
    },
  };
});

import { handle } from '../lib/routes.ts';
import { CLERK_LINES } from '../lib/clerkGuard.ts';
import { CHAT_LINES } from '../lib/chatGuard.ts';
import { costUsd, HAIKU, PROFILE_SCHEMA, SONNET } from '../lib/ai.ts';
import { PROFILE_RESERVE_USD, profileWorstCaseUsd } from '../lib/assess.ts';
import { githubMember, SAMPLE } from './helpers/samples.ts';

/** A /profile reply: Sonnet structured output is JSON text, closed schema. */
const profileReply = (o: Partial<{ answer: string; repos: unknown[]; skills: unknown[]; aisle: string }> = {}, u?: Parameters<typeof jsonReply>[1]) =>
  jsonReply({ answer: 'ok', repos: [], skills: [], aisle: 'counter', ...o }, u);

const CANDS = [
  { slug: 'diagram-design', title: 'Diagram Design', genre: 'Design', blurb: 'Diagrams as SVG', kind: 'skill', match: true },
  { slug: 'gh-acme-new', title: 'acme/new', genre: 'Dev Workflow', blurb: 'new', kind: 'repo', match: false },
];
let n = 0;
const vid = () => `visitor-${++n}-${Math.random().toString(16).slice(2, 8)}`;
let ips = 0;
/** Each call gets its own client IP unless one is passed: rate limits key on the IP now. */
/** Clerk calls get a fresh light visitor (own username, so its bucket never fills) unless the test sets `github` or a Bearer token. */
let shoppers = 0;
const post = async (path: string, body: Record<string, unknown>, xff: string = `10.0.0.${++ips}`, extra: Record<string, string> = {}) => {
  if ((path === 'clerk' || path === 'chat' || path === 'chat/report') && !('github' in body) && !extra.authorization) body = { ...body, github: `shopper-${++shoppers}` };
  const r = await handle(new Request('http://localhost/api/' + path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': xff, ...extra }, body: JSON.stringify(body) }));
  return { status: r.status, body: (await r.json()) as any };
};

function setup(o: { spent?: number; inStore?: { slug: string; kind: string; genre: string } | null; searchError?: boolean } = {}) {
  db.current = fakeDb({
    'rpc:search_tapes': () => (o.searchError ? { data: null, error: { message: 'missing function' } } : { data: CANDS, error: null }),
    'rpc:ai_spend_today': () => ({ data: o.spent ?? 0, error: null }),
    assessments: () => ({ data: null, error: null }),
    ai_usage: usageTable(),
    // slug lookups answer inStore; /profile asks for repo-like kinds (in) and skills (eq) separately
    tapes: (q: Query) =>
      has(q, 'in', 'slug') ? { data: o.inStore ?? null, error: null }
      : has(q, 'in', 'kind') ? { data: CANDS.filter((c) => c.kind !== 'skill'), error: null }
      : has(q, 'eq', 'kind', 'skill') ? { data: CANDS.filter((c) => c.kind === 'skill'), error: null }
      : { data: CANDS, error: null },
  });
  return db.current;
}

beforeEach(() => {
  gh.real = false;
  create.mockReset();
  create.mockResolvedValue(null); // vitest 3 flags a later mockRejectedValue as an unhandled error unless the mock had an implementation
});

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
    expect(r.body).toEqual({ answer: 'Rent Diagram Design.', slugs: ['diagram-design'], aisle: 'Design', github: [] });
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

describe('POST /clerk: store first, then GitHub', () => {
  const ASKQ = 'something for rag pipelines';
  const strong = (n: number) => Array.from({ length: n }, (_, i) => ({ slug: `rag-${i}`, title: `Rag ${i}`, genre: 'Dev Workflow', blurb: 'rag', kind: 'skill', match: true }));
  const ghItems = () => [searchItem('acme/rag-kit', { stargazers_count: 900 }), searchItem('acme/already', {}), searchItem('zed/vec', { license: null })];
  const reply = (slugs: string[], answer = 'Try these.') => toolReply('recommend', { on_topic: true, answer, slugs, aisle: 'Dev Workflow' });
  const sent = () => String(create.mock.calls[0][0].messages[0].content);

  it('makes no GitHub call when the store has 3 text matches', async () => {
    const d = setup();
    d.on('rpc:search_tapes', () => ({ data: strong(3), error: null }));
    const urls = stubSearch(ghItems());
    create.mockResolvedValue(reply(['rag-0']));
    const r = await post('clerk', { question: ASKQ, visitorId: vid() });
    expect(urls).toHaveLength(0);
    expect(r.body).toEqual({ answer: 'Try these.', slugs: ['rag-0'], aisle: 'Dev Workflow', github: [] });
    expect(sent()).not.toContain('gh:');
  });

  it('with weak matches searches GitHub, skips repos already in the store, and validates the picks', async () => {
    const d = setup();
    d.on('rpc:search_tapes', () => ({ data: strong(1), error: null }));
    d.on('tapes', (q: Query) => (has(q, 'in', 'slug') ? { data: [{ slug: 'gh-acme-already' }], error: null } : { data: [], error: null }));
    const urls = stubSearch(ghItems());
    create.mockResolvedValue(reply(['rag-0', 'gh:acme/rag-kit', 'gh:acme/already', 'gh:evil/invented']));
    const r = await post('clerk', { question: ASKQ, visitorId: vid() });
    expect(urls).toHaveLength(1);
    expect(new URL(urls[0]).searchParams.get('per_page')).toBe('8');
    expect(sent()).toContain('gh:acme/rag-kit | github | TypeScript | acme/rag-kit');
    expect(sent()).toContain('900★, MIT');
    expect(sent()).toContain('gh:zed/vec');
    expect(sent()).toContain('no licence');
    expect(sent()).not.toContain('gh:acme/already'); // in the store: the tape wins
    expect(r.body.slugs).toEqual(['rag-0']);
    expect(r.body.github.map((h: any) => h.full_name)).toEqual(['acme/rag-kit']); // invented and in-store picks dropped
    expect(r.body.github[0]).toMatchObject({ html_url: 'https://github.com/acme/rag-kit', stars: 900, license: 'MIT', language: 'TypeScript' });
    expect(JSON.stringify(create.mock.calls[0][0].system)).toMatch(/Prefer store tapes/);
  });

  it('ignores store "matches" that share only one generic word with a longer question (the live bug)', async () => {
    const d = setup();
    // search_tapes ORs every word, so tapes mentioning just "user" or "building" come back with match=true
    const loose = [
      { slug: 'user-research', title: 'User Research', genre: 'Research', blurb: 'interview users', kind: 'skill', match: true },
      { slug: 'build-checklist', title: 'Build checklist', genre: 'Ops', blurb: 'building releases', kind: 'skill', match: true },
      { slug: 'ux-copy', title: 'UX copy', genre: 'Design', blurb: 'user interface text', kind: 'skill', match: true },
    ];
    d.on('rpc:search_tapes', () => ({ data: loose, error: null }));
    const urls = stubSearch([searchItem('ratatui/ratatui', { stargazers_count: 19000 })]);
    create.mockResolvedValue(reply(['gh:ratatui/ratatui']));
    const r = await post('clerk', { question: 'a rust library for building terminal user interfaces', visitorId: vid() });
    expect(urls).toHaveLength(1);
    expect(r.body.github.map((h: any) => h.full_name)).toEqual(['ratatui/ratatui']);
  });

  it('keeps the total at 5, store tapes first', async () => {
    const d = setup();
    d.on('rpc:search_tapes', () => ({ data: strong(2), error: null }));
    stubSearch(ghItems());
    create.mockResolvedValue(reply(['gh:acme/rag-kit', 'rag-0', 'rag-1', 'gh:zed/vec']));
    const r = await post('clerk', { question: ASKQ, visitorId: vid() });
    expect(r.body.slugs).toEqual(['rag-0', 'rag-1']);
    expect(r.body.github).toHaveLength(2);
  });

  it('answers store-only when GitHub errors', async () => {
    setup();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    stubSearch(403);
    create.mockResolvedValue(reply(['diagram-design']));
    const r = await post('clerk', { question: ASKQ, visitorId: vid() });
    expect(r).toEqual({ status: 200, body: { answer: 'Try these.', slugs: ['diagram-design'], aisle: 'Dev Workflow', github: [] } });
    expect(sent()).not.toContain('gh:');
  });

  it('skips the top-up past 20 searches an hour for one identity, but still answers and records usage', async () => {
    const d = setup();
    d.tokens.tok = githubMember('topup-member');
    const urls = stubSearch(ghItems());
    create.mockResolvedValue(reply(['diagram-design']));
    for (let i = 0; i < 20; i++) {
      await post('clerk', { question: ASKQ, visitorId: vid(), github: undefined }, undefined, { authorization: 'Bearer tok' });
      expect(String(create.mock.calls[i][0].messages[0].content)).toContain('gh:acme/rag-kit');
    }
    const r = await post('clerk', { question: ASKQ, visitorId: vid(), github: undefined }, undefined, { authorization: 'Bearer tok' });
    expect(r.status).toBe(200);
    expect(String(create.mock.calls[20][0].messages[0].content)).not.toContain('gh:');
    expect(urls).toHaveLength(1); // the first ask filled the cache; the 21st never reached it
    expect(d.calls('ai_usage').filter((q: Query) => has(q, 'insert'))).toHaveLength(21);
  });

  it('skips the top-up past 40 an hour for one IP', async () => {
    const d = setup();
    for (const t of ['a', 'b', 'c']) d.tokens[`ip-${t}`] = githubMember(`ipmember-${t}`);
    stubSearch(ghItems());
    create.mockResolvedValue(reply([]));
    const ask = (i: number) => post('clerk', { question: ASKQ, visitorId: vid(), github: undefined }, '172.31.7.7', { authorization: `Bearer ip-${'abc'[i % 3]}` });
    for (let i = 0; i < 41; i++) expect((await ask(i)).status).toBe(200);
    for (let i = 0; i < 40; i++) expect(String(create.mock.calls[i][0].messages[0].content)).toContain('gh:acme/rag-kit');
    expect(String(create.mock.calls[40][0].messages[0].content)).not.toContain('gh:');
  });

  it('records usage as before when GitHub results are offered', async () => {
    const d = setup();
    stubSearch(ghItems());
    create.mockResolvedValue(reply(['gh:acme/rag-kit']));
    await post('clerk', { question: ASKQ, visitorId: vid() });
    expect(d.calls('ai_usage').some((q: Query) => has(q, 'insert'))).toBe(true);
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

  it('takes the fit from the signed-in login, not from the body', async () => {
    stubGitHub({ ...POSTIZ, ...LPSMURF });
    const d = setup();
    d.tokens.tok = githubMember('lpsmurf');
    create
      .mockResolvedValueOnce(jsonReply(SAMPLE))
      .mockResolvedValueOnce(toolReply('fit_check', { fit: 'strong', why: 'Your repos match.', helps: ['x'], first_step: 'Go.' }));
    const r = await post('clerk', { question: 'https://github.com/gitroomhq/postiz-app', visitorId: vid(), github: 'someone-else' }, undefined, { authorization: 'Bearer tok' });
    expect(r.body.fit).toMatchObject({ fit: 'strong' });
    expect(String(create.mock.calls[1][0].messages[0].content)).toContain('lpsmurf');
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

  describe('a recent failed or in-flight assessment of the same repo', () => {
    const busyRows = [{ at: new Date().toISOString(), cost_usd: 0.01, repo: 'gitroomhq/postiz-app', id: 5 }];

    it('503s with the in-character busy line for a pasted URL', async () => {
      stubGitHub(POSTIZ);
      const d = setup();
      d.on('ai_usage', usageTable(busyRows));
      const r = await post('clerk', { question: 'https://github.com/gitroomhq/postiz-app', visitorId: vid() });
      expect(r).toEqual({ status: 503, body: { error: CLERK_LINES.busy } });
      expect(create).not.toHaveBeenCalled();
    });

    it('falls through to the ask path for a bare owner/repo', async () => {
      stubGitHub(POSTIZ);
      const d = setup();
      d.on('ai_usage', usageTable(busyRows));
      create.mockResolvedValue(toolReply('recommend', { on_topic: true, answer: 'Try these.', slugs: [], aisle: 'counter' }));
      const r = await post('clerk', { question: 'gitroomhq/postiz-app', visitorId: vid() });
      expect(r).toEqual({ status: 200, body: { answer: 'Try these.', slugs: [], aisle: 'counter', github: [] } });
      expect(create.mock.calls[0][0].model).toBe(HAIKU);
    });
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

  it('a budget-refused request leaves the IP\'s 5 assessment slots intact', async () => {
    vi.stubEnv('AI_DAILY_BUDGET_USD', '1');
    stubGitHub(POSTIZ);
    const question = 'https://github.com/gitroomhq/postiz-app';
    const ip = '4.3.2.1';
    setup({ spent: 3 });
    for (let i = 0; i < 6; i++) expect((await post('clerk', { question, visitorId: vid() }, ip)).body.answer).toBe(CLERK_LINES.budget);
    setup({ spent: 0 });
    create.mockResolvedValue(jsonReply(SAMPLE));
    for (let i = 0; i < 5; i++) expect((await post('clerk', { question, visitorId: vid() }, ip)).status).toBe(200);
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

  it('/profile reserves a "profile" row before the call, then settles it with the real usage', async () => {
    stubGitHub(PROFILE);
    const d = setup();
    let before: string[] = [];
    create.mockImplementation(async () => {
      before = d.calls('ai_usage').map((q: Query) => (has(q, 'insert') ? 'insert' : 'other'));
      return profileReply({ answer: 'Nice shelf.' }, { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 });
    });
    const r = await post('profile', { github: 'lpsmurf', visitorId: vid() });
    expect(r.status).toBe(200);
    expect(before).toEqual(['insert', 'other']);
    expect(usageRoutes(d)).toMatchObject([{ route: 'profile', cost_usd: PROFILE_RESERVE_USD }]);
    const upd = d.calls('ai_usage').filter((q: Query) => has(q, 'update'));
    expect(upd).toHaveLength(1);
    expect(arg(upd[0], 'update')).toMatchObject({ input_tokens: 1000, output_tokens: 200 });
  });

  it('/profile reserves at least the worst case of its real prompt caps (profile 6k + store 40k + skills 40k + hits, 3 chars/token) and max_tokens 1500', async () => {
    stubGitHub(PROFILE);
    const d = setup();
    create.mockResolvedValue(profileReply({ answer: 'ok' }));
    await post('profile', { github: 'lpsmurf', visitorId: vid() });
    const worst = profileWorstCaseUsd();
    expect(worst).toBeGreaterThan(0.07); // the old reserve was too low for the caps
    expect(PROFILE_RESERVE_USD).toBeGreaterThanOrEqual(worst);
    expect(usageRoutes(d)[0].cost_usd).toBeGreaterThanOrEqual(worst);
  });

  it('/profile deletes its reservation when the call fails without usage', async () => {
    stubGitHub(PROFILE);
    const d = setup();
    create.mockRejectedValue(new Error('network down'));
    expect((await post('profile', { github: 'lpsmurf', visitorId: vid() })).status).toBe(500);
    expect(d.calls('ai_usage').some((q: Query) => has(q, 'delete'))).toBe(true);
    expect(d.calls('ai_usage').some((q: Query) => has(q, 'update'))).toBe(false);
  });

  it('/profile over the cap deletes its reservation; a failing reservation insert is refused', async () => {
    stubGitHub(PROFILE);
    const d = setup();
    d.on('ai_usage', usageTable(Array.from({ length: 30 }, () => ({ at: new Date().toISOString(), cost_usd: 0.01 }))));
    expect((await post('profile', { github: 'lpsmurf', visitorId: vid() })).status).toBe(503);
    expect(d.calls('ai_usage').some((q: Query) => has(q, 'delete'))).toBe(true);
    d.on('ai_usage', usageTable([], { insertError: true }));
    expect((await post('profile', { github: 'lpsmurf', visitorId: vid() })).status).toBe(503);
    expect(create).not.toHaveBeenCalled();
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

  describe('/profile database caps', () => {
    const rows = (n: number, cost = 0.01) => Array.from({ length: n }, () => ({ at: new Date().toISOString(), cost_usd: cost }));
    const withUsage = (r: unknown) => {
      const d = setup();
      d.on('ai_usage', usageTable(r as any));
      return d;
    };
    const scan = () => post('profile', { github: 'lpsmurf', visitorId: vid() });

    it('503s once AI_PROFILE_MAX_PER_HOUR scans ran this hour (default 30)', async () => {
      stubGitHub(PROFILE);
      const d = withUsage(rows(30));
      const r = await scan();
      expect(r.status).toBe(503);
      expect(r.body.error).toBe(CLERK_LINES.budgetBusy);
      expect(create).not.toHaveBeenCalled();
      expect(has(d.calls('ai_usage').find((q: Query) => has(q, 'select') && !has(q, 'insert'))!, 'eq', 'route', 'profile')).toBe(true);
    });

    it('503s once today\'s profile spend reaches AI_PROFILE_BUDGET_USD (default 1)', async () => {
      stubGitHub(PROFILE);
      withUsage(rows(2, 0.6));
      expect((await scan()).status).toBe(503);
      expect(create).not.toHaveBeenCalled();
    });

    it('fails closed when the usage query errors', async () => {
      stubGitHub(PROFILE);
      withUsage('error');
      expect((await scan()).status).toBe(503);
      expect(create).not.toHaveBeenCalled();
    });

    it('lets a scan through under the caps', async () => {
      stubGitHub(PROFILE);
      withUsage(rows(3));
      create.mockResolvedValue(profileReply({ answer: 'ok' }));
      expect((await scan()).status).toBe(200);
    });
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

describe('POST /profile: repos first, then skills; store first, GitHub tops up', () => {
  const FOUND = () => [
    searchItem('lpsmurf/rewind-radar'), // the visitor's own
    searchItem('lpsmurf/other-thing'), // also theirs
    searchItem('acme/already'), // in the store
    searchItem('acme/agent-kit', { stargazers_count: 1500 }),
    searchItem('zed/mcp-box', { license: { spdx_id: 'AGPL-3.0' } }),
  ];
  const scan = () => post('profile', { github: 'lpsmurf', visitorId: vid() });
  const sent = () => String(create.mock.calls[0][0].messages[0].content);
  const usageRoutes = (d: any) => d.calls('ai_usage').filter((q: Query) => has(q, 'insert'));

  function ready(items: unknown[] | number = FOUND()) {
    const d = setup();
    d.on('tapes', (q: Query) =>
      has(q, 'in', 'slug') ? { data: [{ slug: 'gh-acme-already' }], error: null }
      : has(q, 'in', 'kind') ? { data: CANDS.filter((c) => c.kind !== 'skill'), error: null }
      : { data: CANDS.filter((c) => c.kind === 'skill'), error: null });
    const urls = stubGitHubAndSearch({ ...LPSMURF }, items);
    return { d, urls };
  }

  it('asks Sonnet through structured output with the closed schema, no tools', async () => {
    ready();
    create.mockResolvedValue(profileReply());
    await scan();
    const req = create.mock.calls[0][0];
    expect(req.model).toBe(SONNET);
    expect(req.tools).toBeUndefined();
    expect(req.tool_choice).toBeUndefined();
    expect(req.output_config.format).toEqual({ type: 'json_schema', schema: PROFILE_SCHEMA });
    expect(Object.keys(PROFILE_SCHEMA.properties)).toEqual(['answer', 'repos', 'skills', 'aisle']);
    const closed = (n: any): void => {
      if (n && typeof n === 'object') {
        if (n.type === 'object') {
          expect(n.additionalProperties).toBe(false);
          expect([...n.required].sort()).toEqual(Object.keys(n.properties).sort());
        }
        for (const k of ['minItems', 'maxItems', 'minimum', 'maximum', 'pattern']) expect(n).not.toHaveProperty(k);
        Object.values(n).forEach(closed);
      }
    };
    closed(PROFILE_SCHEMA);
  });

  it('searches GitHub from the profile (top language + topics), at most 2 queries of 10', async () => {
    const { urls } = ready();
    create.mockResolvedValue(profileReply());
    await scan();
    expect(urls.length).toBeGreaterThanOrEqual(1);
    expect(urls.length).toBeLessThanOrEqual(2);
    for (const u of urls) {
      expect(new URL(u).searchParams.get('per_page')).toBe('10');
      expect(new URL(u).searchParams.get('q')).toContain('language:HTML'); // the fixture's most common language
    }
    expect(new URL(urls[0]).searchParams.get('q')).toContain('ai-agent');
  });

  it('returns picks (store first), skills and the old slugs; signals come from code', async () => {
    ready();
    create.mockResolvedValue(
      profileReply({
        answer: 'You ship agents.',
        aisle: 'Dev Workflow',
        repos: [
          { id: 'gh:acme/agent-kit', why: 'fills the agent gap' },
          { id: 'gh-acme-new', why: 'fresh and relevant' },
          { id: 'gh:zed/mcp-box', why: 'mcp' },
        ],
        skills: [{ slug: 'diagram-design', why: 'documents it' }],
      }),
    );
    const r = await scan();
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      answer: 'You ship agents.',
      aisle: 'Dev Workflow',
      name: 'lpsmurf',
      kind: 'user',
      skills: [{ slug: 'diagram-design', why: 'documents it' }],
      slugs: ['gh-acme-new', 'diagram-design'],
    });
    expect(r.body.picks.map((p: any) => p.type)).toEqual(['tape', 'github', 'github']); // store first, whatever the model's order
    expect(r.body.picks[0]).toEqual({ type: 'tape', slug: 'gh-acme-new', why: 'fresh and relevant' });
    expect(r.body.picks[1]).toMatchObject({
      type: 'github',
      why: 'fills the agent gap',
      repo: { full_name: 'acme/agent-kit', stars: 1500, license: 'MIT', signals: { licence_kind: 'permissive', stars: 1500, archived: false } },
    });
    expect(r.body.picks[2].repo.signals.licence_kind).toBe('copyleft');
    expect(r.body.picks).toHaveLength(3);
  });

  it('drops every id the model invented, in repos and in skills', async () => {
    ready();
    create.mockResolvedValue(
      profileReply({
        repos: [{ id: 'gh:evil/invented', why: 'x' }, { id: 'diagram-design', why: 'a skill is not a repo' }, { id: 'nope', why: 'x' }, { id: 'gh:lpsmurf/rewind-radar', why: 'own' }],
        skills: [{ slug: 'gh-acme-new', why: 'a repo is not a skill' }, { slug: 'ghost', why: 'x' }],
      }),
    );
    const r = await scan();
    expect(r.body.picks).toEqual([]);
    expect(r.body.skills).toEqual([]);
    expect(r.body.slugs).toEqual([]);
  });

  it('leaves out store tapes made from the visitor\'s own repos, and drops them again if the model picks one', async () => {
    const d = setup();
    const own = [
      { slug: 'gh-lpsmurf-rewind-radar', title: 'lpsmurf/rewind-radar', genre: 'Dev Workflow', blurb: 'mine', kind: 'repo' },
      { slug: 'c-lpsmurf-ax-route', title: 'lpsmurf/ax-route', genre: 'Dev Workflow', blurb: 'mine too', kind: 'community' },
    ];
    d.on('tapes', (q: Query) =>
      has(q, 'in', 'slug') ? { data: [], error: null }
      : has(q, 'in', 'kind') ? { data: [...CANDS.filter((c) => c.kind !== 'skill'), ...own], error: null }
      : { data: CANDS.filter((c) => c.kind === 'skill'), error: null });
    stubGitHubAndSearch({ ...LPSMURF }, []);
    create.mockResolvedValue(profileReply({ repos: [{ id: 'gh-lpsmurf-rewind-radar', why: 'own' }, { id: 'gh-acme-new', why: 'ok' }] }));
    const r = await scan();
    expect(sent()).toContain('gh-acme-new');
    expect(sent()).not.toContain('gh-lpsmurf-rewind-radar');
    expect(sent()).not.toContain('c-lpsmurf-ax-route');
    expect(r.body.picks.map((p: any) => p.slug)).toEqual(['gh-acme-new']);
  });

  it('asks for skills in a fixed order (most rented first, then newest) so the 120 cap is meaningful', async () => {
    const { d } = ready();
    create.mockResolvedValue(profileReply());
    await scan();
    const skillQ = d.calls('tapes').find((q: Query) => has(q, 'eq', 'kind', 'skill'))!;
    const orders = skillQ.calls.filter((c: any[]) => c[0] === 'order');
    expect(orders.map((c: any[]) => c[1])).toEqual(['rentals', 'created_at']);
    expect(orders.map((c: any[]) => c[2].ascending)).toEqual([false, false]);
  });

  it('leaves out the visitor\'s own repos and repos already in the store before the model sees them', async () => {
    ready();
    create.mockResolvedValue(profileReply());
    await scan();
    expect(sent()).toContain('gh:acme/agent-kit');
    expect(sent()).toContain('gh:zed/mcp-box');
    expect(sent()).not.toContain('gh:lpsmurf/');
    expect(sent()).not.toContain('gh:acme/already');
  });

  it('caps GitHub picks at 5 so the store picks stay first', async () => {
    ready(Array.from({ length: 7 }, (_, i) => searchItem(`org/r${i}`)));
    create.mockResolvedValue(profileReply({ repos: Array.from({ length: 7 }, (_, i) => ({ id: `gh:org/r${i}`, why: 'x' })) }));
    const r = await scan();
    expect(r.body.picks).toHaveLength(5);
    expect(r.body.picks.every((p: any) => p.type === 'github')).toBe(true);
  });

  it('answers from the store alone when GitHub errors', async () => {
    ready(503);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    create.mockResolvedValue(profileReply({ repos: [{ id: 'gh-acme-new', why: 'w' }], skills: [{ slug: 'diagram-design', why: 'w' }] }));
    const r = await scan();
    expect(r.status).toBe(200);
    expect(sent()).not.toContain('gh:');
    expect(r.body.picks).toEqual([{ type: 'tape', slug: 'gh-acme-new', why: 'w' }]);
    expect(r.body.slugs).toEqual(['gh-acme-new', 'diagram-design']);
  });

  it('meters the call: a reservation, then settled with the real usage', async () => {
    const { d } = ready();
    create.mockResolvedValue(profileReply({}, { input_tokens: 7000, output_tokens: 300, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }));
    await scan();
    expect(usageRoutes(d)).toHaveLength(1);
    expect(arg(d.calls('ai_usage').find((q: Query) => has(q, 'update'))!, 'update')).toMatchObject({ input_tokens: 7000, output_tokens: 300 });
  });

  it('still settles the cost when the model returns something unreadable', async () => {
    const { d } = ready();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    create.mockResolvedValue(textReply('not json'));
    expect((await scan()).status).toBe(500);
    expect(arg(d.calls('ai_usage').find((q: Query) => has(q, 'update'))!, 'update')).toMatchObject({ input_tokens: 1000 });
    expect(d.calls('ai_usage').some((q: Query) => has(q, 'delete'))).toBe(false);
  });

  it('keeps the budget and cap refusals: no GitHub search and no Anthropic call', async () => {
    vi.stubEnv('AI_DAILY_BUDGET_USD', '1');
    const d = setup({ spent: 2 });
    const urls = stubGitHubAndSearch({ ...LPSMURF }, FOUND());
    expect((await scan()).status).toBe(503);
    d.on('rpc:ai_spend_today', () => ({ data: 0, error: null }));
    d.on('ai_usage', usageTable(Array.from({ length: 30 }, () => ({ at: new Date().toISOString(), cost_usd: 0.01 }))));
    vi.stubEnv('AI_DAILY_BUDGET_USD', '5');
    expect((await scan()).status).toBe(503);
    expect(create).not.toHaveBeenCalled();
    expect(urls).toHaveLength(0);
  });

  it('reads the catalog as repos (newest 250) and skills (120)', async () => {
    const { d } = ready();
    create.mockResolvedValue(profileReply());
    await scan();
    const qs = d.calls('tapes').filter((q: Query) => has(q, 'eq', 'archived', false));
    expect(qs.map((q: Query) => arg(q, 'limit')).sort()).toEqual([120, 250]);
    expect(qs.some((q: Query) => has(q, 'in', 'kind', ['repo', 'community']))).toBe(true);
    expect(qs.some((q: Query) => has(q, 'eq', 'kind', 'skill'))).toBe(true);
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

describe('POST radar/refresh batch pre-assessment', () => {
  const stub = () => {
    vi.stubEnv('CRON_SECRET', 's3cret');
    const d = setup();
    d.on('radar_runs', (q: Query) => (has(q, 'insert') ? { data: { id: 7 }, error: null } : { data: null, error: null }));
    vi.stubGlobal('fetch', async (u: unknown) =>
      String(u).includes('/search/repositories')
        ? new Response(JSON.stringify({ items: [{ full_name: 'A/B', owner: { login: 'a' }, description: 'd', language: 'TS', stargazers_count: 5, html_url: 'https://github.com/A/B' }] }))
        : new Response('readme'),
    );
    create.mockResolvedValue(toolReply('review_repo', { genre: 'Dev Workflow', blurb: 'b', ring: 'trial', rating: 4 }));
  };
  const refresh = () => handle(new Request('http://localhost/api/radar/refresh', { method: 'POST', headers: { 'x-cron-secret': 's3cret' } })).then(async (r) => ({ status: r.status, body: (await r.json()) as any }));
  beforeEach(() => { batch.submit.mockReset().mockResolvedValue('msgbatch_1'); });

  it('submits a batch for the repos it just stocked', async () => {
    stub();
    expect(await refresh()).toMatchObject({ status: 200, body: { ok: true, stocked: 1 } });
    expect(batch.submit).toHaveBeenCalledWith(['a/b']);
  });
  it('does not fail the refresh when the batch cannot be submitted', async () => {
    stub();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    batch.submit.mockRejectedValue(new Error('anthropic down'));
    expect(await refresh()).toMatchObject({ status: 200, body: { ok: true, stocked: 1 } });
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
    const bare = () => handle(new Request('http://localhost/api/clerk', { method: 'POST', body: JSON.stringify({ question: 'a skill for diagrams', visitorId: vid(), github: `anon-user-${++shoppers}` }) }));
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
    expect(r).toEqual({ status: 200, body: { answer: 'Try these.', slugs: [], aisle: 'counter', github: [] } });
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
    expect(r).toEqual({ status: 200, body: { answer: 'Try these.', slugs: [], aisle: 'counter', github: [] } });
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
    expect(r).toEqual({ status: 200, body: { answer: 'Try these.', slugs: [], aisle: 'counter', github: [] } });
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

describe('a broken spend meter fails closed on every Haiku route', () => {
  const meterDown = () => {
    const d = setup();
    d.on('rpc:ai_spend_today', () => ({ data: null, error: { message: 'no such function' } }));
    return d;
  };

  it('/clerk ask answers in search-only free mode, no Anthropic call', async () => {
    meterDown();
    const r = await post('clerk', { question: 'a skill for making diagrams', visitorId: vid() });
    expect(r.body).toEqual({ answer: CLERK_LINES.free, slugs: ['diagram-design'], aisle: 'Design' });
    expect(create).not.toHaveBeenCalled();
  });

  it('/submit answers 503 budgetBusy, no Anthropic call, nothing inserted', async () => {
    stubGitHub(POSTIZ);
    const d = meterDown();
    const r = await post('submit', { title: 'Postiz', url: 'https://github.com/gitroomhq/postiz-app', visitorId: vid() });
    expect(r).toEqual({ status: 503, body: { error: CLERK_LINES.budgetBusy } });
    expect(create).not.toHaveBeenCalled();
    expect(d.calls('tapes').some((q: Query) => has(q, 'insert'))).toBe(false);
  });

  it('/propose answers 503 budgetBusy, no Anthropic call, nothing inserted', async () => {
    const d = meterDown();
    const r = await post('propose', { title: 'A cool idea', pitch: 'pitch', visitorId: 'visitor-propose-2' });
    expect(r).toEqual({ status: 503, body: { error: CLERK_LINES.budgetBusy } });
    expect(create).not.toHaveBeenCalled();
    expect(d.calls('proposals')).toHaveLength(0);
  });

  it('radar/refresh is skipped with reason "budget", no radar_runs row, no Anthropic call', async () => {
    vi.stubEnv('CRON_SECRET', 's3cret');
    const d = meterDown();
    d.on('radar_runs', () => ({ data: { id: 7 }, error: null }));
    const r = await handle(new Request('http://localhost/api/radar/refresh', { method: 'POST', headers: { 'x-cron-secret': 's3cret' } }));
    expect(await r.json()).toEqual({ ok: true, skipped: true, reason: 'budget' });
    expect(d.calls('radar_runs').some((q: Query) => has(q, 'insert'))).toBe(false);
    expect(create).not.toHaveBeenCalled();
  });
});

describe('the clerk is for GitHub visitors only', () => {
  const ASK = 'a skill for making diagrams';
  const bearer = (t: string) => ({ authorization: `Bearer ${t}` });
  const askAs = (github: string, ip?: string) => post('clerk', { question: ASK, visitorId: vid(), github }, ip);

  it('turns a guest away with 401, before junk, Anthropic or the database', async () => {
    const d = setup();
    for (const question of [ASK, '???']) {
      const r = await post('clerk', { question, visitorId: vid(), github: undefined });
      expect(r).toEqual({ status: 401, body: { error: CLERK_LINES.gate, gate: 'github' } });
    }
    expect(create).not.toHaveBeenCalled();
    expect(d.queries).toHaveLength(0);
  });

  it('turns away a malformed username like a guest', async () => {
    setup();
    expect((await askAs('not a user!')).body).toEqual({ error: CLERK_LINES.gate, gate: 'github' });
  });

  it('401s an unknown username with its own line', async () => {
    const d = setup();
    const r = await askAs('ghost-writer');
    expect(r).toEqual({ status: 401, body: { error: CLERK_LINES.gateUnknown, gate: 'github' } });
    expect(CLERK_LINES.gateUnknown).not.toBe(CLERK_LINES.gate);
    expect(create).not.toHaveBeenCalled();
    expect(d.queries).toHaveLength(0);
  });

  it('lets a real username through', async () => {
    setup();
    create.mockResolvedValue(toolReply('recommend', { on_topic: true, answer: 'Rent it.', slugs: [], aisle: 'counter' }));
    expect(await askAs('lpsmurf')).toEqual({ status: 200, body: { answer: 'Rent it.', slugs: [], aisle: 'counter', github: [] } });
  });

  it('fails closed with 503 when GitHub is down and the name is not cached', async () => {
    const d = setup();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const r = await askAs('outage-user');
    expect(r).toEqual({ status: 503, body: { error: CLERK_LINES.gateBusy } });
    expect(create).not.toHaveBeenCalled();
    expect(d.queries).toHaveLength(0);
  });

  it('lets a signed-in GitHub member through with just a token', async () => {
    const d = setup();
    d.tokens.tok = githubMember('octo');
    create.mockResolvedValue(toolReply('recommend', { on_topic: true, answer: 'Rent it.', slugs: [], aisle: 'counter' }));
    const r = await post('clerk', { question: ASK, visitorId: vid(), github: undefined }, undefined, bearer('tok'));
    expect(r.status).toBe(200);
  });

  it('an invalid token alone is a guest', async () => {
    setup();
    const r = await post('clerk', { question: ASK, visitorId: vid(), github: undefined }, undefined, bearer('bad'));
    expect(r.status).toBe(401);
  });

  it('/profile stays open to guests', async () => {
    stubGitHub({ ...LPSMURF, ...POSTIZ });
    setup();
    create.mockResolvedValue(profileReply({ answer: 'ok' }));
    expect((await post('profile', { github: 'lpsmurf', visitorId: vid() })).status).toBe(200);
  });

  describe('limits key on the identity as well as the IP', () => {
    beforeEach(() => {
      setup();
      create.mockResolvedValue(toolReply('recommend', { on_topic: true, answer: 'ok', slugs: [], aisle: 'counter' }));
    });

    it('one username shares 15 questions an hour across different IPs', async () => {
      for (let i = 0; i < 15; i++) expect((await askAs('sharer')).status).toBe(200);
      const r = await askAs('sharer');
      expect(r.status).toBe(429);
      expect((await askAs('SHARER')).status).toBe(429); // case does not matter
      expect((await askAs('someone-new')).status).toBe(200);
    });

    it('a light visitor gets 5 new assessments an hour per username, across IPs', async () => {
      stubGitHub(POSTIZ);
      create.mockResolvedValue(jsonReply(SAMPLE));
      const question = 'https://github.com/gitroomhq/postiz-app';
      for (let i = 0; i < 5; i++) expect((await post('clerk', { question, visitorId: vid(), github: 'assessor' })).status).toBe(200);
      expect((await post('clerk', { question, visitorId: vid(), github: 'assessor' })).status).toBe(429);
    });

    it('a member gets 40 questions an hour, past the light 15, even from one IP', async () => {
      const d = db.current;
      d.tokens.tok = githubMember('octo', 'uid-forty');
      const ip = '7.7.7.7';
      const ask = () => post('clerk', { question: ASK, visitorId: vid(), github: undefined }, ip, bearer('tok'));
      for (let i = 0; i < 40; i++) expect((await ask()).status).toBe(200);
      expect((await ask()).status).toBe(429);
    });

    it('a member gets 10 new assessments an hour', async () => {
      db.current.tokens.tok = githubMember('octo', 'uid-assessor');
      stubGitHub(POSTIZ);
      create.mockResolvedValue(jsonReply(SAMPLE));
      const question = 'https://github.com/gitroomhq/postiz-app';
      const ask = () => post('clerk', { question, visitorId: vid(), github: undefined }, undefined, bearer('tok'));
      for (let i = 0; i < 10; i++) expect((await ask()).status).toBe(200);
      expect((await ask()).status).toBe(429);
    });

    it('members behind one shared NAT do not block each other', async () => {
      const ip = '8.8.4.4';
      for (let i = 0; i < 3; i++) db.current.tokens[`t${i}`] = githubMember(`member${i}`);
      for (let i = 0; i < 3; i++)
        for (let k = 0; k < 15; k++) expect((await post('clerk', { question: ASK, visitorId: vid(), github: undefined }, ip, bearer(`t${i}`))).status).toBe(200);
    });

    it('light visitors still share their IP bucket (15 an hour)', async () => {
      const ip = '6.7.7.7';
      for (let i = 0; i < 15; i++) expect((await askAs(`nat-user-${i}`, ip)).status).toBe(200);
      expect((await askAs('nat-user-last', ip)).status).toBe(429);
    });
  });
});

describe('the username check, end to end (real cache, stubbed fetch)', () => {
  const ASK = '???'; // junk is answered right after the gate, so the per-IP question limit never interferes
  const ok = () => create.mockResolvedValue(toolReply('recommend', { on_topic: true, answer: 'ok', slugs: [], aisle: 'counter' }));
  const askAs = (github: string, ip: string) => post('clerk', { question: ASK, visitorId: vid(), github }, ip);
  beforeEach(() => {
    gh.real = true;
    setup();
    ok();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  it('the 21st fresh username from one IP gets 429 with no GitHub call; the limit is GATE_LOOKUPS_PER_HOUR', async () => {
    const seen = stubGitHub(Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`/users/fresh-${i}`, 200])));
    for (let i = 0; i < 20; i++) expect((await askAs(`fresh-${i}`, '5.5.5.5')).status).toBe(200);
    expect(seen).toHaveLength(20);
    const r = await askAs('fresh-20', '5.5.5.5');
    expect(r).toEqual({ status: 429, body: { error: CLERK_LINES.gateLookups } });
    expect(seen).toHaveLength(20);
    vi.stubEnv('GATE_LOOKUPS_PER_HOUR', '21');
    expect((await askAs('fresh-21', '5.5.5.5')).status).toBe(200);
  });

  it('a cached username still works when its IP is over the lookup limit', async () => {
    stubGitHub({ '/users/regular': 200, ...Object.fromEntries(Array.from({ length: 25 }, (_, i) => [`/users/lk-${i}`, 200])) });
    expect((await askAs('regular', '5.5.6.6')).status).toBe(200);
    for (let i = 0; i < 19; i++) await askAs(`lk-${i}`, '5.5.6.6');
    expect((await askAs('lk-20', '5.5.6.6')).status).toBe(429);
    expect((await askAs('regular', '5.5.6.6')).status).toBe(200);
  });

  it('an outage on an uncached name is 503; a cached hit passes through the same outage', async () => {
    stubGitHub({ '/users/known': 200 });
    expect((await askAs('known', '5.5.7.7')).status).toBe(200);
    stubGitHub({ '/users/known': 503, '/users/newcomer': 503 });
    expect((await askAs('newcomer', '5.5.7.8')).status).toBe(503);
    expect((await askAs('known', '5.5.7.9')).status).toBe(200);
  });

  it('caches an unknown name, so repeating it costs no lookup', async () => {
    const seen = stubGitHub({});
    expect((await askAs('nobody-here', '5.5.8.8')).body.error).toBe(CLERK_LINES.gateUnknown);
    expect((await askAs('nobody-here', '5.5.8.8')).body.error).toBe(CLERK_LINES.gateUnknown);
    expect(seen).toHaveLength(1);
  });
});

describe('a global ceiling on clerk Anthropic calls', () => {
  it('falls back to search-only free mode once CLERK_MAX_PER_HOUR calls were made', async () => {
    vi.stubEnv('CLERK_MAX_PER_HOUR', '3');
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 3 * 3600_000); // earlier tests' calls fall out of the hourly window
    afterEach(() => vi.useRealTimers());
    setup();
    create.mockResolvedValue(toolReply('recommend', { on_topic: true, answer: 'AI answer', slugs: [], aisle: 'counter' }));
    const ask = () => post('clerk', { question: 'a skill for making diagrams', visitorId: vid() });
    for (let i = 0; i < 3; i++) expect((await ask()).body.answer).toBe('AI answer');
    const r = await ask();
    expect(r.body).toEqual({ answer: CLERK_LINES.free, slugs: ['diagram-design'], aisle: 'Design' });
    expect(create).toHaveBeenCalledTimes(3);
  });
});

describe('visitor chat', () => {
  const bearer = (t: string) => ({ authorization: `Bearer ${t}` });
  const KEY = 'visitor-abc.tab-1';
  const insertsOf = (d: any) => d.calls('chat_messages').filter((q: Query) => has(q, 'insert')).map((q: Query) => arg(q, 'insert'));
  const deletesOf = (d: any) => d.calls('chat_messages').filter((q: Query) => has(q, 'delete')).map((q: Query) => q.calls.find((c) => c[0] === 'eq')!.slice(1));
  const sendersOf = (d: any) => d.calls('chat_senders').filter((q: Query) => has(q, 'insert')).map((q: Query) => arg(q, 'insert'));
  const usageOf = (d: any) => d.calls('ai_usage').filter((q: Query) => has(q, 'insert')).map((q: Query) => arg(q, 'insert'));
  const ok = () => create.mockResolvedValue(toolReply('moderate_chat', { allowed: true, reason: '' }));
  const say = (text: string, o: { github?: string; key?: string; ip?: string; headers?: Record<string, string> } = {}) =>
    post('chat', { text, key: o.key ?? KEY, ...(o.github === undefined ? {} : { github: o.github }) }, o.ip, o.headers);

  function chatSetup(o: { spent?: number; chatSpent?: number | 'error' } = {}) {
    const d = setup({ spent: o.spent });
    d.on('rpc:chat_spend_today', () => (o.chatSpent === 'error' ? { data: null, error: { message: 'boom' } } : { data: o.chatSpent ?? 0, error: null }));
    d.on('chat_messages', (q: Query) => {
      if (has(q, 'insert')) return { data: { id: 7, at: '2026-11-05T10:00:00Z', ...arg(q, 'insert') }, error: null };
      return { data: null, error: null };
    });
    return d;
  }

  afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });

  describe('POST /chat', () => {
    it('turns a guest away with 401 before any limit, check, AI call or database call', async () => {
      const d = chatSetup();
      const r = await post('chat', { text: 'hello', key: KEY, github: undefined });
      expect(r).toEqual({ status: 401, body: { error: CHAT_LINES.gate, gate: 'github' } });
      expect((await say('hello', { github: 'ghost-writer' })).status).toBe(401);
      expect((await post('chat', { text: 'hello', key: KEY, github: undefined }, undefined, bearer('bad'))).status).toBe(401);
      expect(create).not.toHaveBeenCalled();
      expect(d.queries).toHaveLength(0);
    });

    it('refuses with 503 when GitHub cannot confirm the name', async () => {
      chatSetup();
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      expect((await say('hello', { github: 'outage-user' })).status).toBe(503);
    });

    it('allows one message per 2 seconds per identity', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      chatSetup();
      ok();
      expect((await say('first', { github: 'cooldown-user' })).status).toBe(200);
      const r = await say('second', { github: 'cooldown-user' });
      expect(r).toEqual({ status: 429, body: { error: CHAT_LINES.slow } });
      expect((await say('someone else', { github: 'other-user' })).status).toBe(200);
      vi.advanceTimersByTime(2100);
      expect((await say('third', { github: 'cooldown-user' })).status).toBe(200);
    });

    it('allows 30 messages per hour per identity', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      chatSetup();
      ok();
      for (let i = 0; i < 30; i++) {
        expect((await say(`message ${i}`, { github: 'chatty-user', ip: '10.9.0.1' })).status).toBe(200);
        vi.advanceTimersByTime(2100);
      }
      expect(await say('one too many', { github: 'chatty-user', ip: '10.9.0.1' })).toEqual({ status: 429, body: { error: CHAT_LINES.limit } });
      vi.advanceTimersByTime(3600_000);
      expect((await say('later', { github: 'chatty-user', ip: '10.9.0.1' })).status).toBe(200);
    });

    it('allows 60 messages per hour per IP, across identities', async () => {
      chatSetup();
      ok();
      for (let i = 0; i < 60; i++) expect((await say(`message ${i}`, { github: `ip-user-${i}`, ip: '10.9.0.2' })).status).toBe(200);
      expect(await say('one too many', { github: 'ip-user-new', ip: '10.9.0.2' })).toEqual({ status: 429, body: { error: CHAT_LINES.limit } });
      expect((await say('other ip', { github: 'ip-user-fresh', ip: '10.9.0.3' })).status).toBe(200);
    });

    it('rejects a message that fails the free checks, without moderation or insert', async () => {
      const d = chatSetup();
      const r = await say('buy at https://evil.example/x');
      expect(r).toEqual({ status: 422, body: { error: CHAT_LINES.link } });
      expect((await say('12345')).status).toBe(422);
      expect(create).not.toHaveBeenCalled();
      expect(insertsOf(d)).toHaveLength(0);
      expect(usageOf(d)).toHaveLength(0);
    });

    it('does not post a message the moderator blocks (and still records what the call cost)', async () => {
      const d = chatSetup();
      create.mockResolvedValue(toolReply('moderate_chat', { allowed: false, reason: 'abuse' }));
      const r = await say('you are all losers');
      expect(r).toEqual({ status: 422, body: { error: CHAT_LINES.moderated } });
      expect(insertsOf(d)).toHaveLength(0);
      expect(usageOf(d)).toMatchObject([{ route: 'chat', model: HAIKU }]);
    });

    it('posts an allowed message as the identity, with only the public fields stored and returned', async () => {
      const d = chatSetup();
      ok();
      const r = await say('  hello   world ', { github: 'lpsmurf', key: 'k'.repeat(120) });
      expect(r.status).toBe(200);
      expect(r.body).toEqual({ id: 7, at: '2026-11-05T10:00:00Z', sender_key: 'k'.repeat(80), login: 'lpsmurf', tier: 'light', body: 'hello world' });
      expect(insertsOf(d)).toEqual([{ sender_key: 'k'.repeat(80), login: 'lpsmurf', tier: 'light', body: 'hello world' }]);
      expect(sendersOf(d)).toEqual([{ message_id: 7, sender_id: 'gh:lpsmurf' }]); // the identity key lives apart from the public row
      expect(d.calls('chat_messages')[0].calls.find((c: any) => c[0] === 'select')?.[1]).toBe('id,at,sender_key,login,tier,body');
      expect(create.mock.calls[0][0].model).toBe(HAIKU);
      expect(create.mock.calls[0][0].messages[0].content).toContain('hello world');
    });

    it('records the moderation call as route "chat"', async () => {
      const d = chatSetup();
      ok();
      await say('hello');
      expect(usageOf(d)).toMatchObject([{ route: 'chat', model: HAIKU, input_tokens: 1000, output_tokens: 200 }]);
    });

    it('takes the name from a verified GitHub login, not from the body', async () => {
      const d = chatSetup();
      d.tokens.tok = githubMember('octo');
      ok();
      const r = await post('chat', { text: 'hi there', key: KEY, github: 'someone-else' }, undefined, bearer('tok'));
      expect(r.status).toBe(200);
      expect(insertsOf(d)).toEqual([{ sender_key: KEY, login: 'octo', tier: 'member', body: 'hi there' }]);
      expect(sendersOf(d)).toEqual([{ message_id: 7, sender_id: 'm:uid-octo' }]);
    });

    // Flipped on purpose: this used to post on the free checks alone when the budget ran out. That meant a
    // spam wave could drain the budget and then post unmoderated, so moderation now never switches off:
    // chat has its own daily budget, and without it (or without a working meter) nothing is posted.
    it('over the chat budget it rests: 503, nothing posted, no moderation call', async () => {
      const d = chatSetup({ chatSpent: 0.5 });
      const r = await say('hello from the free tier');
      expect(r).toEqual({ status: 503, body: { error: CHAT_LINES.resting } });
      expect(create).not.toHaveBeenCalled();
      expect(insertsOf(d)).toHaveLength(0);
    });

    it('with a broken chat spend meter it rests too (fails closed)', async () => {
      const d = chatSetup({ chatSpent: 'error' });
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      expect((await say('hello')).status).toBe(503);
      expect(create).not.toHaveBeenCalled();
      expect(insertsOf(d)).toHaveLength(0);
    });

    it('the chat budget is its own: AI_CHAT_BUDGET_USD (default 0.5), and the global budget does not switch chat off', async () => {
      const d = chatSetup({ spent: 99, chatSpent: 0.49 });
      ok();
      expect((await say('hello')).status).toBe(200);
      expect(create).toHaveBeenCalledTimes(1);
      expect(insertsOf(d)).toHaveLength(1);
      vi.stubEnv('AI_CHAT_BUDGET_USD', '0.2');
      expect((await say('hello again', { github: 'budget-two' })).status).toBe(503);
      vi.stubEnv('AI_CHAT_BUDGET_USD', '1');
      expect((await say('hello once more', { github: 'budget-three' })).status).toBe(200);
    });

    it('still applies the free checks when resting (they run first, for free)', async () => {
      chatSetup({ chatSpent: 9 });
      expect((await say('https://evil.example')).status).toBe(422);
    });

    it('answers 503 and posts nothing when moderation throws', async () => {
      const d = chatSetup();
      vi.spyOn(console, 'error').mockImplementation(() => {});
      create.mockRejectedValueOnce(new Error('anthropic down'));
      const r = await say('hello');
      expect(r).toEqual({ status: 503, body: { error: CHAT_LINES.busy } });
      expect(insertsOf(d)).toHaveLength(0);
    });

    it('needs a presence key', async () => {
      const d = chatSetup();
      expect((await say('hello', { key: '' })).status).toBe(400);
      expect(insertsOf(d)).toHaveLength(0);
    });

    it('removes the message again when its sender row cannot be saved', async () => {
      const d = chatSetup();
      d.on('chat_senders', () => ({ data: null, error: { message: 'boom' } }));
      vi.spyOn(console, 'error').mockImplementation(() => {});
      ok();
      expect((await say('hello')).status).toBe(500);
      expect(deletesOf(d)).toEqual([['id', 7]]);
    });

    it('answers 500 when the insert fails', async () => {
      const d = chatSetup();
      d.on('chat_messages', () => ({ data: null, error: { message: 'boom' } }));
      vi.spyOn(console, 'error').mockImplementation(() => {});
      ok();
      expect((await say('hello')).status).toBe(500);
    });
  });

  describe('POST /chat/report', () => {
    const report = (id: unknown, o: { github?: string; ip?: string; headers?: Record<string, string> } = {}) =>
      post('chat/report', { id, ...(o.github === undefined ? {} : { github: o.github }) }, o.ip, o.headers);
    const rpcCalls = (d: any) => d.calls('rpc:report_chat').map((q: Query) => arg(q, 'args'));
    const withRpc = (removed = false) => {
      const d = chatSetup();
      d.on('rpc:report_chat', () => ({ data: removed, error: null }));
      return d;
    };

    it('is closed to guests', async () => {
      const d = withRpc();
      const r = await post('chat/report', { id: 1, github: undefined });
      expect(r).toEqual({ status: 401, body: { error: CHAT_LINES.gate, gate: 'github' } });
      expect(d.queries).toHaveLength(0);
    });

    it('hands the report to the database with the identity key as reporter', async () => {
      const d = withRpc(false);
      const r = await report(5, { github: 'Reporter-A' });
      expect(r).toEqual({ status: 200, body: { ok: true, removed: false } });
      expect(rpcCalls(d)).toEqual([{ p_id: 5, p_reporter: 'gh:reporter-a' }]);
    });

    it('reports a member by user id and tells the client when the message was removed (3rd distinct reporter)', async () => {
      const d = withRpc(true);
      d.tokens.tok = githubMember('octo', 'uid-7');
      const r = await post('chat/report', { id: 5 }, undefined, bearer('tok'));
      expect(r.body).toEqual({ ok: true, removed: true });
      expect(rpcCalls(d)).toEqual([{ p_id: 5, p_reporter: 'm:uid-7' }]);
    });

    it('fails with 500 when the database call fails', async () => {
      const d = chatSetup();
      d.on('rpc:report_chat', () => ({ data: null, error: { message: 'boom' } }));
      vi.spyOn(console, 'error').mockImplementation(() => {});
      expect((await report(5)).status).toBe(500);
    });

    it('allows 10 reports per hour per identity', async () => {
      withRpc();
      for (let i = 1; i <= 10; i++) expect((await report(i, { github: 'reporter-c', ip: `10.8.${i}.1` })).status).toBe(200);
      expect((await report(11, { github: 'reporter-c', ip: '10.8.99.1' })).status).toBe(429);
    });

    it('allows 10 reports per hour per IP, across identities', async () => {
      withRpc();
      for (let i = 1; i <= 10; i++) expect((await report(i, { github: `ip-reporter-${i}`, ip: '10.8.0.9' })).status).toBe(200);
      expect((await report(11, { github: 'ip-reporter-new', ip: '10.8.0.9' })).status).toBe(429);
      expect((await report(11, { github: 'ip-reporter-new', ip: '10.8.0.10' })).status).toBe(200);
    });

    it('400s a bad id', async () => {
      const d = withRpc();
      expect((await report('abc')).status).toBe(400);
      expect((await report(-1)).status).toBe(400);
      expect(d.calls('rpc:report_chat')).toHaveLength(0);
    });
  });

  describe('POST /chat/delete (admin)', () => {
    const del = (token: string | undefined, id: unknown = 5) =>
      post('chat/delete', { id }, undefined, token === undefined ? {} : { 'x-admin-token': token });

    it('deletes the message for the right token', async () => {
      vi.stubEnv('ADMIN_TOKEN', 'sesame-open-sesame-open-sesame-open');
      const d = chatSetup();
      expect((await del('sesame-open-sesame-open-sesame-open')).status).toBe(200);
      expect(deletesOf(d)).toEqual([['id', 5]]); // a hard delete, so Realtime tells everyone
    });

    it('refuses a wrong token and a missing token', async () => {
      vi.stubEnv('ADMIN_TOKEN', 'sesame-open-sesame-open-sesame-open');
      const d = chatSetup();
      expect((await del('sesame-closed')).status).toBe(403);
      expect((await del('sesame')).status).toBe(403);
      expect((await del('')).status).toBe(403);
      expect((await del(undefined)).status).toBe(403);
      expect(deletesOf(d)).toHaveLength(0);
    });

    it('is always forbidden when ADMIN_TOKEN is not set', async () => {
      vi.stubEnv('ADMIN_TOKEN', '');
      const d = chatSetup();
      expect((await del('')).status).toBe(403);
      expect((await del('undefined')).status).toBe(403);
      expect((await del(undefined)).status).toBe(403);
      expect(deletesOf(d)).toHaveLength(0);
    });

    it('allows 20 attempts per hour per IP, wrong tokens included (so guessing is slow)', async () => {
      vi.stubEnv('ADMIN_TOKEN', 'sesame-open-sesame-open-sesame-open');
      chatSetup();
      const at = (ip: string, token: string) => post('chat/delete', { id: 5 }, ip, { 'x-admin-token': token });
      for (let i = 0; i < 20; i++) expect((await at('10.7.0.1', 'wrong')).status).toBe(403);
      expect((await at('10.7.0.1', 'sesame-open-sesame-open-sesame-open')).status).toBe(429);
      expect((await at('10.7.0.2', 'sesame-open-sesame-open-sesame-open')).status).toBe(200);
    });

    it('400s a bad id', async () => {
      vi.stubEnv('ADMIN_TOKEN', 'sesame-open-sesame-open-sesame-open');
      chatSetup();
      expect((await del('sesame-open-sesame-open-sesame-open', 'x')).status).toBe(400);
    });
  });
});
