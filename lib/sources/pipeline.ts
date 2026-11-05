import { admin } from '../admin.ts';
import type { OnUsage } from '../ai.ts';
import { budgetLeft, recordUsage } from '../assess.ts';
import { parseRepoRef, type RepoFacts } from '../github.ts';
import type { Candidate, Source, SourceCtx, SourceSummary } from './types.ts';
import { verifyAll } from './verify.ts';

export interface RunSummary {
  queued: number;
  sources: SourceSummary[];
}

/** Settings from the source_config table; null when the row is missing or the read fails. */
export async function dbConfig(key: string): Promise<unknown> {
  const { data } = await admin().from('source_config').select('value').eq('key', key).maybeSingle();
  return data?.value ?? null;
}

/** A pasted list of links as a source: every GitHub repo found becomes a candidate, anything else is ignored. No AI, no cost. */
export function manualSource(urls: string[]): Source {
  return {
    name: 'manual',
    run: async () => {
      const out: Candidate[] = [];
      for (const u of urls) {
        const ref = parseRepoRef(u);
        if (ref) out.push({ repo: ref.full, kind: 'repo' });
      }
      return out;
    },
  };
}

const slim = (f: RepoFacts) => {
  const { readme: _r, contents: _c, ...rest } = f; // the queue keeps small facts; approval fetches fresh ones
  return rest;
};

/** One source: collect, verify, drop what the store already has, queue the rest as pending. */
async function runOne(src: Source, base: Omit<SourceCtx, 'onUsage'>) {
  const used: [string, Parameters<OnUsage>[1]][] = [];
  let cost = 0;
  let found = 0;
  let queued = 0;
  let error: string | undefined;
  try {
    if (!(await base.budget())) throw new Error('skipped: budget');
    let cands: Candidate[] = [];
    try {
      cands = await src.run({ ...base, onUsage: (m, u) => used.push([m, u]) });
    } finally {
      for (const [m, u] of used) cost += await recordUsage(`source:${src.name}`, m, u);
    }
    found = cands.length;
    const facts = await verifyAll(cands, 4, (e) => { error ??= `github: ${e instanceof Error ? e.message : e}`; });
    // verified, one row per (repo, credit), canonical lowercase repo
    const rows = new Map<string, Record<string, unknown>>();
    cands.forEach((c, i) => {
      const f = facts[i];
      if (!f) return;
      const repo = f.full_name.toLowerCase();
      const credit_url = (c.credit_url ?? '').slice(0, 500);
      rows.set(`${repo} ${credit_url}`, {
        source: src.name,
        repo,
        kind: c.kind,
        title: (c.title || f.full_name).slice(0, 140),
        why: (c.why ?? '').slice(0, 300),
        credit_url,
        credit_title: (c.credit_title ?? '').slice(0, 200),
        credit_author: (c.credit_author ?? '').slice(0, 120),
        facts: slim(f),
      });
    });
    if (rows.size) {
      const slugs = [...new Set([...rows.values()].flatMap((r) => [`gh-${String(r.repo).replace('/', '-')}`, `c-${String(r.repo).replace('/', '-')}`]))];
      const live = await admin().from('tapes').select('slug').eq('archived', false).in('slug', slugs);
      if (live.error) throw new Error(live.error.message);
      const have = new Set((live.data ?? []).map((t: { slug: string }) => t.slug));
      const fresh = [...rows.values()].filter((r) => !have.has(`gh-${String(r.repo).replace('/', '-')}`) && !have.has(`c-${String(r.repo).replace('/', '-')}`));
      if (fresh.length) {
        const ins = await admin().from('ingest_queue').upsert(fresh, { onConflict: 'repo,source,credit_url', ignoreDuplicates: true }).select('id');
        if (ins.error) throw new Error(ins.error.message);
        queued = (ins.data ?? []).length;
      }
    }
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }
  try {
    await admin().from('source_runs').insert({ source: src.name, found, queued, cost_usd: cost, error: error ?? null });
  } catch (e) {
    console.warn('[sources] could not log the run', e);
  }
  const s: SourceSummary = { name: src.name, found, queued, cost_usd: cost };
  if (error) s.error = error;
  return s;
}

/**
 * Run each source on its own (a failing one never stops the rest), queue what verifies, log a source_runs row per source.
 * Sources are skipped while `budget()` is false. Each source's Anthropic usage is recorded as route `source:<name>`.
 */
export async function runSources(sources: Source[], ctx: Omit<SourceCtx, 'onUsage'>): Promise<RunSummary> {
  const out: SourceSummary[] = [];
  for (const src of sources) out.push(await runOne(src, ctx)); // one at a time: GitHub and the budget are shared
  return { queued: out.reduce((n, s) => n + s.queued, 0), sources: out };
}

/** The real ctx for a scheduled run. */
export const liveCtx = (): Omit<SourceCtx, 'onUsage'> => ({ budget: budgetLeft, config: dbConfig, now: new Date() });
