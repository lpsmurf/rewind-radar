import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { arg, fakeDb, has, type Query } from './helpers/fakeDb.ts';
import { jsonReply } from './helpers/anthropic.ts';
import { POSTIZ, stubGitHub } from './helpers/github.ts';

const { create, db } = vi.hoisted(() => ({ create: vi.fn(), db: { current: null as any } }));
vi.mock('@anthropic-ai/sdk', () => ({ default: class { messages = { create }; } }));
vi.mock('../lib/admin.ts', () => ({ admin: () => db.current.client }));

import { BudgetError, getAssessment, PROMPT_VERSION, RateLimitError } from '../lib/assess.ts';
import { parseRepoRef } from '../lib/github.ts';
import { SONNET } from '../lib/ai.ts';
import { SAMPLE } from './helpers/samples.ts';

const ref = parseRepoRef('https://github.com/gitroomhq/postiz-app')!;
const allow = { allowMiss: () => true };
const CANDS = [{ slug: 'diagram-design', title: 'Diagram Design', genre: 'Design', blurb: 'b', kind: 'skill', match: true }];

function setup(row: Record<string, unknown> | null, spent = 0) {
  db.current = fakeDb({
    assessments: (q: Query) => (has(q, 'select') && !has(q, 'upsert') ? { data: row, error: null } : { data: null, error: null }),
    'rpc:search_tapes': () => ({ data: CANDS, error: null }),
    'rpc:ai_spend_today': () => ({ data: spent, error: null }),
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
