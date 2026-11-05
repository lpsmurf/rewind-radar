import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { arg, fakeDb, has, usageTable, type Query } from './helpers/fakeDb.ts';
import { jsonReply, textReply } from './helpers/anthropic.ts';
import { LPSMURF, POSTIZ, stubGitHub } from './helpers/github.ts';

const { create, db } = vi.hoisted(() => ({ create: vi.fn(), db: { current: null as any } }));
vi.mock('@anthropic-ai/sdk', () => ({ default: class { messages = { create }; } }));
vi.mock('../lib/admin.ts', () => ({ admin: () => db.current.client }));

import { budgetLeft, BudgetError, BusyError, getAssessment, personalFit, PROMPT_VERSION, RateLimitError } from '../lib/assess.ts';
import { clearRepoExistsCache, parseRepoRef, repoExists } from '../lib/github.ts';
import { AssessError, costUsd, SONNET } from '../lib/ai.ts';
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
    ai_usage: usageTable(usage),
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
    const usage = arg(d.calls('ai_usage').find((q: Query) => has(q, 'update'))!, 'update');
    expect(usage).toMatchObject({ input_tokens: 3000, output_tokens: 900 });
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
    expect(d.calls('ai_usage').filter((q: Query) => has(q, 'insert'))).toHaveLength(1); // the reservation
    const upd = d.calls('ai_usage').filter((q: Query) => has(q, 'update'));
    expect(upd).toHaveLength(1);
    expect(arg(upd[0], 'update')).toMatchObject({ input_tokens: 1000, output_tokens: 200 });
    expect(arg(upd[0], 'update').cost_usd).toBeGreaterThan(0);
  });

  it('meters a failed refresh and still serves the stale row', async () => {
    stubGitHub(POSTIZ);
    const d = setup(row({ updated_at: daysAgo(8) }));
    create.mockResolvedValue(textReply('', 'refusal'));
    expect(await getAssessment(ref, allow)).toMatchObject({ cached: true, stale: true });
    expect(d.calls('ai_usage').filter((q: Query) => has(q, 'insert'))).toHaveLength(1);
  });

  it('still serves the stale row when pricing a refused call throws (the estimate stays on the reservation)', async () => {
    stubGitHub(POSTIZ);
    const d = setup(row({ updated_at: daysAgo(8) }));
    const bad = { get input_tokens(): number { throw new Error('bad usage'); }, output_tokens: 1 };
    create.mockResolvedValue({ stop_reason: 'refusal', content: [], usage: bad });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await getAssessment(ref, allow)).toMatchObject({ cached: true, stale: true });
    expect(d.calls('ai_usage').some((q: Query) => has(q, 'update') || has(q, 'delete'))).toBe(false); // placeholder left as is
    warn.mockRestore();
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
    const q = d.calls('ai_usage').find((x: Query) => has(x, 'select') && !has(x, 'insert'))!;
    expect(arg(q, 'select')).toBe('id,at,cost_usd,repo');
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

  it('budgetLeft fails closed when the meter errors or throws', async () => {
    for (const how of ['error', 'throw'] as const) {
      setup(null);
      meterDown(how);
      expect(await budgetLeft()).toBe(false);
    }
  });

  it('personalFit returns null without calling Anthropic when the meter is broken', async () => {
    stubGitHub(LPSMURF);
    const d = setup(null);
    meterDown('error');
    expect(await personalFit(SAMPLE as any, 'gitroomhq/postiz-app', 'lpsmurf')).toBeNull();
    expect(create).not.toHaveBeenCalled();
    expect(d.calls('ai_usage')).toHaveLength(0);
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

  it('does not consume the per-IP slot when the database caps refuse (only the non-consuming peek runs)', async () => {
    vi.stubEnv('AI_ASSESS_MAX_PER_HOUR', '1');
    const allowMiss = vi.fn((_dry?: boolean) => true);
    setup(null, 0, [{ at: new Date().toISOString(), cost_usd: 0.01 }]);
    await expect(getAssessment(ref, { allowMiss })).rejects.toBeInstanceOf(RateLimitError);
    expect(allowMiss.mock.calls.filter(([dry]) => !dry)).toHaveLength(0);
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

describe('reserve before calling Sonnet', () => {
  const kinds = (d: any) => d.calls('ai_usage').map((q: Query) => (has(q, 'insert') ? 'insert' : has(q, 'update') ? 'update' : has(q, 'delete') ? 'delete' : 'select'));
  const at = (minsAgo: number) => ({ at: new Date(Date.now() - minsAgo * 60_000).toISOString(), cost_usd: 0.01 });

  it('inserts a placeholder row (id selected, estimated cost) before the Anthropic call', async () => {
    stubGitHub(POSTIZ);
    const d = setup(null);
    let seen: string[] = [];
    let placeholder: any;
    create.mockImplementation(async () => {
      seen = kinds(d);
      placeholder = d.calls('ai_usage').find((q: Query) => has(q, 'insert'));
      return jsonReply(SAMPLE);
    });
    await getAssessment(ref, allow);
    expect(seen).toEqual(['insert', 'select']); // reserved, then the limit query, then the call
    expect(arg(placeholder, 'insert')).toMatchObject({ route: 'assess', repo: 'gitroomhq/postiz-app', cost_usd: 0.12 });
    expect(placeholder.calls.some((c: any) => c[0] === 'select' && c[1] === 'id')).toBe(true);
    expect(placeholder.calls.some((c: any) => c[0] === 'single')).toBe(true);
  });

  it('defaults the estimate to at least the worst case: ~12k input tokens and max_tokens 8000 at Sonnet prices', async () => {
    stubGitHub(POSTIZ);
    const d = setup(null);
    await getAssessment(ref, allow);
    const worst = costUsd(SONNET, { input_tokens: 12_000, output_tokens: 8000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }); // 0.024 + 0.08
    expect(arg(d.calls('ai_usage').find((q: Query) => has(q, 'insert'))!, 'insert').cost_usd).toBeGreaterThanOrEqual(worst);
  });

  it('warns when the real cost exceeds the reservation', async () => {
    stubGitHub(POSTIZ);
    vi.stubEnv('AI_ASSESS_RESERVE_USD', '0.001');
    setup(null);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await getAssessment(ref, allow);
    expect(warn.mock.calls.some((c) => /exceeded the reservation/.test(String(c[0])))).toBe(true);
    warn.mockRestore();
  });

  it('does not warn when the real cost is within the reservation', async () => {
    stubGitHub(POSTIZ);
    setup(null);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await getAssessment(ref, allow);
    expect(warn.mock.calls.some((c) => /exceeded the reservation/.test(String(c[0])))).toBe(false);
    warn.mockRestore();
  });

  it('uses AI_ASSESS_RESERVE_USD for the estimate', async () => {
    stubGitHub(POSTIZ);
    vi.stubEnv('AI_ASSESS_RESERVE_USD', '0.2');
    const d = setup(null);
    await getAssessment(ref, allow);
    expect(arg(d.calls('ai_usage').find((q: Query) => has(q, 'insert'))!, 'insert').cost_usd).toBe(0.2);
  });

  it('deletes the reservation and never calls Sonnet when the hourly cap is hit', async () => {
    vi.stubEnv('AI_ASSESS_MAX_PER_HOUR', '2');
    const d = setup(null, 0, [at(1), at(2)]);
    await expect(getAssessment(ref, allow)).rejects.toBeInstanceOf(RateLimitError);
    expect(kinds(d)).toEqual(['insert', 'select', 'delete']);
    expect(has(d.calls('ai_usage')[2], 'eq', 'id', 900)).toBe(true);
    expect(create).not.toHaveBeenCalled();
  });

  it('deletes the reservation when the reserve itself would pass the assess budget', async () => {
    vi.stubEnv('AI_ASSESS_BUDGET_USD', '0.5');
    const d = setup(null, 0, [{ ...at(5), cost_usd: 0.48 }]); // 0.48 + the 0.12 estimate > 0.5
    await expect(getAssessment(ref, allow)).rejects.toBeInstanceOf(BudgetError);
    expect(kinds(d)).toEqual(['insert', 'select', 'delete']);
    expect(create).not.toHaveBeenCalled();
  });

  it('does not count its own reservation against the caps', async () => {
    stubGitHub(POSTIZ);
    vi.stubEnv('AI_ASSESS_MAX_PER_HOUR', '1');
    setup(null, 0, [{ ...at(1), id: 900 } as any]); // the database returns our own row too
    expect((await getAssessment(ref, allow))!.cached).toBe(false);
  });

  it('settles by updating the reservation with the real tokens and cost; no second insert', async () => {
    stubGitHub(POSTIZ);
    const d = setup(null);
    await getAssessment(ref, allow);
    expect(kinds(d)).toEqual(['insert', 'select', 'update']);
    const upd = d.calls('ai_usage')[2];
    expect(has(upd, 'eq', 'id', 900)).toBe(true);
    expect(arg(upd, 'update')).toMatchObject({ model: SONNET, input_tokens: 3000, output_tokens: 900, cache_read_tokens: 0, cache_write_tokens: 0 });
    expect(arg(upd, 'update').cost_usd).toBeGreaterThan(0);
    expect(arg(upd, 'update').cost_usd).not.toBe(0.12);
  });

  it('deletes the reservation when the call fails without usage (nothing was billed)', async () => {
    stubGitHub(POSTIZ);
    const d = setup(null);
    create.mockRejectedValue(new Error('network down'));
    await expect(getAssessment(ref, allow)).rejects.toThrow('network down');
    expect(kinds(d)).toEqual(['insert', 'select', 'delete']);
  });

  it('deletes the reservation when GitHub has no such repo', async () => {
    stubGitHub({});
    const d = setup(null);
    expect(await getAssessment(parseRepoRef('https://github.com/gitroomhq/postiz-app')!, allow)).toBeNull();
    expect(kinds(d)).toEqual(['insert', 'select', 'delete']);
  });

  it('deletes the reservation when the per-IP slot is lost between peek and take, and serves the stale row', async () => {
    const d = setup(row({ updated_at: daysAgo(8) }));
    // peek says yes, the consuming call says no: another request of the same visitor took the last slot
    expect(await getAssessment(ref, { allowMiss: (dry?: boolean) => !!dry })).toMatchObject({ stale: true });
    expect(kinds(d)).toEqual(['insert', 'select', 'delete']);
  });

  it('makes no reservation at all for a visitor already over the per-IP limit (stale row or RateLimitError)', async () => {
    const d = setup(row({ updated_at: daysAgo(8) }));
    expect(await getAssessment(ref, { allowMiss: () => false })).toMatchObject({ stale: true });
    expect(d.calls('ai_usage')).toHaveLength(0);
    const d2 = setup(null);
    await expect(getAssessment(ref, { allowMiss: () => false })).rejects.toBeInstanceOf(RateLimitError);
    expect(d2.calls('ai_usage')).toHaveLength(0);
  });

  it('peeks before the reservation and consumes the slot only after it succeeded', async () => {
    stubGitHub(POSTIZ);
    const d = setup(null);
    const order: string[] = [];
    const allowMiss = vi.fn((dry?: boolean) => (order.push((dry ? 'peek' : 'take') + ':' + kinds(d).join('+')), true));
    await getAssessment(ref, { allowMiss });
    expect(order).toEqual(['peek:', 'take:insert+select']);
  });

  it('fails closed when the reservation insert errors', async () => {
    const d = setup(null);
    d.on('ai_usage', usageTable([], { insertError: true }));
    await expect(getAssessment(ref, allow)).rejects.toBeInstanceOf(BudgetError);
    expect(create).not.toHaveBeenCalled();
  });

  it('serves the stale row when the reservation insert errors', async () => {
    const d = setup(row({ updated_at: daysAgo(8) }));
    d.on('ai_usage', usageTable([], { insertError: true }));
    expect(await getAssessment(ref, allow)).toMatchObject({ stale: true });
    expect(create).not.toHaveBeenCalled();
  });
});

describe('no repeat of a failed or in-flight assessment for 10 minutes', () => {
  const recent = (minsAgo: number, repo = 'gitroomhq/postiz-app', o: Record<string, unknown> = {}) => ({
    at: new Date(Date.now() - minsAgo * 60_000).toISOString(),
    cost_usd: 0.01,
    repo,
    ...o,
  });

  it('throws BusyError, without calling Sonnet, when the same repo has an assess row from the last 10 minutes', async () => {
    stubGitHub(POSTIZ);
    const d = setup(null, 0, [recent(2)]);
    await expect(getAssessment(ref, allow)).rejects.toBeInstanceOf(BusyError);
    expect(create).not.toHaveBeenCalled();
    expect(d.calls('ai_usage').some((q: Query) => has(q, 'delete'))).toBe(true); // our own reservation is released
  });

  it('serves the stale row instead when there is one', async () => {
    const d = setup(row({ updated_at: daysAgo(8) }), 0, [recent(2)]);
    expect(await getAssessment(ref, allow)).toMatchObject({ cached: true, stale: true });
    expect(create).not.toHaveBeenCalled();
    expect(d.calls('ai_usage').some((q: Query) => has(q, 'delete'))).toBe(true);
  });

  it('assesses normally when the last row is older than 10 minutes', async () => {
    stubGitHub(POSTIZ);
    setup(null, 0, [recent(11)]);
    expect((await getAssessment(ref, allow))!.cached).toBe(false);
  });

  it('is not affected by a recent row for a different repo', async () => {
    stubGitHub(POSTIZ);
    setup(null, 0, [recent(1, 'someone/else')]);
    expect((await getAssessment(ref, allow))!.cached).toBe(false);
  });

  it('does not count its own reservation as a recent assessment', async () => {
    stubGitHub(POSTIZ);
    setup(null, 0, [recent(0, 'gitroomhq/postiz-app', { id: 900 })]); // the database returns our own placeholder too
    expect((await getAssessment(ref, allow))!.cached).toBe(false);
  });

  it('counts an in-flight reservation from another request', async () => {
    setup(null, 0, [recent(0, 'gitroomhq/postiz-app', { id: 12 })]);
    await expect(getAssessment(ref, allow)).rejects.toBeInstanceOf(BusyError);
  });

  it('tie-break: a concurrent first request with a higher id defers to ours (the lowest id proceeds)', async () => {
    stubGitHub(POSTIZ);
    setup(null, 0, [recent(0, 'gitroomhq/postiz-app', { id: 1000 })]); // our placeholder is id 900
    expect((await getAssessment(ref, allow))!.cached).toBe(false);
  });

  it('tie-break: a concurrent request with a lower id wins, ours throws BusyError', async () => {
    setup(null, 0, [recent(0, 'gitroomhq/postiz-app', { id: 899 })]);
    await expect(getAssessment(ref, allow)).rejects.toBeInstanceOf(BusyError);
  });
});
