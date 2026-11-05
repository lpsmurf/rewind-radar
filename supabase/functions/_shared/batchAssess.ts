import { admin } from './admin.ts';
import { anthropicClient, assessParams, parseStructured, SONNET } from './ai.ts';
import { ASSESS_RESERVE_USD, ASSESS_TTL_DAYS, budgetLeft, clampRing, healthSignals, normalizeAssessment, PROMPT_VERSION, recordUsage, releaseReserved, reserve, settleReserved, summarize, type Reservation } from './assess.ts';
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
 * otherwise the batch is skipped. One placeholder per repo is kept while the batch is in flight (so it counts against the daily
 * budget) and its id is stored on the batch row; collect settles each with the real half-price cost and deletes the leftovers.
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
    const slots: Reservation[] = [];
    const releaseAll = () => releaseReserved(slots.map((x) => x.id));
    try {
      for (const repo of repoList) {
        slots.push(
          await reserve(BATCH_ROUTE, {
            maxPerHour: BATCH_CAP * 6, // placeholders are per repo; the budget below is the real cap
            budgetUsd: Number(env('AI_BATCH_BUDGET_USD') || '2'),
            reserveUsd: BATCH_RESERVE_USD,
            model: env('ASSESS_MODEL') || SONNET,
            repo,
          }),
        );
      }
    } catch (e) {
      console.warn('[batch] skipped: budget or rate limit', e);
      await releaseAll();
      return null;
    }
    let batch;
    try {
      batch = await anthropicClient().messages.batches.create({ requests });
    } catch (e) {
      await releaseAll(); // nothing was submitted
      throw e;
    }
    // From here the batch exists and the placeholders stay, whatever happens to the bookkeeping row.
    const { error: ie } = await admin().from('assess_batches').insert({ id: batch.id, status: 'submitted', repos: repoList, reserve_ids: slots.map((x) => x.id) });
    if (ie) console.warn('[batch] could not record batch', batch.id, ie.message);
    return batch.id;
  } catch (e) {
    console.warn('[batch] submit failed', e);
    return null;
  }
}

const CLAIM_MS = 15 * 60_000;

/**
 * Collect every submitted batch that has ended: cache each succeeded result as an assessment (parsed, normalized and ring-clamped
 * exactly like the live path; GitHub facts and store candidates are fetched again now, since the batch only returns the answer),
 * settle its budget reservation with the real 50% cost, log and skip errored / expired / canceled ones, then mark the row collected.
 *
 * Safe to run twice at once and to re-run: a batch is claimed first (status 'collecting', retaken after 15 minutes), and the
 * custom_ids already handled are stored in `done` and skipped. A transient failure (GitHub, database) leaves that result out of
 * `done` and the batch uncollected, so a later run retries just those; permanent ones (errored, expired, unreadable, repo gone)
 * count as done. A cached assessment newer than the batch is kept, and its hits are never touched.
 * A batch still processing, or one that fails to read, stays pending for the next run. Never throws.
 */
export async function collectAssessBatches(): Promise<{ batches: number; cached: number; skipped: number }> {
  const out = { batches: 0, cached: 0, skipped: 0 };
  let ids: string[] = [];
  try {
    const { data, error } = await admin().from('assess_batches').select('id').is('collected_at', null).order('at', { ascending: true });
    if (error) throw new Error(error.message);
    ids = ((data ?? []) as { id: string }[]).map((r) => r.id);
  } catch (e) {
    console.warn('[batch] could not list pending batches', e);
    return out;
  }
  for (const id of ids) {
    let claimed = false;
    try {
      const { data: row, error: ce } = await admin()
        .from('assess_batches')
        .update({ status: 'collecting', claimed_at: new Date().toISOString() })
        .eq('id', id)
        .is('collected_at', null)
        .or(`status.neq.collecting,claimed_at.lt.${new Date(Date.now() - CLAIM_MS).toISOString()}`)
        .select('id,at,repos,done,reserve_ids')
        .maybeSingle();
      if (ce) throw new Error(ce.message);
      if (!row) continue; // someone else has it, or it is collected
      claimed = true;
      const batch = row as { id: string; at: string; repos: string[]; done: string[] | null; reserve_ids: number[] | null };
      const release = async (patch: Record<string, unknown>) => {
        const { error } = await admin().from('assess_batches').update({ claimed_at: null, ...patch }).eq('id', id);
        if (error) console.warn('[batch] could not update', id, error.message);
        claimed = false;
      };
      const client = anthropicClient();
      if ((await client.messages.batches.retrieve(id)).processing_status !== 'ended') {
        await release({ status: 'submitted' });
        continue;
      }
      const repoOf = new Map(batch.repos.map((r) => [batchCustomId(r), r]));
      const reserveOf = new Map(batch.repos.map((r, i) => [batchCustomId(r), batch.reserve_ids?.[i]]));
      const done = new Set(batch.done ?? []);
      const seen = new Set<string>();
      const retry = new Set<string>();
      const finish = async (cid: string) => {
        done.add(cid);
        const { error } = await admin().from('assess_batches').update({ done: [...done] }).eq('id', id);
        if (error) console.warn('[batch] could not save progress', id, error.message); // a re-run repeats it; every step is idempotent
      };
      for await (const res of await client.messages.batches.results(id)) {
        const repo = repoOf.get(res.custom_id);
        if (!repo) {
          console.warn(`[batch] ${id}: unknown custom_id ${res.custom_id}`);
          continue;
        }
        seen.add(res.custom_id);
        if (done.has(res.custom_id)) continue;
        const reserved = reserveOf.get(res.custom_id);
        if (res.result.type !== 'succeeded') {
          console.warn(`[batch] ${id}: ${repo} ${res.result.type}, not cached`);
          out.skipped++;
          if (reserved) await releaseReserved([reserved]); // nothing was billed
          await finish(res.custom_id);
          continue;
        }
        const msg = res.result.message;
        const model = msg.model || env('ASSESS_MODEL') || SONNET;
        // billed even if the answer is unusable; a placeholder is settled in place, an old batch without one adds a row
        const cost = reserved ? await settleReserved(reserved, model, msg.usage, true) : await recordUsage(BATCH_ROUTE, model, msg.usage, repo, true);
        let value: unknown;
        try {
          value = parseStructured<unknown>(msg, model).value;
        } catch (e) {
          console.warn(`[batch] ${id}: ${repo} not cached`, e);
          out.skipped++;
          await finish(res.custom_id);
          continue;
        }
        try {
          const i = await inputs(repo); // throws on a GitHub or database hiccup: retried later
          if (!i) {
            console.warn(`[batch] ${id}: ${repo} no longer on GitHub, not cached`);
            out.skipped++;
            await finish(res.custom_id);
            continue;
          }
          const signals = healthSignals(i.facts);
          const assessment = clampRing(normalizeAssessment(value, i.cands.map((c) => c.slug)), signals);
          const { data: cur, error: re } = await admin().from('assessments').select('updated_at').eq('repo', repo).maybeSingle();
          if (re) throw new Error(re.message);
          if (cur && Date.parse((cur as { updated_at: string }).updated_at) > Date.parse(batch.at)) {
            out.skipped++; // a live assessment is newer than this batch: keep it
          } else {
            // no `hits` here: a new row defaults to 0, an existing one keeps its count
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
              updated_at: new Date().toISOString(),
            });
            if (error) throw new Error(error.message);
            out.cached++;
          }
          await finish(res.custom_id);
        } catch (e) {
          console.warn(`[batch] ${id}: ${repo} will be retried`, e);
          retry.add(res.custom_id);
        }
      }
      if (retry.size) {
        await release({ status: 'ended' }); // not collected: a later run takes the rest
        continue;
      }
      // Final: results that never came back are permanent too; their placeholders go.
      const missing = [...repoOf.keys()].filter((c) => !seen.has(c)).map((c) => reserveOf.get(c)).filter((x): x is number => !!x);
      if (missing.length) console.warn(`[batch] ${id}: ${missing.length} result(s) never came back`);
      await releaseReserved(missing);
      await release({ status: 'ended', collected_at: new Date().toISOString() });
      out.batches++;
    } catch (e) {
      console.warn(`[batch] ${id} stays pending`, e);
      if (claimed) {
        try {
          await admin().from('assess_batches').update({ status: 'submitted', claimed_at: null }).eq('id', id);
        } catch {
          /* the claim expires on its own */
        }
      }
    }
  }
  return out;
}
