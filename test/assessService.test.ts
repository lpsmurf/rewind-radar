import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { arg, fakeDb, has, type Query } from './helpers/fakeDb.ts';
import { jsonReply, textReply } from './helpers/anthropic.ts';
import { POSTIZ, stubGitHub } from './helpers/github.ts';

const { create, db } = vi.hoisted(() => ({ create: vi.fn(), db: { current: null as any } }));
vi.mock('@anthropic-ai/sdk', () => ({ default: class { messages = { create }; } }));
vi.mock('../lib/admin.ts', () => ({ admin: () => db.current.client }));

import { budgetLeft, BudgetError, getAssessment, PROMPT_VERSION, RateLimitError } from '../lib/assess.ts';
import { clearRepoExistsCache, parseRepoRef, repoExists } from '../lib/github.ts';
import { AssessError, SONNET } from '../lib/ai.ts';
import { SAMPLE } from './helpers/samples.ts';

const ref = parseRepoRef('https://github.com/gitroomhq/postiz-app')!;
const allow = { allowMiss: () => true };
const CANDS = [{ slug: 'diagram-design', title: 'Diagram Design', genre: 'Design', blurb: 'b', kind: 'skill', match: true }];

type Usage = { at: string; cost_usd: number };
function setup(row: Record<string, unknown> | null, spent = 0, usage: Usage[] | 'error' = [], tape: { slug: string } | null = null) {
  db.current = fakeDb({
    assessments: (q: Query) => (has(q, 'select') && !has(q, 'upsert') ? { data: row, error: null } : { data: null, error: null }),
    'rpc:search_tapes': () => ({ data: CANDS, error: null }),
    'rpc:ai_spend_today': () => ({ data: spent, error: null }),
    tapes: () => ({ data: tape, error: null }),
    ai_usage: (q: Query) =>
      has(q, 'select') ? (usage === 'error' ? { data: null, error: { message: 'boom' } } : { data: usage, error: null }) : { data: null, error: null },
  });
  return db.current;
}
const row = (o: Record<string, unknown> = {}) => ({
  repo: 'gitroomhq/postiz-app',
  data: { ...SAMPLE, ai_directed_text: false },
  facts: { full_name: 'gitroomhq/postiz-app', html_url: 'https://github.com/gitroomhq/postiz-app' },
  model: SONNET,
  prompt_version: PROMPT_VERSION,
  updated_at: new Date().toISOString(),
  hits: 2,
  ...o,
});
const daysAgo = (n: number) => new Date(Date.now() - n * 864e5).toISOString();

beforeEach(() => {
  create.mockReset();
  create.mockResolvedValue(jsonReply(SAMPLE));
});
afterEach(() => vi.useRealTimers());

describe('getAssessment', () => {
  it('serves a fresh cached row without GitHub or Claude', async () => {
    const d = setup(row());
    const r = await getAssessment(ref, allow);
    expect(r).toMatchObject({ cached: true, assessment: { ring: 'trial' } });
    expect(r!.stale).toBeUndefined();
    expect(create).not.toHaveBeenCalled();
    const upd = d.calls('assessments').find((q: Query) => has(q, 'update'))!;
    expect(arg(upd, 'update')).toEqual({ hits: 3 });
  });

  it('looks rows up by lowercased owner/repo', async () => {
    const d = setup(row());
    await getAssessment(parseRepoRef('GitroomHQ/Postiz-App')!, allow);
    expect(has(d.calls('assessments')[0], 'eq', 'repo', 'gitroomhq/postiz-app')).toBe(true);
  });

  it('assesses on a miss, then stores the row and the usage', async () => {
    stubGitHub(POSTIZ);
    const d = setup(null);
    const r = await getAssessment(ref, allow);
    expect(r).toMatchObject({ cached: false, repo: { full_name: 'gitroomhq/postiz-app', license: 'AGPL-3.0' } });
    expect(r!.repo.signals.licence_kind).toBe('copyleft');
    expect(r!.assessment.overlaps).toEqual([{ slug: 'diagram-design', why: 'pairs for posts' }]);
    expect(r!.assessment.ring).toBe('hold'); // SAMPLE.ai_directed_text forces hold
    const up = arg(d.calls('assessments').find((q: Query) => has(q, 'upsert'))!, 'upsert');
    expect(up).toMatchObject({ repo: 'gitroomhq/postiz-app', model: SONNET, prompt_version: PROMPT_VERSION, input_tokens: 3000, output_tokens: 900 });
    expect(up.cost_usd).toBeGreaterThan(0);
    const usage = arg(d.calls('ai_usage').find((q: Query) => has(q, 'insert'))!, 'insert');
    expect(usage).toMatchObject({ route: 'assess', model: SONNET, repo: 'gitroomhq/postiz-app' });
  });

  it('re-assesses an expired row and one from an older prompt version', async () => {
    stubGitHub(POSTIZ);
    setup(row({ updated_at: daysAgo(8) }));
    expect((await getAssessment(ref, allow))!.cached).toBe(false);
    setup(row({ prompt_version: PROMPT_VERSION - 1 }));
    expect((await getAssessment(ref, allow))!.cached).toBe(false);
    expect(create).toHaveBeenCalledTimes(2);
  });

  it('serves the stale row when GitHub fails', async () => {
    stubGitHub({ '/repos/gitroomhq/postiz-app': 403 });
    setup(row({ updated_at: daysAgo(8) }));
    expect(await getAssessment(ref, allow)).toMatchObject({ cached: true, stale: true });
  });

  it.each([
    ['a refusal', textReply('', 'refusal')],
    ['a cut-off answer', textReply('{"title":', 'max_tokens')],
    ['invalid JSON', textReply('not json')],
  ])('meters the tokens of a failed call (%s)', async (_, reply) => {
    stubGitHub(POSTIZ);
    const d = setup(null);
    create.mockResolvedValue(reply);
    await expect(getAssessment(ref, allow)).rejects.toBeInstanceOf(AssessError);
    const ins = d.calls('ai_usage').filter((q: Query) => has(q, 'insert'));
    expect(ins).toHaveLength(1);
    expect(arg(ins[0], 'insert')).toMatchObject({ route: 'assess', model: SONNET, repo: 'gitroomhq/postiz-app', input_tokens: 1000, output_tokens: 200 });
    expect(arg(ins[0], 'insert').cost_usd).toBeGreaterThan(0);
  });

  it('meters a failed refresh and still serves the stale row', async () => {
    stubGitHub(POSTIZ);
    const d = setup(row({ updated_at: daysAgo(8) }));
    create.mockResolvedValue(textReply('', 'refusal'));
    expect(await getAssessment(ref, allow)).toMatchObject({ cached: true, stale: true });
    expect(d.calls('ai_usage').filter((q: Query) => has(q, 'insert'))).toHaveLength(1);
  });

  it('clamps the ring from the repo signals before storing it', async () => {
    const repoBody = JSON.parse(POSTIZ['/repos/gitroomhq/postiz-app'].body);
    stubGitHub({ ...POSTIZ, '/repos/gitroomhq/postiz-app': { body: JSON.stringify({ ...repoBody, archived: true }) } });
    const d = setup(null);
    create.mockResolvedValue(jsonReply({ ...SAMPLE, ring: 'adopt', ai_directed_text: false }));
    const r = await getAssessment(ref, allow);
    expect(r!.assessment.ring).toBe('hold');
    expect(arg(d.calls('assessments').find((q: Query) => has(q, 'upsert'))!, 'upsert').data.ring).toBe('hold');
  });

  it('returns null for a repo GitHub does not have', async () => {
    stubGitHub({});
    setup(null);
    expect(await getAssessment(ref, allow)).toBeNull();
  });

  it('asks allowMiss only on a miss, and stops when it says no', async () => {
    const allowMiss = vi.fn(() => false);
    setup(row());
    await getAssessment(ref, { allowMiss });
    expect(allowMiss).not.toHaveBeenCalled();
    setup(null);
    await expect(getAssessment(ref, { allowMiss })).rejects.toBeInstanceOf(RateLimitError);
  });

  it('stops new assessments once the daily budget is spent', async () => {
    vi.stubEnv('AI_DAILY_BUDGET_USD', '1');
    setup(null, 1.5);
    await expect(getAssessment(ref, allow)).rejects.toBeInstanceOf(BudgetError);
    setup(row({ updated_at: daysAgo(8) }), 1.5);
    expect(await getAssessment(ref, allow)).toMatchObject({ stale: true });
    expect(create).not.toHaveBeenCalled();
  });
});

describe('database-backed assess limits', () => {
  const at = (minsAgo: number) => ({ at: new Date(Date.now() - minsAgo * 60_000).toISOString(), cost_usd: 0.01 });

  it('reads today\'s assess usage rows from ai_usage', async () => {
    stubGitHub(POSTIZ);
    const d = setup(null);
    await getAssessment(ref, allow);
    const q = d.calls('ai_usage').find((x: Query) => has(x, 'select'))!;
    expect(arg(q, 'select')).toBe('at,cost_usd');
    expect(has(q, 'eq', 'route', 'assess')).toBe(true);
    const since = q.calls.find((c: any) => c[0] === 'gte')!;
    expect(since[1]).toBe('at');
    expect(String(since[2])).toBe(new Date().toISOString().slice(0, 10) + 'T00:00:00.000Z');
  });

  it('stops a new Sonnet call once AI_ASSESS_MAX_PER_HOUR assessments ran in the last hour', async () => {
    vi.stubEnv('AI_ASSESS_MAX_PER_HOUR', '3');
    setup(null, 0, [at(1), at(10), at(59), at(120)]);
    await expect(getAssessment(ref, allow)).rejects.toBeInstanceOf(RateLimitError);
    expect(create).not.toHaveBeenCalled();
  });

  it('defaults to 20 an hour', async () => {
    const many = Array.from({ length: 20 }, () => at(5));
    setup(null, 0, many);
    await expect(getAssessment(ref, allow)).rejects.toBeInstanceOf(RateLimitError);
  });

  it('does not count rows older than an hour toward the hourly cap', async () => {
    stubGitHub(POSTIZ);
    vi.stubEnv('AI_ASSESS_MAX_PER_HOUR', '3');
    setup(null, 0, [at(61), at(90), at(120)]);
    expect((await getAssessment(ref, allow))!.cached).toBe(false);
  });

  it('stops new assessments once today\'s assess spend reaches AI_ASSESS_BUDGET_USD', async () => {
    vi.stubEnv('AI_ASSESS_BUDGET_USD', '0.5');
    setup(null, 0, [{ ...at(300), cost_usd: 0.3 }, { ...at(200), cost_usd: 0.25 }]);
    await expect(getAssessment(ref, allow)).rejects.toBeInstanceOf(BudgetError);
    expect(create).not.toHaveBeenCalled();
  });

  it('fails closed when the usage query errors', async () => {
    setup(null, 0, 'error');
    await expect(getAssessment(ref, allow)).rejects.toBeInstanceOf(BudgetError);
    expect(create).not.toHaveBeenCalled();
  });

  it('does not check the database limits for a cached row', async () => {
    const d = setup(row(), 0, 'error');
    expect(await getAssessment(ref, allow)).toMatchObject({ cached: true });
    expect(d.calls('ai_usage')).toHaveLength(0);
  });
});

describe('fail-closed on the Sonnet paths', () => {
  const meterDown = (how: 'error' | 'throw') =>
    db.current.on('rpc:ai_spend_today', () => {
      if (how === 'throw') throw new Error('network');
      return { data: null, error: { message: 'no such function' } };
    });

  it('budgetLeft fails open by default and closed with failClosed', async () => {
    for (const how of ['error', 'throw'] as const) {
      setup(null);
      meterDown(how);
      expect(await budgetLeft()).toBe(true);
      expect(await budgetLeft({ failClosed: true })).toBe(false);
    }
  });

  it('a miss with a broken spend meter is over budget: no GitHub, no Sonnet', async () => {
    stubGitHub(POSTIZ);
    setup(null);
    meterDown('error');
    await expect(getAssessment(ref, allow)).rejects.toBeInstanceOf(BudgetError);
    expect(create).not.toHaveBeenCalled();
  });

  it('an error reading the assessments table throws instead of counting as a miss', async () => {
    stubGitHub(POSTIZ);
    const d = setup(null);
    d.on('assessments', () => ({ data: null, error: { message: 'relation does not exist' } }));
    const err = await getAssessment(ref, allow).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(RateLimitError);
    expect(err).not.toBeInstanceOf(BudgetError);
    expect(create).not.toHaveBeenCalled();
  });
});

describe('bare owner/repo guesses', () => {
  const bare = parseRepoRef('tcp/ip')!;
  const bareP = parseRepoRef('gitroomhq/postiz-app')!;

  it('returns null for a repo that does not exist, before touching quota, budget or Sonnet', async () => {
    stubGitHub({});
    const allowMiss = vi.fn(() => true);
    const d = setup(null);
    expect(await getAssessment(bare, { allowMiss })).toBeNull();
    expect(allowMiss).not.toHaveBeenCalled();
    expect(d.calls('rpc:ai_spend_today')).toHaveLength(0);
    expect(d.calls('ai_usage')).toHaveLength(0);
    expect(create).not.toHaveBeenCalled();
  });

  it('assesses a bare ref once GitHub confirms the repo exists', async () => {
    stubGitHub(POSTIZ);
    setup(null);
    expect(bareP.bare).toBe(true);
    expect(await getAssessment(bareP, allow)).toMatchObject({ cached: false });
  });

  it('skips the existence check when the repo is already a tape', async () => {
    const seen = stubGitHub(POSTIZ);
    const d = setup(null, 0, [], { slug: 'gh-gitroomhq-postiz-app' });
    expect(await getAssessment(bareP, allow)).toMatchObject({ cached: false });
    expect(seen.filter((s) => s.url === 'https://api.github.com/repos/gitroomhq/postiz-app')).toHaveLength(1); // facts only
    const q = d.calls('tapes')[0];
    expect(has(q, 'in', 'slug', ['gh-gitroomhq-postiz-app', 'c-gitroomhq-postiz-app'])).toBe(true);
  });

  it('does not run the existence check for an explicit URL or when a row is cached', async () => {
    const seen = stubGitHub({});
    setup(row());
    await getAssessment(bareP, allow);
    expect(seen).toHaveLength(0);
  });

  it('asks GitHub once for two "tcp/ip" questions (negative cache, case-insensitive)', async () => {
    const seen = stubGitHub({});
    setup(null);
    expect(await getAssessment(bare, allow)).toBeNull();
    expect(await getAssessment(parseRepoRef('TCP/IP')!, allow)).toBeNull();
    expect(seen).toHaveLength(1);
  });

  it('caches hits too, and does not cache GitHub errors', async () => {
    const seen = stubGitHub(POSTIZ);
    expect(await repoExists(bareP)).toBe(true);
    expect(await repoExists(bareP)).toBe(true);
    expect(seen).toHaveLength(1);
    stubGitHub({ '/repos/a/b': 403 });
    const ab = parseRepoRef('a/b')!;
    await expect(repoExists(ab)).rejects.toMatchObject({ status: 403 });
    stubGitHub({ '/repos/a/b': { body: '{}' } });
    expect(await repoExists(ab)).toBe(true);
  });

  it('expires misses after an hour and hits after ten minutes', async () => {
    vi.useFakeTimers();
    const seen = stubGitHub({ '/repos/gitroomhq/postiz-app': { body: '{}' } });
    await repoExists(bare);
    await repoExists(bareP);
    vi.advanceTimersByTime(11 * 60_000);
    await repoExists(bare); // miss still cached
    await repoExists(bareP); // hit expired
    expect(seen).toHaveLength(3);
    vi.advanceTimersByTime(50 * 60_000);
    await repoExists(bare);
    expect(seen).toHaveLength(4);
  });

  it('repoExists: 404 is false, 200 true, anything else throws', async () => {
    stubGitHub({});
    expect(await repoExists(bare)).toBe(false);
    stubGitHub(POSTIZ);
    expect(await repoExists(bareP)).toBe(true);
    clearRepoExistsCache(); // the 200 above is cached now
    stubGitHub({ '/repos/gitroomhq/postiz-app': 403 });
    await expect(repoExists(bareP)).rejects.toMatchObject({ status: 403 });
  });
});

describe('expired row + rate limit', () => {
  it('serves the stale row when allowMiss says no', async () => {
    setup(row({ updated_at: daysAgo(8) }));
    const r = await getAssessment(ref, { allowMiss: () => false });
    expect(r).toMatchObject({ cached: true, stale: true });
    expect(create).not.toHaveBeenCalled();
  });

  it('serves the stale row when the database hourly cap is hit', async () => {
    vi.stubEnv('AI_ASSESS_MAX_PER_HOUR', '1');
    setup(row({ prompt_version: PROMPT_VERSION - 1 }), 0, [{ at: new Date().toISOString(), cost_usd: 0.01 }]);
    expect(await getAssessment(ref, allow)).toMatchObject({ cached: true, stale: true });
    expect(create).not.toHaveBeenCalled();
  });

  it('serves the stale row when the assess budget is spent', async () => {
    vi.stubEnv('AI_ASSESS_BUDGET_USD', '0.1');
    setup(row({ updated_at: daysAgo(8) }), 0, [{ at: new Date().toISOString(), cost_usd: 0.5 }]);
    expect(await getAssessment(ref, allow)).toMatchObject({ stale: true });
  });

  it('still throws RateLimitError when there is no row at all', async () => {
    setup(null);
    await expect(getAssessment(ref, { allowMiss: () => false })).rejects.toBeInstanceOf(RateLimitError);
  });
});

describe('check order: refused requests do not use the per-IP slot', () => {
  it('does not call allowMiss when the daily budget refuses', async () => {
    vi.stubEnv('AI_DAILY_BUDGET_USD', '1');
    const allowMiss = vi.fn(() => true);
    setup(null, 2);
    await expect(getAssessment(ref, { allowMiss })).rejects.toBeInstanceOf(BudgetError);
    expect(allowMiss).not.toHaveBeenCalled();
  });

  it('does not call allowMiss when the database caps refuse', async () => {
    vi.stubEnv('AI_ASSESS_MAX_PER_HOUR', '1');
    const allowMiss = vi.fn(() => true);
    setup(null, 0, [{ at: new Date().toISOString(), cost_usd: 0.01 }]);
    await expect(getAssessment(ref, { allowMiss })).rejects.toBeInstanceOf(RateLimitError);
    expect(allowMiss).not.toHaveBeenCalled();
  });
});

describe('rows served from cache are clamped on read', () => {
  const archived = { archived: true, licence_kind: 'permissive', days_since_push: 3 };
  const adopt = (o: Record<string, unknown> = {}) =>
    row({
      data: { ...SAMPLE, ai_directed_text: false, ring: 'adopt', risks: [] },
      facts: { full_name: 'gitroomhq/postiz-app', html_url: 'x', signals: archived },
      ...o,
    });

  it('caps a fresh row whose stored ring is adopt but whose signals say archived', async () => {
    setup(adopt());
    const r = await getAssessment(ref, allow);
    expect(r!.assessment.ring).toBe('hold');
    expect(r!.assessment.risks[0]).toMatch(/archived/);
  });

  it('caps a stale row too', async () => {
    setup(adopt({ updated_at: daysAgo(8) }), 0);
    const r = await getAssessment(ref, { allowMiss: () => false });
    expect(r).toMatchObject({ stale: true, assessment: { ring: 'hold' } });
  });

  it('leaves rows without stored signals alone', async () => {
    setup(row({ data: { ...SAMPLE, ai_directed_text: false, ring: 'adopt' } }));
    expect((await getAssessment(ref, allow))!.assessment.ring).toBe('adopt');
  });
});

describe('usage is metered once, right after the Sonnet call', () => {
  const inserts = (d: any) => d.calls('ai_usage').filter((q: Query) => has(q, 'insert'));

  it('records exactly one usage row even when the work after the call throws', async () => {
    stubGitHub(POSTIZ);
    const d = setup(null);
    d.on('assessments', (q: Query) => {
      if (has(q, 'upsert')) throw new Error('db down');
      return { data: null, error: null };
    });
    await expect(getAssessment(ref, allow)).rejects.toThrow('db down');
    expect(inserts(d)).toHaveLength(1);
    expect(arg(inserts(d)[0], 'insert')).toMatchObject({ route: 'assess', model: SONNET, repo: 'gitroomhq/postiz-app' });
  });

  it('records exactly one usage row on success', async () => {
    stubGitHub(POSTIZ);
    const d = setup(null);
    await getAssessment(ref, allow);
    expect(inserts(d)).toHaveLength(1);
  });
});
