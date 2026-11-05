import { admin } from './admin.ts';
import { clerk, recommendForProfile, reviewProposal, reviewSubmission, type OnUsage } from './ai.ts';
import { BudgetError, budgetLeft, getAssessment, personalFit, RateLimitError, recordUsage } from './assess.ts';
import { candidates } from './catalog.ts';
import { classifyQuestion, CLERK_LINES } from './clerkGuard.ts';
import { fetchProfile, fetchRepo, GitHubError } from './github.ts';
import { refreshRadar } from './radar.ts';
import { env } from './env.ts';
import { aisleOf } from '../src/types.ts';

const CORS: Record<string, string> = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'authorization, x-client-info, apikey, content-type',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'content-type': 'application/json' } });

// Per-instance rate limits (good enough for a demo; the Sonnet limits also live in the database).
const hits = new Map<string, number[]>();
const MAX_KEYS = 5000;
const HOUR = 3600_000;
function prune(now: number) {
  for (const [k, ts] of hits) if (ts.every((t) => now - t >= HOUR)) hits.delete(k);
  // still over the cap: drop the oldest entries (Map keeps insertion order)
  for (const k of hits.keys()) {
    if (hits.size <= MAX_KEYS) break;
    hits.delete(k);
  }
}
function limited(id: string, max: number): boolean {
  const key = id.slice(0, 100);
  const now = Date.now();
  const arr = (hits.get(key) ?? []).filter((t) => now - t < HOUR);
  hits.delete(key); // re-insert so the newest keys sit last
  const over = arr.length >= max;
  if (!over) arr.push(now);
  hits.set(key, arr);
  if (hits.size > MAX_KEYS) prune(now);
  return over;
}

/** The client IP: the last x-forwarded-for hop is the one our proxy appended; earlier hops are client-supplied. */
function clientKey(req: Request): string {
  const hops = (req.headers.get('x-forwarded-for') ?? '').split(',').map((h) => h.trim()).filter(Boolean);
  return (hops[hops.length - 1] ?? 'anon').slice(0, 64);
}

/** Run an AI call, collect its usage, and record it (even if the call throws). */
async function meter<T>(route: string, run: (onUsage: OnUsage) => Promise<T>): Promise<T> {
  const used: [string, Parameters<OnUsage>[1]][] = [];
  try {
    return await run((m, u) => used.push([m, u]));
  } finally {
    for (const [m, u] of used) await recordUsage(route, m, u);
  }
}

const TAPE_COLS = 'id,kind,slug,title,genre,blurb,source_url,stars,language,ring,rating,trust,submitter,rentals,created_at';

export async function handle(req: Request): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  const path = new URL(req.url).pathname.replace(/^.*?\/api\/?/, '').replace(/\/$/, '');
  const who = clientKey(req);
  const body = req.method === 'POST' ? ((await req.json().catch(() => ({}))) as Record<string, unknown>) : {};

  // --- Claude clerk: tape recommendations, or a full assessment when the question holds a GitHub repo ---
  if (path === 'clerk' && req.method === 'POST') {
    const q = classifyQuestion(String(body.question ?? ''));
    const plain = { slugs: [] as string[], aisle: 'counter' };
    if (q.kind === 'junk') return json({ answer: q.reply, ...plain });
    if (limited('clerk:' + who, 15)) return json({ error: 'The clerk needs a break. Try again later.' }, 429);

    if (q.kind === 'repo') {
      try {
        const got = await getAssessment(q.ref, { allowMiss: () => !limited('assess:' + who, 5) });
        if (got) {
          const { owner, repo } = q.ref;
          const { data: tape } = await admin()
            .from('tapes')
            .select('slug,kind,genre')
            .eq('archived', false)
            .in('slug', [`gh-${owner}-${repo}`, `c-${owner}-${repo}`].map((x) => x.toLowerCase()))
            .limit(1)
            .maybeSingle();
          const fit = typeof body.github === 'string' ? await personalFit(got.assessment, got.repo.full_name, body.github) : null;
          return json({
            answer: got.assessment.plain,
            slugs: [...(tape ? [tape.slug] : []), ...got.assessment.overlaps.map((o) => o.slug)],
            aisle: tape ? aisleOf(tape) : 'counter',
            assessment: got.assessment,
            repo: got.repo,
            ...(fit ? { fit } : {}),
            in_store: tape?.slug ?? null,
            reviewed_at: got.reviewed_at,
            cached: got.cached,
            ...(got.stale ? { stale: true } : {}),
          });
        }
        if (!q.ref.bare) return json({ error: CLERK_LINES.noRepo }, 404);
        // a bare "owner/repo" GitHub does not know was probably just a question: fall through
      } catch (e) {
        if (e instanceof RateLimitError) return json({ error: CLERK_LINES.rateLimit }, 429);
        if (e instanceof BudgetError) return json({ answer: CLERK_LINES.budget, ...plain });
        if (e instanceof GitHubError) return json({ error: 'GitHub is rate-limiting the clerk. Try again in a few minutes.' }, 503);
        console.error('[clerk:assess]', e);
        return json({ error: 'The clerk is on break.' }, 500);
      }
    }

    const text = q.kind === 'ask' ? q.text : String(body.question ?? '').trim();
    try {
      const rows = await candidates(text, 30);
      if (!(await budgetLeft())) {
        // free mode: no AI, just the best text matches
        const hits = rows.filter((r) => r.match).slice(0, 5);
        if (!hits.length) return json({ answer: CLERK_LINES.freeNone, ...plain });
        return json({ answer: CLERK_LINES.free, slugs: hits.map((r) => r.slug), aisle: aisleOf(hits[0] as Parameters<typeof aisleOf>[0]) });
      }
      const out = await meter('clerk', (onUsage) => clerk(text, rows, onUsage));
      if (!out.on_topic) return json({ answer: CLERK_LINES.offTopic, ...plain });
      return json({ answer: out.answer, slugs: out.slugs, aisle: out.aisle });
    } catch (e) {
      console.error('[clerk]', e);
      return json({ error: 'The clerk is on break.' }, 500);
    }
  }

  // --- profile radar: recommend tapes for a GitHub user/repo ---
  if (path === 'profile' && req.method === 'POST') {
    const github = String(body.github ?? '').trim();
    if (github.length < 1 || github.length > 120) return json({ error: 'Enter a GitHub username or repo URL' }, 400);
    if (limited('profile:' + who, 6)) return json({ error: 'Max 6 scans per hour' }, 429);
    try {
      const prof = await fetchProfile(github);
      if (!prof) return json({ error: "Couldn't find that GitHub user or repo" }, 404);
      const { data, error } = await admin().from('tapes').select('slug,title,genre,blurb,kind').eq('archived', false).limit(400);
      if (error) return json({ error: 'Catalog unavailable' }, 500);
      if (!(await budgetLeft({ failClosed: true }))) return json({ error: CLERK_LINES.budgetBusy }, 503);
      const rec = await meter('profile', (onUsage) => recommendForProfile(prof.text, data ?? [], onUsage));
      return json({ ...rec, name: prof.name, kind: prof.kind, slugs: rec.picks.map((p) => p.slug) });
    } catch (e) {
      console.error('[profile]', e);
      return json({ error: 'The clerk is on break.' }, 500);
    }
  }

  // --- community submissions ---
  if (path === 'submit' && req.method === 'POST') {
    const title = String(body.title ?? '').trim();
    const url = String(body.url ?? '').trim();
    const note = String(body.note ?? '').trim();
    const submitter = String(body.submitter ?? '').trim();
    const m = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/?$/.exec(url);
    if (!m) return json({ error: 'URL must look like https://github.com/owner/repo' }, 400);
    if (title.length < 1 || title.length > 80) return json({ error: 'Title must be 1-80 characters' }, 400);
    if (note.length > 200) return json({ error: 'Note must be 200 characters or fewer' }, 400);
    if (submitter.length > 30) return json({ error: 'Handle must be 30 characters or fewer' }, 400);
    if (limited('submit:' + who, 3)) return json({ error: 'Max 3 submissions per hour' }, 429);
    try {
      if (!(await budgetLeft())) return json({ error: CLERK_LINES.budgetBusy }, 503);
      const repo = await fetchRepo(url);
      const review = await meter('submit', (onUsage) => reviewSubmission({ title, url, note, repo }, onUsage));
      const { data, error } = await admin()
        .from('tapes')
        .insert({
          kind: 'community',
          slug: ('c-' + m[1] + '-' + m[2]).toLowerCase(),
          title,
          genre: review.genre,
          blurb: review.blurb,
          source_url: url,
          stars: repo?.stars ?? null,
          language: repo?.language ?? null,
          ring: review.ring,
          rating: review.rating,
          trust: review.trust,
          submitter: submitter || null,
        })
        .select(TAPE_COLS)
        .single();
      if (error) return error.code === '23505' ? json({ error: 'Already in the store' }, 409) : json({ error: 'Could not save tape' }, 500);
      return json(data);
    } catch (e) {
      console.error('[submit]', e);
      return json({ error: 'Review failed' }, 500);
    }
  }

  // --- rent: raw SKILL.md ---
  if (path.startsWith('tape/') && req.method === 'GET') {
    const slug = decodeURIComponent(path.slice(5));
    const { data } = await admin().from('tapes').select('body_md').eq('slug', slug).in('kind', ['skill', 'memory']).maybeSingle();
    if (!data?.body_md) return json({ error: 'Not found' }, 404);
    return new Response(data.body_md, { headers: { ...CORS, 'content-type': 'text/markdown; charset=utf-8' } });
  }

  // --- radar refresh: pg_cron calls this Mon + Thu; it refuses to run again within 60 hours ---
  if (path === 'radar/refresh') {
    const secret = env('CRON_SECRET');
    const forced = !!secret && req.headers.get('x-cron-secret') === secret;
    const db = admin();
    if (!(await budgetLeft())) return json({ ok: true, skipped: true, reason: 'budget' });
    const { data: last } = await db.from('radar_runs').select('ran_at').order('ran_at', { ascending: false }).limit(1).maybeSingle();
    const hours = last ? (Date.now() - new Date(last.ran_at).getTime()) / 36e5 : Infinity;
    if (!forced && hours < 60) return json({ ok: true, skipped: true, due_in_hours: Math.ceil(60 - hours) });
    const { data: run, error } = await db.from('radar_runs').insert({ stocked: 0 }).select('id').single();
    if (error || !run) return json({ error: 'Could not start refresh' }, 500);
    const job = meter('radar', (onUsage) => refreshRadar(20, onUsage))
      .then(async (n) => { await db.from('radar_runs').update({ stocked: n }).eq('id', run.id); return n; })
      .catch(async (e) => { console.error('[radar]', e); await db.from('radar_runs').delete().eq('id', run.id); throw e; });
    const rt = (globalThis as any).EdgeRuntime;
    if (rt?.waitUntil) {
      rt.waitUntil(job.catch(() => 0)); // keep working after we answer the cron call
      return json({ ok: true, started: true }, 202);
    }
    try {
      return json({ ok: true, stocked: await job });
    } catch {
      return json({ error: 'Radar refresh failed' }, 500);
    }
  }

  // --- Request Box: visitor proposals (Claude screens for spam) ---
  if (path === 'propose' && req.method === 'POST') {
    const title = String(body.title ?? '').trim();
    const pitch = String(body.pitch ?? '').trim();
    const link = String(body.link ?? '').trim();
    const submitter = String(body.submitter ?? '').trim();
    const visitorId = String(body.visitorId ?? '');
    if (title.length < 3 || title.length > 80) return json({ error: 'Title must be 3-80 characters' }, 400);
    if (pitch.length > 400) return json({ error: 'Pitch must be 400 characters or fewer' }, 400);
    if (link && !/^https:\/\/[^\s]{4,300}$/.test(link)) return json({ error: 'Link must start with https://' }, 400);
    if (submitter.length > 30) return json({ error: 'Handle must be 30 characters or fewer' }, 400);
    if (visitorId.length < 8 || visitorId.length > 64) return json({ error: 'Missing visitor id' }, 400);
    if (limited('propose:' + who, 5)) return json({ error: 'Max 5 proposals per hour' }, 429);
    try {
      if (!(await budgetLeft())) return json({ error: CLERK_LINES.budgetBusy }, 503);
      const r = await meter('propose', (onUsage) => reviewProposal({ title, pitch, link }, onUsage));
      if (!r.allowed) return json({ error: `The clerk turned this one down: ${r.reason || 'not a fit for the store'}` }, 422);
      const { data, error } = await admin()
        .from('proposals')
        .insert({ visitor_id: visitorId, kind: r.kind, title, pitch: r.pitch || pitch, link: link || null, submitter: submitter || null, genre: r.genre })
        .select('id,kind,title,pitch,link,submitter,genre,votes,created_at')
        .single();
      if (error) return json({ error: 'Could not save proposal' }, 500);
      return json(data);
    } catch (e) {
      console.error('[propose]', e);
      return json({ error: 'The clerk is on break.' }, 500);
    }
  }

  return json({ error: 'Not found' }, 404);
}
