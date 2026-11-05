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

function setup(o: { fresh?: Record<string, unknown>[]; spent?: number; usage?: unknown[] | 'error'; pending?: any[]; insertError?: boolean; existing?: Record<string, unknown> } = {}) {
  // assess_batches behaves like a table: the atomic claim and the per-result bookkeeping mutate these rows.
  const table = (o.pending ?? []).map((r) => ({ at: '2026-11-01T00:00:00Z', status: 'submitted', done: [] as string[], reserve_ids: [] as number[], collected_at: null as string | null, claimed_at: null as string | null, ...r }));
  const ut = usageTable(o.usage ?? [], { insertError: o.insertError });
  let nid = 100;
  db.current = fakeDb({
    assessments: (q: Query) => (has(q, 'upsert') ? { data: null, error: null } : has(q, 'maybeSingle') ? { data: o.existing ?? null, error: null } : has(q, 'select') ? { data: o.fresh ?? [], error: null } : { data: null, error: null }),
    'rpc:search_tapes': () => ({ data: CANDS, error: null }),
    'rpc:ai_spend_today': () => ({ data: o.spent ?? 0, error: null }),
    ai_usage: (q: Query) => (has(q, 'insert') && has(q, 'select') && !o.insertError ? { data: { id: ++nid }, error: null } : ut(q)),
    assess_batches: (q: Query) => {
      if (has(q, 'insert')) return { data: null, error: o.insertError ? { message: 'boom' } : null };
      if (has(q, 'update')) {
        const id = q.calls.find((c) => c[0] === 'eq' && c[1] === 'id')?.[2];
        const row = table.find((r) => r.id === id);
        const patch = arg(q, 'update');
        if (patch.status === 'collecting') {
          const stale = !!row?.claimed_at && Date.parse(row.claimed_at) < Date.now() - 15 * 60_000;
          if (!row || row.collected_at || (row.status === 'collecting' && !stale)) return { data: null, error: null };
          Object.assign(row, patch);
          return { data: { ...row }, error: null };
        }
        if (row) Object.assign(row, patch);
        return { data: null, error: null };
      }
      if (has(q, 'select')) return { data: table.filter((r) => !r.collected_at).map((r) => ({ ...r })), error: null };
      return { data: null, error: null };
    },
  });
  db.current.batchRows = table;
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
    expect(writes(d, 'assess_batches', 'insert')).toEqual([{ id: 'msgbatch_1', status: 'submitted', repos: ['a/b', 'c/d'], reserve_ids: [101, 102] }]);
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
  it('reserves half the assess reserve per repo and KEEPS the placeholders while the batch is in flight', async () => {
    const d = setup();
    await submitAssessBatch(['a/b', 'c/d']);
    const ins = writes(d, 'ai_usage', 'insert');
    expect(ins).toEqual([
      expect.objectContaining({ route: 'batch-assess', repo: 'a/b', cost_usd: 0.06 }),
      expect.objectContaining({ route: 'batch-assess', repo: 'c/d', cost_usd: 0.06 }),
    ]);
    expect(d.calls('ai_usage').some((q: Query) => has(q, 'delete'))).toBe(false); // in-flight batches count against the daily budget
    expect(writes(d, 'assess_batches', 'insert')[0].reserve_ids).toEqual([101, 102]);
  });
  it('releases the placeholders it already took when a later one does not fit the batch budget', async () => {
    const d = setup();
    let n = 0;
    d.on('ai_usage', (q: Query) => {
      if (has(q, 'insert')) return { data: { id: 200 + ++n }, error: null };
      return { data: n >= 2 ? [{ id: 1, at: new Date().toISOString(), cost_usd: 1.95, repo: null }] : [], error: null };
    });
    expect(await submitAssessBatch(['a/b', 'c/d'])).toBeNull();
    expect(batches.create).not.toHaveBeenCalled();
    const gone = d.calls('ai_usage').filter((q: Query) => has(q, 'delete')).flatMap((q: Query) => {
      const c = q.calls.find((x: any[]) => x[0] === 'in' || x[0] === 'eq')!;
      return c[0] === 'in' ? (c[2] as number[]) : [c[2] as number];
    });
    expect(gone.sort()).toEqual([201, 202]);
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
    expect(d.calls('ai_usage').filter((q: Query) => has(q, 'delete'))).toHaveLength(1);
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
    expect(d.batchRows[0]).toMatchObject({ status: 'submitted', collected_at: null }); // claim released, not collected
  });
  it('caches each result as an assessment, whatever order they arrive in, and marks the row collected', async () => {
    const d = setup({ pending });
    batches.results.mockResolvedValue(stream([ok('c/d', { ...SAMPLE, title: 'second', ai_directed_text: false }), ok('a/b', { ...SAMPLE, title: 'first', ai_directed_text: false })]));
    const out = await collectAssessBatches();
    expect(out).toMatchObject({ batches: 1, cached: 2 });
    const up = writes(d, 'assessments', 'upsert');
    expect(up.map((u: any) => [u.repo, u.data.title])).toEqual([['c/d', 'second'], ['a/b', 'first']]);
    expect(up[0]).toMatchObject({ model: SONNET, prompt_version: PROMPT_VERSION, facts: expect.objectContaining({ full_name: 'c/d', signals: expect.any(Object) }) });
    expect(writes(d, 'assess_batches', 'update').at(-1)).toEqual(expect.objectContaining({ status: 'ended', collected_at: expect.any(String) }));
    expect(d.batchRows[0].done).toEqual(['c__d', 'a__b']);
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
    expect(d.batchRows[0].collected_at).toEqual(expect.any(String)); // permanent failures do not hold the batch open
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
    expect(d.batchRows[0]).toMatchObject({ status: 'submitted', collected_at: null }); // claim given back
  });

  describe('claim, bookkeeping and budget', () => {
    const withIds = [{ id: 'msgbatch_1', repos: ['a/b', 'c/d'], reserve_ids: [11, 12] }];
    const good = (repo: string) => ok(repo, { ...SAMPLE, ai_directed_text: false });

    it('claims a batch atomically before reading it: status collecting, only if not collected and not recently claimed', async () => {
      const d = setup({ pending });
      batches.results.mockResolvedValue(stream([good('a/b'), good('c/d')]));
      await collectAssessBatches();
      const claim = d.calls('assess_batches').find((q: Query) => arg(q, 'update')?.status === 'collecting')!;
      expect(arg(claim, 'update')).toMatchObject({ status: 'collecting', claimed_at: expect.any(String) });
      expect(claim.calls).toContainEqual(['eq', 'id', 'msgbatch_1']);
      expect(has(claim, 'is', 'collected_at', null)).toBe(true);
      expect((claim.calls.find((c: any[]) => c[0] === 'or') as any)[1]).toMatch(/^status\.neq\.collecting,claimed_at\.lt\./);
      expect(claim.calls.some((c: any[]) => c[0] === 'select')).toBe(true);
      expect(d.calls('assess_batches').indexOf(claim)).toBeLessThan(d.calls('assess_batches').findIndex((q: Query) => has(q, 'update') && arg(q, 'update').done));
    });
    it('two concurrent collects cannot both process the batch: one result set, one meter', async () => {
      const d = setup({ pending: withIds });
      batches.results.mockImplementation(async () => stream([good('a/b'), good('c/d')]));
      await Promise.all([collectAssessBatches(), collectAssessBatches()]);
      expect(batches.retrieve).toHaveBeenCalledTimes(1);
      expect(writes(d, 'assessments', 'upsert')).toHaveLength(2);
      expect(d.calls('ai_usage').filter((q: Query) => has(q, 'update'))).toHaveLength(2);
    });
    it('takes over a claim that is older than 15 minutes', async () => {
      const d = setup({ pending: [{ ...withIds[0], status: 'collecting', claimed_at: new Date(Date.now() - 20 * 60_000).toISOString() }] });
      batches.results.mockResolvedValue(stream([good('a/b'), good('c/d')]));
      expect(await collectAssessBatches()).toMatchObject({ batches: 1, cached: 2 });
      expect(d.batchRows[0].collected_at).toEqual(expect.any(String));
    });
    it('leaves a batch alone while someone else holds a fresh claim', async () => {
      setup({ pending: [{ ...withIds[0], status: 'collecting', claimed_at: new Date().toISOString() }] });
      expect(await collectAssessBatches()).toMatchObject({ batches: 0, cached: 0 });
      expect(batches.retrieve).not.toHaveBeenCalled();
    });
    it('a re-collect skips the custom_ids already done: no second upsert, no second meter', async () => {
      const d = setup({ pending: [{ ...withIds[0], done: ['a__b'] }] });
      batches.results.mockResolvedValue(stream([good('a/b'), good('c/d')]));
      expect(await collectAssessBatches()).toMatchObject({ batches: 1, cached: 1 });
      expect(writes(d, 'assessments', 'upsert').map((u: any) => u.repo)).toEqual(['c/d']);
      expect(d.calls('ai_usage').filter((q: Query) => has(q, 'update')).map((q: Query) => q.calls.find((c) => c[0] === 'eq')![2])).toEqual([12]);
    });
    it('a transient GitHub failure leaves that result out of done and the batch uncollected; the next run retries only it', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      const d = setup({ pending: withIds });
      batches.results.mockImplementation(async () => stream([good('a/b'), good('c/d')]));
      gh.fail.add('c/d');
      expect(await collectAssessBatches()).toMatchObject({ batches: 0, cached: 1 });
      expect(d.batchRows[0]).toMatchObject({ done: ['a__b'], collected_at: null, status: 'ended' }); // claim released
      expect(d.calls('ai_usage').some((q: Query) => has(q, 'delete'))).toBe(false); // nothing released while a retry is due
      gh.fail.clear();
      expect(await collectAssessBatches()).toMatchObject({ batches: 1, cached: 1 });
      expect(writes(d, 'assessments', 'upsert').map((u: any) => u.repo)).toEqual(['a/b', 'c/d']);
      expect(d.batchRows[0].done).toEqual(['a__b', 'c__d']);
      expect(d.batchRows[0].collected_at).toEqual(expect.any(String));
    });
    it('a failing cache write is transient too', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      const d = setup({ pending: [{ ...withIds[0], repos: ['a/b'], reserve_ids: [11] }] });
      d.on('assessments', (q: Query) => (has(q, 'upsert') ? { data: null, error: { message: 'down' } } : { data: null, error: null }));
      batches.results.mockImplementation(async () => stream([good('a/b')]));
      await collectAssessBatches();
      expect(d.batchRows[0]).toMatchObject({ done: [], collected_at: null });
    });
    it('keeps a fresher assessment: no upsert when the cached row is newer than the batch, but the result is done and metered', async () => {
      const d = setup({ pending: [{ ...withIds[0], repos: ['a/b'], reserve_ids: [11] }], existing: { updated_at: '2026-11-03T00:00:00Z', hits: 7 } });
      batches.results.mockResolvedValue(stream([good('a/b')]));
      expect(await collectAssessBatches()).toMatchObject({ batches: 1, cached: 0 });
      expect(writes(d, 'assessments', 'upsert')).toHaveLength(0);
      expect(d.batchRows[0].done).toEqual(['a__b']);
      expect(d.calls('ai_usage').filter((q: Query) => has(q, 'update'))).toHaveLength(1);
    });
    it('overwrites an older assessment and never resets its hits to 0', async () => {
      const d = setup({ pending: [{ ...withIds[0], repos: ['a/b'], reserve_ids: [11] }], existing: { updated_at: '2026-10-01T00:00:00Z', hits: 7 } });
      batches.results.mockResolvedValue(stream([good('a/b')]));
      await collectAssessBatches();
      const up = writes(d, 'assessments', 'upsert');
      expect(up).toHaveLength(1);
      expect(up[0]).not.toHaveProperty('hits'); // the column keeps its value on conflict (and defaults to 0 on a new row)
    });
    it('settles each reservation with the real half-price cost instead of adding a second row', async () => {
      const d = setup({ pending: withIds });
      const u = { input_tokens: 4000, output_tokens: 1000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
      batches.results.mockResolvedValue(stream([ok('a/b', { ...SAMPLE, ai_directed_text: false }, u), good('c/d')]));
      await collectAssessBatches();
      expect(writes(d, 'ai_usage', 'insert')).toHaveLength(0);
      const upd = d.calls('ai_usage').filter((q: Query) => has(q, 'update'));
      expect(upd.map((q: Query) => q.calls.find((c) => c[0] === 'eq')![2])).toEqual([11, 12]);
      expect(arg(upd[0], 'update')).toMatchObject({ model: SONNET, input_tokens: 4000, output_tokens: 1000 });
      expect(arg(upd[0], 'update').cost_usd).toBeCloseTo(0.009, 10);
    });
    it('releases the unsettled leftovers at the final collect: failed and missing results', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      const d = setup({ pending: [{ id: 'msgbatch_1', repos: ['a/b', 'c/d', 'e/f'], reserve_ids: [11, 12, 13] }] });
      batches.results.mockResolvedValue(stream([{ custom_id: 'a__b', result: { type: 'expired' } }, good('c/d')])); // e/f never came back
      expect(await collectAssessBatches()).toMatchObject({ batches: 1 });
      const gone = d.calls('ai_usage').filter((q: Query) => has(q, 'delete')).flatMap((q: Query) => {
        const c = q.calls.find((x: any[]) => x[0] === 'eq' || x[0] === 'in')!;
        return c[0] === 'in' ? (c[2] as number[]) : [c[2] as number];
      });
      expect(gone.sort()).toEqual([11, 13]);
      expect(d.calls('ai_usage').filter((q: Query) => has(q, 'update')).map((q: Query) => q.calls.find((c) => c[0] === 'eq')![2])).toEqual([12]);
    });
  });
});
