import { beforeEach, describe, expect, it, vi } from 'vitest';
import { arg, fakeDb, has, usageTable, type Query } from './helpers/fakeDb.ts';
import { facts as makeFacts, SAMPLE } from './helpers/samples.ts';

const { create, batches, db, gh } = vi.hoisted(() => ({
  create: vi.fn(),
  batches: { create: vi.fn(), retrieve: vi.fn(), results: vi.fn() },
  db: { current: null as any },
  gh: { gone: new Set<string>(), fail: new Set<string>() },
}));
vi.mock('@anthropic-ai/sdk', () => ({ default: class { messages = { create, batches }; } }));
vi.mock('../lib/admin.ts', () => ({ admin: () => db.current.client }));
vi.mock('../lib/github.ts', async (orig) => {
  const real = await orig<typeof import('../lib/github.ts')>();
  return {
    ...real,
    fetchRepoFacts: async (ref: { full: string }) => {
      if (gh.fail.has(ref.full.toLowerCase())) throw new real.GitHubError(502);
      return gh.gone.has(ref.full.toLowerCase()) ? null : makeFacts({ full_name: ref.full, html_url: `https://github.com/${ref.full}`, readme: `readme of ${ref.full}`, pushed_at: new Date().toISOString() });
    },
  };
});

import { assessParams, assessRepoAI, costUsd, SONNET } from '../lib/ai.ts';
import { healthSignals, PROMPT_VERSION } from '../lib/assess.ts';
import { BATCH_CAP, batchCustomId, collectAssessBatches, submitAssessBatch } from '../lib/batchAssess.ts';
import { jsonReply } from './helpers/anthropic.ts';

const CANDS = [{ slug: 'diagram-design', title: 'Diagram Design', genre: 'Design', blurb: 'b', kind: 'skill', match: true }];
const writes = (d: any, table: string, op: string) => d.calls(table).filter((q: Query) => has(q, op)).map((q: Query) => arg(q, op));

function setup(o: { fresh?: Record<string, unknown>[]; spent?: number; usage?: unknown[] | 'error'; pending?: any[]; insertError?: boolean } = {}) {
  db.current = fakeDb({
    assessments: (q: Query) => (has(q, 'select') && !has(q, 'upsert') ? { data: o.fresh ?? [], error: null } : { data: null, error: null }),
    'rpc:search_tapes': () => ({ data: CANDS, error: null }),
    'rpc:ai_spend_today': () => ({ data: o.spent ?? 0, error: null }),
    ai_usage: usageTable(o.usage ?? []),
    assess_batches: (q: Query) => {
      if (has(q, 'insert')) return { data: null, error: o.insertError ? { message: 'boom' } : null };
      if (has(q, 'select')) return { data: o.pending ?? [], error: null };
      return { data: null, error: null };
    },
  });
  return db.current;
}

const ok = (repo: string, value: unknown = SAMPLE, u = { input_tokens: 4000, output_tokens: 1000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }) => ({
  custom_id: batchCustomId(repo),
  result: { type: 'succeeded', message: { ...jsonReply(value, u), model: SONNET } },
});
const stream = (items: unknown[]) => (async function* () { for (const i of items) yield i; })();
const ended = { processing_status: 'ended' };

beforeEach(() => {
  create.mockReset();
  batches.create.mockReset().mockResolvedValue({ id: 'msgbatch_1', processing_status: 'in_progress' });
  batches.retrieve.mockReset().mockResolvedValue(ended);
  batches.results.mockReset();
  gh.gone.clear();
  gh.fail.clear();
  vi.unstubAllEnvs();
});

describe('batchCustomId', () => {
  const VALID = /^[a-zA-Z0-9_-]{1,64}$/;
  it('swaps the slash for a double underscore and lowercases', () => {
    expect(batchCustomId('Ann/Tool')).toBe('ann__tool');
  });
  it('always fits the custom_id charset and 64-character limit, and stays distinct', () => {
    const repos = ['a/b.c', 'a/b_c', 'a/b-c', 'a/b.js.c', `owner/${'x'.repeat(100)}`, `owner/${'x'.repeat(99)}y`, 'o/.github'];
    const ids = repos.map(batchCustomId);
    for (const id of ids) expect(id).toMatch(VALID);
    expect(new Set(ids).size).toBe(repos.length);
    expect(batchCustomId(repos[0])).toBe(batchCustomId(repos[0])); // deterministic: collect recomputes it
  });
});

describe('submitAssessBatch', () => {
  it('sends the same request params as the live assessment, one request per repo', async () => {
    setup();
    expect(await submitAssessBatch(['Ann/Tool'])).toBe('msgbatch_1');
    const sent = batches.create.mock.calls[0][0].requests;
    expect(sent).toHaveLength(1);
    expect(sent[0].custom_id).toBe('ann__tool');
    const f = makeFacts({ full_name: 'ann/tool', html_url: 'https://github.com/ann/tool', readme: 'readme of ann/tool', pushed_at: new Date().toISOString() });
    expect(sent[0].params).toEqual(assessParams(f, healthSignals(f), f.readme, CANDS));
    // and that is what the live path puts on the wire
    create.mockResolvedValue(jsonReply(SAMPLE));
    await assessRepoAI(f, healthSignals(f), f.readme, CANDS);
    expect(sent[0].params).toEqual(create.mock.calls[0][0]);
    expect(sent[0].params.output_config.format.type).toBe('json_schema');
    expect(sent[0].params.tool_choice).toBeUndefined();
  });
  it('records the batch in assess_batches', async () => {
    const d = setup();
    await submitAssessBatch(['a/b', 'c/d']);
    expect(writes(d, 'assess_batches', 'insert')).toEqual([{ id: 'msgbatch_1', status: 'submitted', repos: ['a/b', 'c/d'] }]);
  });
  it('skips repos with a fresh assessment at the current prompt version, and submits the rest', async () => {
    setup({
      fresh: [
        { repo: 'a/b', prompt_version: PROMPT_VERSION, updated_at: new Date().toISOString() },
        { repo: 'c/d', prompt_version: PROMPT_VERSION - 1, updated_at: new Date().toISOString() },
        { repo: 'e/f', prompt_version: PROMPT_VERSION, updated_at: new Date(Date.now() - 30 * 864e5).toISOString() },
      ],
    });
    await submitAssessBatch(['a/b', 'c/d', 'e/f']);
    expect(batches.create.mock.calls[0][0].requests.map((r: any) => r.custom_id)).toEqual(['c__d', 'e__f']);
  });
  it('submits nothing when every repo is fresh, and reserves no budget', async () => {
    const d = setup({ fresh: [{ repo: 'a/b', prompt_version: PROMPT_VERSION, updated_at: new Date().toISOString() }] });
    expect(await submitAssessBatch(['a/b'])).toBeNull();
    expect(batches.create).not.toHaveBeenCalled();
    expect(d.calls('ai_usage')).toHaveLength(0);
  });
  it('drops repos GitHub no longer has or cannot read, and bad names, without failing', async () => {
    gh.gone.add('a/gone');
    gh.fail.add('a/flaky');
    setup();
    await submitAssessBatch(['a/gone', 'a/flaky', 'not a repo', 'a/ok', 'A/OK']);
    expect(batches.create.mock.calls[0][0].requests.map((r: any) => r.custom_id)).toEqual(['a__ok']);
  });
  it(`caps a batch at ${BATCH_CAP} repos`, async () => {
    setup();
    await submitAssessBatch(Array.from({ length: 40 }, (_, i) => `o/r${i}`));
    expect(batches.create.mock.calls[0][0].requests).toHaveLength(BATCH_CAP);
  });
  it('reserves half the assess reserve per repo, then releases the placeholder once the batch exists', async () => {
    const d = setup();
    await submitAssessBatch(['a/b', 'c/d']);
    const ins = writes(d, 'ai_usage', 'insert');
    expect(ins).toEqual([expect.objectContaining({ route: 'batch-assess', cost_usd: 0.12 })]); // 2 x 0.06
    expect(d.calls('ai_usage').some((q: Query) => has(q, 'delete'))).toBe(true);
  });
  it('skips the batch when the daily budget is spent', async () => {
    vi.stubEnv('AI_DAILY_BUDGET_USD', '1');
    setup({ spent: 2 });
    expect(await submitAssessBatch(['a/b'])).toBeNull();
    expect(batches.create).not.toHaveBeenCalled();
  });
  it('skips the batch when the batch route has spent its own budget', async () => {
    const d = setup({ usage: [{ id: 1, at: new Date().toISOString(), cost_usd: 1.95, repo: null }] });
    expect(await submitAssessBatch(['a/b'])).toBeNull();
    expect(batches.create).not.toHaveBeenCalled();
    expect(d.calls('ai_usage').some((q: Query) => has(q, 'delete'))).toBe(true); // placeholder released
  });
  it('never throws: an Anthropic failure releases the reservation and returns null', async () => {
    const d = setup();
    batches.create.mockRejectedValue(new Error('anthropic down'));
    await expect(submitAssessBatch(['a/b'])).resolves.toBeNull();
    expect(d.calls('ai_usage').some((q: Query) => has(q, 'delete'))).toBe(true);
    expect(writes(d, 'assess_batches', 'insert')).toHaveLength(0);
  });
});

describe('collectAssessBatches', () => {
  const pending = [{ id: 'msgbatch_1', repos: ['a/b', 'c/d'], status: 'submitted', collected_at: null }];

  it('reads only batches not yet collected', async () => {
    const d = setup();
    await collectAssessBatches();
    expect(has(d.calls('assess_batches')[0], 'is', 'collected_at', null)).toBe(true);
  });
  it('leaves a batch that has not ended alone', async () => {
    const d = setup({ pending });
    batches.retrieve.mockResolvedValue({ processing_status: 'in_progress' });
    await collectAssessBatches();
    expect(batches.results).not.toHaveBeenCalled();
    expect(writes(d, 'assess_batches', 'update')).toHaveLength(0);
  });
  it('caches each result as an assessment, whatever order they arrive in, and marks the row collected', async () => {
    const d = setup({ pending });
    batches.results.mockResolvedValue(stream([ok('c/d', { ...SAMPLE, title: 'second', ai_directed_text: false }), ok('a/b', { ...SAMPLE, title: 'first', ai_directed_text: false })]));
    const out = await collectAssessBatches();
    expect(out).toMatchObject({ batches: 1, cached: 2 });
    const up = writes(d, 'assessments', 'upsert');
    expect(up.map((u: any) => [u.repo, u.data.title])).toEqual([['c/d', 'second'], ['a/b', 'first']]);
    expect(up[0]).toMatchObject({ model: SONNET, prompt_version: PROMPT_VERSION, facts: expect.objectContaining({ full_name: 'c/d', signals: expect.any(Object) }) });
    expect(writes(d, 'assess_batches', 'update')).toEqual([expect.objectContaining({ status: 'ended', collected_at: expect.any(String) })]);
  });
  it('normalizes and clamps like the live path: unknown overlap slugs go, nothing to clamp for a fresh MIT repo', async () => {
    const d = setup({ pending: [{ ...pending[0], repos: ['a/b'] }] });
    batches.results.mockResolvedValue(stream([ok('a/b', { ...SAMPLE, ring: 'adopt', ai_directed_text: false, overlaps: [{ slug: 'ghost', why: 'x' }, { slug: 'diagram-design', why: 'y' }] })]));
    await collectAssessBatches();
    const a = writes(d, 'assessments', 'upsert')[0];
    expect(a.data.overlaps).toEqual([{ slug: 'diagram-design', why: 'y' }]);
    expect(a.data.ring).toBe('adopt'); // MIT, pushed recently: nothing to clamp
  });
  it('records usage per result as route "batch-assess" at half the live price', async () => {
    const d = setup({ pending });
    const u = { input_tokens: 4000, output_tokens: 1000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
    batches.results.mockResolvedValue(stream([ok('a/b', { ...SAMPLE, ai_directed_text: false }, u)]));
    await collectAssessBatches();
    const rows = writes(d, 'ai_usage', 'insert');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ route: 'batch-assess', repo: 'a/b', input_tokens: 4000, output_tokens: 1000 });
    expect(rows[0].cost_usd).toBeCloseTo(costUsd(SONNET, u) / 2, 10);
    expect(rows[0].cost_usd).toBeCloseTo(0.009, 10);
    expect(writes(d, 'assessments', 'upsert')[0].cost_usd).toBeCloseTo(0.009, 10);
  });
  it('logs and skips errored, expired and canceled results, but still collects the rest', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const d = setup({ pending: [{ ...pending[0], repos: ['a/b', 'c/d', 'e/f', 'g/h'] }] });
    batches.results.mockResolvedValue(
      stream([
        { custom_id: 'a__b', result: { type: 'errored', error: { type: 'error', error: { type: 'api_error', message: 'x' } } } },
        { custom_id: 'c__d', result: { type: 'expired' } },
        { custom_id: 'e__f', result: { type: 'canceled' } },
        ok('g/h', { ...SAMPLE, ai_directed_text: false }),
      ]),
    );
    expect(await collectAssessBatches()).toMatchObject({ cached: 1, skipped: 3 });
    expect(writes(d, 'assessments', 'upsert').map((u: any) => u.repo)).toEqual(['g/h']);
    expect(writes(d, 'ai_usage', 'insert')).toHaveLength(1); // nothing billed for the failures
    expect(writes(d, 'assess_batches', 'update')).toHaveLength(1);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
  it('skips an unreadable answer but still records what it cost', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const d = setup({ pending: [{ ...pending[0], repos: ['a/b'] }] });
    batches.results.mockResolvedValue(stream([{ custom_id: 'a__b', result: { type: 'succeeded', message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'not json' }], usage: { input_tokens: 100, output_tokens: 10 }, model: SONNET } } }]));
    expect(await collectAssessBatches()).toMatchObject({ cached: 0, skipped: 1 });
    expect(writes(d, 'assessments', 'upsert')).toHaveLength(0);
    expect(writes(d, 'ai_usage', 'insert')).toHaveLength(1);
  });
  it('ignores a result whose custom_id is not in the batch', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const d = setup({ pending: [{ ...pending[0], repos: ['a/b'] }] });
    batches.results.mockResolvedValue(stream([ok('x/y')]));
    expect(await collectAssessBatches()).toMatchObject({ cached: 0 });
    expect(writes(d, 'assessments', 'upsert')).toHaveLength(0);
  });
  it('is idempotent: a collected batch is never read again', async () => {
    const d = setup({ pending });
    batches.results.mockResolvedValue(stream([ok('a/b', { ...SAMPLE, ai_directed_text: false })]));
    await collectAssessBatches();
    d.on('assess_batches', (q: Query) => (has(q, 'select') ? { data: [], error: null } : { data: null, error: null })); // the row now has collected_at
    const again = await collectAssessBatches();
    expect(again).toMatchObject({ batches: 0, cached: 0 });
    expect(batches.retrieve).toHaveBeenCalledTimes(1);
  });
  it('keeps a batch pending (not collected) when Anthropic fails, and never throws', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const d = setup({ pending });
    batches.retrieve.mockRejectedValue(new Error('anthropic down'));
    await expect(collectAssessBatches()).resolves.toMatchObject({ cached: 0 });
    expect(writes(d, 'assess_batches', 'update')).toHaveLength(0);
  });
});
