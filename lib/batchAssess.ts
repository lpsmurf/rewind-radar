import { admin } from './admin.ts';
import { anthropicClient, assessParams, parseStructured, SONNET } from './ai.ts';
import { ASSESS_RESERVE_USD, ASSESS_TTL_DAYS, budgetLeft, clampRing, healthSignals, normalizeAssessment, PROMPT_VERSION, recordUsage, reserve, summarize } from './assess.ts';
import { candidates } from './catalog.ts';
import { env } from './env.ts';
import { fetchRepoFacts, parseRepoRef, type RepoFacts } from './github.ts';
import { pool } from './radar.ts';

/** Pre-assessment through Message Batches: half price, results within 24 hours, collected by the weekly sources run. */
export const BATCH_CAP = 25;
export const BATCH_ROUTE = 'batch-assess';
/** Half the live reserve per repo: a batch is billed at 50%. */
export const BATCH_RESERVE_USD = ASSESS_RESERVE_USD / 2;

/** FNV-1a, 8 hex digits: no crypto import, so it runs the same in Node and Deno. */
function hash8(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(16).padStart(8, '0');
}

/**
 * The batch custom_id for a repo: [a-zA-Z0-9_-], 1-64 characters, unique within a batch. "owner/repo" becomes "owner__repo"
 * (GitHub owners cannot contain "_", so that is unambiguous). A name with other characters (dots) or over 64 characters gets a
 * hash suffix so two different repos never share an id. Deterministic: collect recomputes it from the stored repo list.
 */
export function batchCustomId(repo: string): string {
  const key = repo.toLowerCase();
  const base = key.replace('/', '__');
  if (/^[a-z0-9_-]+$/.test(base) && base.length <= 64) return base;
  return `${base.replace(/[^a-z0-9_-]/g, '_').slice(0, 55)}-${hash8(key)}`;
}

const fresh = (r: { prompt_version: number; updated_at: string }) =>
  r.prompt_version === PROMPT_VERSION && Date.now() - Date.parse(r.updated_at) < ASSESS_TTL_DAYS * 864e5;

/** Everything the live path feeds the model, fetched the same way as getAssessment. */
async function inputs(full: string): Promise<{ facts: RepoFacts; cands: Awaited<ReturnType<typeof candidates>> } | null> {
  const ref = parseRepoRef(full);
  if (!ref) return null;
  const facts = await fetchRepoFacts(ref);
  if (!facts) return null;
  return { facts, cands: await candidates(`${facts.full_name} ${facts.description ?? ''} ${facts.topics.join(' ')}`, 20) };
}

/**
 * Submit one Message Batch assessing the repos that have no fresh assessment (same PROMPT_VERSION, within the TTL).
 * At most BATCH_CAP repos. Budget: the daily budget must have room, and a reservation on route "batch-assess" of
 * BATCH_RESERVE_USD (half the live reserve) per repo must fit that route's own daily budget (AI_BATCH_BUDGET_USD, default 2);
 * otherwise the batch is skipped. The reservation is released once the batch exists: the real, half-price cost is metered
 * per result when it is collected, and batches only come from the twice-weekly radar refresh, so they cannot pile up.
 * Best-effort: returns the batch id, or null (nothing to do, budget spent, or any failure); never throws.
 */
export async function submitAssessBatch(repos: string[]): Promise<string | null> {
  try {
    const keys = [...new Set(repos.map((r) => parseRepoRef(r)?.full.toLowerCase()).filter((r): r is string => !!r))];
    if (!keys.length) return null;
    const { data, error } = await admin().from('assessments').select('repo,prompt_version,updated_at').in('repo', keys);
    if (error) throw new Error(`assessments read failed: ${error.message}`);
    const have = new Set(((data ?? []) as { repo: string; prompt_version: number; updated_at: string }[]).filter(fresh).map((r) => r.repo));
    const todo = keys.filter((k) => !have.has(k));
    if (!todo.length) return null;

    const requests: { custom_id: string; params: ReturnType<typeof assessParams> }[] = [];
    const used = new Set<string>();
    const built = await pool(todo, 5, async (full) => {
      try {
        const i = await inputs(full);
        return i && { full, params: assessParams(i.facts, healthSignals(i.facts), i.facts.readme, i.cands) };
      } catch (e) {
        console.warn(`[batch] skipping ${full}`, e);
        return null;
      }
    });
    const repoList: string[] = [];
    for (const b of built) {
      if (!b || requests.length >= BATCH_CAP) continue;
      const custom_id = batchCustomId(b.full);
      if (used.has(custom_id)) continue;
      used.add(custom_id);
      requests.push({ custom_id, params: b.params });
      repoList.push(b.full);
    }
    if (!requests.length) return null;

    if (!(await budgetLeft())) return null;
    let slot;
    try {
      slot = await reserve(BATCH_ROUTE, {
        maxPerHour: 6,
        budgetUsd: Number(env('AI_BATCH_BUDGET_USD') || '2'),
        reserveUsd: requests.length * BATCH_RESERVE_USD,
        model: env('ASSESS_MODEL') || SONNET,
      });
    } catch (e) {
      console.warn('[batch] skipped: budget or rate limit', e);
      return null;
    }
    try {
      const batch = await anthropicClient().messages.batches.create({ requests });
      const { error: ie } = await admin().from('assess_batches').insert({ id: batch.id, status: 'submitted', repos: repoList });
      if (ie) console.warn('[batch] could not record batch', batch.id, ie.message);
      return batch.id;
    } finally {
      await slot.release();
    }
  } catch (e) {
    console.warn('[batch] submit failed', e);
    return null;
  }
}

/**
 * Collect every submitted batch that has ended: cache each succeeded result as an assessment (parsed, normalized and ring-clamped
 * exactly like the live path; GitHub facts and store candidates are fetched again now, since the batch only returns the answer),
 * meter its usage at 50% under route "batch-assess", log and skip errored / expired / canceled ones, then mark the row collected.
 * A batch still processing, or one that fails to read, stays pending for the next run. Never throws.
 */
export async function collectAssessBatches(): Promise<{ batches: number; cached: number; skipped: number }> {
  const out = { batches: 0, cached: 0, skipped: 0 };
  let rows: { id: string; repos: string[] }[] = [];
  try {
    const { data, error } = await admin().from('assess_batches').select('id,repos').is('collected_at', null).order('at', { ascending: true });
    if (error) throw new Error(error.message);
    rows = (data ?? []) as typeof rows;
  } catch (e) {
    console.warn('[batch] could not list pending batches', e);
    return out;
  }
  for (const row of rows) {
    try {
      const client = anthropicClient();
      if ((await client.messages.batches.retrieve(row.id)).processing_status !== 'ended') continue;
      const repoOf = new Map(row.repos.map((r) => [batchCustomId(r), r]));
      for await (const res of await client.messages.batches.results(row.id)) {
        const repo = repoOf.get(res.custom_id);
        if (!repo) {
          console.warn(`[batch] ${row.id}: unknown custom_id ${res.custom_id}`);
          continue;
        }
        if (res.result.type !== 'succeeded') {
          console.warn(`[batch] ${row.id}: ${repo} ${res.result.type}, not cached`);
          out.skipped++;
          continue;
        }
        const msg = res.result.message;
        const model = msg.model || env('ASSESS_MODEL') || SONNET;
        const cost = await recordUsage(BATCH_ROUTE, model, msg.usage, repo, true); // billed even if the answer is unusable
        try {
          const { value } = parseStructured<unknown>(msg, model);
          const i = await inputs(repo);
          if (!i) throw new Error('repo no longer on GitHub');
          const signals = healthSignals(i.facts);
          const assessment = clampRing(normalizeAssessment(value, i.cands.map((c) => c.slug)), signals);
          const { error } = await admin().from('assessments').upsert({
            repo,
            data: assessment,
            facts: summarize(i.facts, signals),
            model,
            prompt_version: PROMPT_VERSION,
            input_tokens: msg.usage.input_tokens ?? 0,
            output_tokens: msg.usage.output_tokens ?? 0,
            cache_read_tokens: msg.usage.cache_read_input_tokens ?? 0,
            cache_write_tokens: msg.usage.cache_creation_input_tokens ?? 0,
            cost_usd: cost,
            hits: 0,
            updated_at: new Date().toISOString(),
          });
          if (error) throw new Error(error.message);
          out.cached++;
        } catch (e) {
          console.warn(`[batch] ${row.id}: ${repo} not cached`, e);
          out.skipped++;
        }
      }
      const { error } = await admin().from('assess_batches').update({ status: 'ended', collected_at: new Date().toISOString() }).eq('id', row.id);
      if (error) console.warn('[batch] could not mark collected', row.id, error.message);
      out.batches++;
    } catch (e) {
      console.warn(`[batch] ${row.id} stays pending`, e);
    }
  }
  return out;
}
