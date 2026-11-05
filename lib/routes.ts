import { admin } from './admin.ts';
import { clerk, moderateChat, recommendForProfile, reviewProposal, reviewRepo, reviewSubmission, SONNET, type OnUsage } from './ai.ts';
import { BudgetError, BusyError, budgetLeft, getAssessment, personalFit, PROFILE_RESERVE_USD, RateLimitError, recordUsage, reserve } from './assess.ts';
import { candidates, inStore } from './catalog.ts';
import { checkMessage, CHAT_LINES } from './chatGuard.ts';
import { classifyQuestion, CLERK_LINES } from './clerkGuard.ts';
import { whoIs } from './identity.ts';
import { fetchProfile, fetchRepo, fetchRepoFacts, GitHubError, parseRepoRef, searchRepos, type RepoHit } from './github.ts';
import { collectAssessBatches, submitAssessBatch } from './batchAssess.ts';
import { buildMonthlyPicks, previousMonth } from './monthly.ts';
import { refreshRadar } from './radar.ts';
import { isConfigKey, parseSourceConfig } from './sources/config.ts';
import { snapshotStars } from './stars.ts';
import { SOURCES } from './sources/index.ts';
import { liveCtx, manualSource, runSources } from './sources/pipeline.ts';
import { stockedTape } from './sources/stock.ts';
import { env } from './env.ts';
import { aisleOf } from '../src/types.ts';

const CORS: Record<string, string> = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'authorization, x-client-info, apikey, content-type, x-admin-token',
  'access-control-allow-methods': 'GET, POST, PUT, OPTIONS',
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
function limited(id: string, max: number, peek = false): boolean {
  const key = id.slice(0, 100);
  const now = Date.now();
  const arr = (hits.get(key) ?? []).filter((t) => now - t < HOUR);
  hits.delete(key); // re-insert so the newest keys sit last
  const over = arr.length >= max;
  if (!over && !peek) arr.push(now);
  hits.set(key, arr);
  if (hits.size > MAX_KEYS) prune(now);
  return over;
}

/** True when `id` did this less than `ms` ago; otherwise remembers now. For short gaps ("1 message per 2 s") that `limited` cannot express. */
const lastSeen = new Map<string, number>();
function cooldown(id: string, ms: number): boolean {
  const key = id.slice(0, 100);
  const now = Date.now();
  const last = lastSeen.get(key);
  if (last !== undefined && now - last < ms) return true;
  lastSeen.delete(key); // re-insert so the newest keys sit last
  lastSeen.set(key, now);
  for (const k of lastSeen.keys()) {
    if (lastSeen.size <= MAX_KEYS) break;
    lastSeen.delete(k);
  }
  return false;
}

/** Compare two secrets without stopping at the first difference. */
function sameSecret(a: string, b: string): boolean {
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}

const ADMIN_TOKEN_MIN = 32;
const warnedShort = new Set<string>();
const FAIL_MAX = 20; // wrong admin tokens in the last hour, from anyone
const LOCK_MS = 15 * 60_000;

/**
 * The admin token check shared by every admin route (admin/* and chat/delete). Returns a Response to refuse, or null to go on.
 * - ADMIN_TOKEN unset, or shorter than 32 characters, counts as unset: always 403 (a short one is logged once, never printed).
 * - Wrong tokens are counted in the admin_failures table. After 20 in the last hour, from ANY IP, every admin route answers 429
 *   until 15 minutes after the latest failure. This is a global lockout: fine for a single-owner admin, and it means guessing
 *   cannot be sped up by spreading over many IPs or Edge instances. (The per-IP in-memory limit stays as well.)
 */
async function adminGate(req: Request, who: string): Promise<Response | null> {
  const secret = env('ADMIN_TOKEN');
  if (!secret) return json({ error: 'Forbidden' }, 403);
  if (secret.length < ADMIN_TOKEN_MIN) {
    if (!warnedShort.has(secret)) {
      warnedShort.add(secret);
      console.warn(`[admin] ADMIN_TOKEN is shorter than ${ADMIN_TOKEN_MIN} characters: admin routes stay closed until it is longer`);
    }
    return json({ error: 'Forbidden' }, 403);
  }
  const db = admin();
  try {
    const { data, error } = await db
      .from('admin_failures')
      .select('at')
      .gt('at', new Date(Date.now() - HOUR).toISOString())
      .order('at', { ascending: false })
      .limit(FAIL_MAX);
    if (error) throw error;
    const rows = (data ?? []) as { at: string }[];
    if (rows.length >= FAIL_MAX && Date.now() - new Date(rows[0].at).getTime() < LOCK_MS) return json({ error: 'Too many requests' }, 429);
  } catch (e) {
    console.error('[admin] could not read the failure counter', e);
    return json({ error: 'Admin is resting' }, 503); // fail closed
  }
  if (!sameSecret(req.headers.get('x-admin-token') ?? '', secret)) {
    const { error } = await db.from('admin_failures').insert({ ip: who });
    if (error) console.error('[admin] could not count a failure', error.message);
    return json({ error: 'Forbidden' }, 403);
  }
  return null;
}

/** The client IP: cf-connecting-ip (Cloudflare overwrites it), else the last x-forwarded-for hop; earlier hops are client-supplied. */
// TODO: confirm which header is trustworthy on a deployed Supabase Edge request.
function clientKey(req: Request): string {
  const cf = req.headers.get('cf-connecting-ip')?.trim();
  if (cf) return cf.slice(0, 64);
  const hops = (req.headers.get('x-forwarded-for') ?? '').split(',').map((h) => h.trim()).filter(Boolean);
  return (hops[hops.length - 1] ?? 'anon').slice(0, 64);
}

/**
 * Clerk limits per hour. Light = a verified GitHub username; member = signed in with GitHub.
 * Each visitor has an identity bucket and an IP bucket; both must have room. Members get a higher IP allowance
 * (60 questions, 10 assessments) so a shared NAT does not block them.
 */
// Light identities are unverified (anyone can type any real username), so only the IP bucket really binds them;
// CLERK_MAX_PER_HOUR is a per-isolate ceiling on every clerk Anthropic call, whoever asks.
const clerkCeiling = (dry = false) => limited('ceiling:clerk', Number(env('CLERK_MAX_PER_HOUR') || '300'), dry);

// GitHub top-up searches (store first, GitHub for gaps): per identity and per IP, per hour.
const GH_TOPUP = { ident: 20, ip: 40 };
const STORE_ENOUGH = 3; // store text matches that make a GitHub search unnecessary

/** GitHub repos for a question the store answers weakly. [] when the store is enough, the visitor is over a limit, or GitHub is unavailable. */
async function githubTopUp(text: string, rows: { match?: boolean }[], who: string, idKey: string): Promise<RepoHit[]> {
  if (rows.filter((r) => r.match).length >= STORE_ENOUGH) return [];
  if (limited('ghsearch:' + who, GH_TOPUP.ip, true) || limited(`ghsearch:${idKey}`, GH_TOPUP.ident, true)) return [];
  limited('ghsearch:' + who, GH_TOPUP.ip);
  limited(`ghsearch:${idKey}`, GH_TOPUP.ident);
  const hits = await searchRepos(text, { limit: 8 }); // never throws
  if (!hits.length) return [];
  const have = await inStore(hits);
  return hits.filter((h) => !have.has(h.full_name.toLowerCase()));
}

const CLERK_LIMITS = {
  light: { ask: 15, assess: 5, ipAsk: 15, ipAssess: 5 },
  member: { ask: 40, assess: 10, ipAsk: 60, ipAssess: 10 },
} as const;

/** Run an AI call, collect its usage, and record it (even if the call throws). */
async function meter<T>(route: string, run: (onUsage: OnUsage) => Promise<T>): Promise<T> {
  const used: [string, Parameters<OnUsage>[1]][] = [];
  try {
    return await run((m, u) => used.push([m, u]));
  } finally {
    for (const [m, u] of used) await recordUsage(route, m, u);
  }
}

/** Today's chat moderation spend is under its own cap. Fails closed when the meter breaks. */
async function chatBudgetLeft(): Promise<boolean> {
  try {
    const { data, error } = await admin().rpc('chat_spend_today');
    if (error) throw error;
    return Number(data ?? 0) < Number(env('AI_CHAT_BUDGET_USD') || '0.5');
  } catch (e) {
    console.warn('[chat] spend meter unavailable, resting', e);
    return false;
  }
}

/** Add up token counts when one request made several calls. */
const sumUsage = (us: Parameters<OnUsage>[1][]): Parameters<OnUsage>[1] =>
  us.reduce((a, u) => ({
    ...a,
    input_tokens: (a.input_tokens ?? 0) + (u.input_tokens ?? 0),
    output_tokens: (a.output_tokens ?? 0) + (u.output_tokens ?? 0),
    cache_read_input_tokens: (a.cache_read_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0),
    cache_creation_input_tokens: (a.cache_creation_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0),
  }));

const TAPE_COLS = 'id,kind,slug,title,genre,blurb,source_url,stars,language,ring,rating,trust,submitter,rentals,created_at';

export async function handle(req: Request): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  const path = new URL(req.url).pathname.replace(/^.*?\/api\/?/, '').replace(/\/$/, '');
  const who = clientKey(req);
  const body = req.method === 'POST' || req.method === 'PUT' ? ((await req.json().catch(() => ({}))) as Record<string, unknown>) : {};

  // --- Claude clerk: tape recommendations, or a full assessment when the question holds a GitHub repo ---
  if (path === 'clerk' && req.method === 'POST') {
    const id = await whoIs(req, body, { allowLookup: (dry) => !limited('lookup:' + who, Number(env('GATE_LOOKUPS_PER_HOUR') || '20'), dry) });
    if (id.tier === 'busy') return json({ error: id.why === 'limit' ? CLERK_LINES.gateLookups : CLERK_LINES.gateBusy }, id.why === 'limit' ? 429 : 503);
    if (id.tier === 'guest') return json({ error: id.unknown ? CLERK_LINES.gateUnknown : CLERK_LINES.gate, gate: 'github' }, 401);
    const lim = CLERK_LIMITS[id.tier];
    const idKey = id.tier === 'member' ? `m:${id.userId}` : `gh:${id.github.toLowerCase()}`;
    const q = classifyQuestion(String(body.question ?? ''));
    const plain = { slugs: [] as string[], aisle: 'counter' };
    if (q.kind === 'junk') return json({ answer: q.reply, ...plain });
    if (limited('clerk:' + who, lim.ipAsk) || limited(`clerk:${idKey}`, lim.ask)) return json({ error: 'The clerk needs a break. Try again later.' }, 429);

    if (q.kind === 'repo') {
      try {
        const got = await getAssessment(q.ref, {
          allowMiss: (dry) => !(clerkCeiling(dry) || limited('assess:' + who, lim.ipAssess, dry) || limited(`assess:${idKey}`, lim.assess, dry)),
        });
        if (got) {
          const { owner, repo } = q.ref;
          const { data: tape } = await admin()
            .from('tapes')
            .select('slug,kind,genre')
            .eq('archived', false)
            .in('slug', [`gh-${owner}-${repo}`, `c-${owner}-${repo}`].map((x) => x.toLowerCase()))
            .limit(1)
            .maybeSingle();
          const fit = await personalFit(got.assessment, got.repo.full_name, id.github);
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
        // a bare "owner/repo" is only a guess: whatever went wrong, answer it as a normal question
        if (!q.ref.bare) {
          if (e instanceof RateLimitError) return json({ error: CLERK_LINES.rateLimit }, 429);
          if (e instanceof BudgetError) return json({ answer: CLERK_LINES.budget, ...plain });
          if (e instanceof BusyError) return json({ error: CLERK_LINES.busy }, 503);
          if (e instanceof GitHubError) return json({ error: 'GitHub is rate-limiting the clerk. Try again in a few minutes.' }, 503);
          console.error('[clerk:assess]', e);
          return json({ error: 'The clerk is on break.' }, 500);
        }
        console.warn('[clerk:assess] bare ref fell through', e);
      }
    }

    const text = q.kind === 'ask' ? q.text : String(body.question ?? '').trim();
    try {
      const rows = await candidates(text, 30);
      if (!(await budgetLeft()) || clerkCeiling()) {
        // free mode: no AI, just the best text matches
        const hits = rows.filter((r) => r.match).slice(0, 5);
        if (!hits.length) return json({ answer: CLERK_LINES.freeNone, ...plain });
        return json({ answer: CLERK_LINES.free, slugs: hits.map((r) => r.slug), aisle: aisleOf(hits[0] as Parameters<typeof aisleOf>[0]) });
      }
      const extra = await githubTopUp(text, rows, who, idKey);
      const out = await meter('clerk', (onUsage) => clerk(text, rows, onUsage, extra));
      if (!out.on_topic) return json({ answer: CLERK_LINES.offTopic, ...plain });
      return json({ answer: out.answer, slugs: out.slugs, aisle: out.aisle, github: out.github });
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
      if (!(await budgetLeft())) return json({ error: CLERK_LINES.budgetBusy }, 503);
      let slot;
      try {
        slot = await reserve('profile', {
          maxPerHour: Number(env('AI_PROFILE_MAX_PER_HOUR') || '30'),
          budgetUsd: Number(env('AI_PROFILE_BUDGET_USD') || '1'),
          reserveUsd: Number(env('AI_PROFILE_RESERVE_USD') || PROFILE_RESERVE_USD),
          model: SONNET,
        });
      } catch (e) {
        if (e instanceof RateLimitError || e instanceof BudgetError) return json({ error: CLERK_LINES.budgetBusy }, 503);
        throw e;
      }
      const used: [string, Parameters<OnUsage>[1]][] = [];
      let rec;
      try {
        rec = await recommendForProfile(prof.text, data ?? [], (m, u) => used.push([m, u]));
      } finally {
        if (used.length) await slot.settle(used[used.length - 1][0], sumUsage(used.map(([, u]) => u)));
        else await slot.release(); // nothing was billed
      }
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
    const forced = !!secret && sameSecret(req.headers.get('x-cron-secret') ?? '', secret);
    const db = admin();
    if (!(await budgetLeft())) return json({ ok: true, skipped: true, reason: 'budget' });
    const { data: last } = await db.from('radar_runs').select('ran_at').order('ran_at', { ascending: false }).limit(1).maybeSingle();
    const hours = last ? (Date.now() - new Date(last.ran_at).getTime()) / 36e5 : Infinity;
    if (!forced && hours < 60) return json({ ok: true, skipped: true, due_in_hours: Math.ceil(60 - hours) });
    const { data: run, error } = await db.from('radar_runs').insert({ stocked: 0 }).select('id').single();
    if (error || !run) return json({ error: 'Could not start refresh' }, 500);
    const job = meter('radar', (onUsage) => refreshRadar(20, onUsage, (repos) => submitAssessBatch(repos)))
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

  // --- visitor chat: guests may watch, light and member visitors may talk ---
  if ((path === 'chat' || path === 'chat/report') && req.method === 'POST') {
    const id = await whoIs(req, body, { allowLookup: (dry) => !limited('lookup:' + who, Number(env('GATE_LOOKUPS_PER_HOUR') || '20'), dry) });
    if (id.tier === 'busy') return json({ error: id.why === 'limit' ? CLERK_LINES.gateLookups : CLERK_LINES.gateBusy }, id.why === 'limit' ? 429 : 503);
    if (id.tier === 'guest') return json({ error: CHAT_LINES.gate, gate: 'github' }, 401);
    const idKey = id.tier === 'member' ? `m:${id.userId}` : `gh:${id.github.toLowerCase()}`;

    if (path === 'chat/report') {
      const mid = Number(body.id);
      if (!Number.isSafeInteger(mid) || mid < 1) return json({ error: 'Bad message id' }, 400);
      if (limited(`report:${idKey}`, 10) || limited('report-ip:' + who, 10)) return json({ error: CHAT_LINES.limit }, 429);
      try {
        // One database call counts the report: one per reporter, none for your own message, removal at 3 distinct reporters.
        const { data, error } = await admin().rpc('report_chat', { p_id: mid, p_reporter: idKey });
        if (error) throw error;
        return json({ ok: true, removed: data === true });
      } catch (e) {
        console.error('[chat:report]', e);
        return json({ error: 'Could not send the report' }, 500);
      }
    }

    const key = String(body.key ?? '').trim().slice(0, 80);
    if (!key) return json({ error: 'Missing key' }, 400);
    if (cooldown(`chat:${idKey}`, 2000)) return json({ error: CHAT_LINES.slow }, 429);
    if (limited(`chat:${idKey}`, 30) || limited('chat-ip:' + who, 60)) return json({ error: CHAT_LINES.limit }, 429);
    const checked = checkMessage(String(body.text ?? ''));
    if (!checked.ok) return json({ error: checked.reason }, 422);
    // Moderation never switches off. Chat has its own daily budget (AI_CHAT_BUDGET_USD) so a spam wave cannot starve or
    // outlast it; over that budget, a broken meter, or a failing moderator all mean "the chat is resting": nothing is posted.
    if (!(await chatBudgetLeft())) return json({ error: CHAT_LINES.resting }, 503);
    try {
      const verdict = await meter('chat', (onUsage) => moderateChat(checked.text, onUsage));
      if (!verdict.allowed) return json({ error: CHAT_LINES.moderated }, 422);
    } catch (e) {
      console.error('[chat:moderate]', e);
      return json({ error: CHAT_LINES.busy }, 503);
    }
    try {
      const db = admin();
      const { data, error } = await db
        .from('chat_messages')
        .insert({ sender_key: key, login: id.github, tier: id.tier, body: checked.text })
        .select('id,at,sender_key,login,tier,body')
        .single();
      if (error || !data) throw error ?? new Error('no row');
      // The identity key sits in its own table: Realtime sends whole rows, and anon must not see it.
      const { error: senderErr } = await db.from('chat_senders').insert({ message_id: data.id, sender_id: idKey });
      if (senderErr) {
        await db.from('chat_messages').delete().eq('id', data.id); // never leave a message nobody can be held to
        throw senderErr;
      }
      return json(data);
    } catch (e) {
      console.error('[chat]', e);
      return json({ error: 'Could not post your message' }, 500);
    }
  }

  // --- admin: delete a chat message for good (header x-admin-token must equal env ADMIN_TOKEN; unset means always 403) ---
  if (path === 'chat/delete' && req.method === 'POST') {
    if (limited('delete-ip:' + who, 20)) return json({ error: CHAT_LINES.limit }, 429); // counts wrong tokens too
    const refused = await adminGate(req, who);
    if (refused) return refused;
    const mid = Number(body.id);
    if (!Number.isSafeInteger(mid) || mid < 1) return json({ error: 'Bad message id' }, 400);
    const { error } = await admin().from('chat_messages').delete().eq('id', mid);
    return error ? json({ error: 'Could not delete the message' }, 500) : json({ ok: true });
  }

  // --- sources: pg_cron calls this weekly (header x-cron-secret must equal CRON_SECRET; unset means always 403) ---
  if (path === 'sources/run' && req.method === 'POST') {
    const secret = env('CRON_SECRET');
    if (!secret || !sameSecret(req.headers.get('x-cron-secret') ?? '', secret)) return json({ error: 'Forbidden' }, 403);
    // finished pre-assessment batches go into the cache first; best-effort (collectAssessBatches never throws)
    const job = collectAssessBatches().catch((e) => console.warn('[batch]', e)).then(() => runSources(SOURCES, liveCtx()));
    const rt = (globalThis as any).EdgeRuntime;
    if (rt?.waitUntil) {
      rt.waitUntil(job.catch((e) => console.error('[sources]', e))); // keep working after we answer the cron call
      return json({ ok: true, started: true }, 202);
    }
    try {
      return json({ ok: true, ...(await job) });
    } catch (e) {
      console.error('[sources]', e);
      return json({ error: 'Source run failed' }, 500);
    }
  }

  // --- monthly shelf: pg_cron calls this on the 1st; it builds last calendar month's picks (database only, no AI) ---
  if (path === 'sources/monthly' && req.method === 'POST') {
    const secret = env('CRON_SECRET');
    if (!secret || !sameSecret(req.headers.get('x-cron-secret') ?? '', secret)) return json({ error: 'Forbidden' }, 403);
    const month = previousMonth();
    try {
      return json({ ok: true, month, picked: (await buildMonthlyPicks(month)).length });
    } catch (e) {
      console.error('[monthly]', e);
      return json({ error: 'Monthly picks failed' }, 500);
    }
  }

  // --- admin panel API: header x-admin-token must equal ADMIN_TOKEN (unset or under 32 characters means always 403); 60 calls an hour per IP, wrong tokens included; 20 wrong tokens an hour overall lock every admin route for 15 minutes ---
  if (path.startsWith('admin/')) {
    if (limited('admin-ip:' + who, 60)) return json({ error: 'Too many requests' }, 429);
    const refused = await adminGate(req, who);
    if (refused) return refused;
    const q = new URL(req.url).searchParams;
    const db = admin();

    if (path === 'admin/queue' && req.method === 'GET') {
      const status = q.get('status') ?? 'pending';
      if (!['pending', 'approving', 'approved', 'rejected', 'stocked'].includes(status)) return json({ error: 'Bad status' }, 400);
      const { data, error } = await db.from('ingest_queue').select('*').eq('status', status).order('at', { ascending: false }).limit(200);
      return error ? json({ error: 'Could not read the queue' }, 500) : json({ items: data ?? [] });
    }

    const act = /^admin\/queue\/([^/]+)\/(approve|reject)$/.exec(path);
    if (act && req.method === 'POST') {
      const id = Number(act[1]);
      if (!Number.isSafeInteger(id) || id < 1) return json({ error: 'Bad id' }, 400);
      if (act[2] === 'reject') {
        const { data, error } = await db
          .from('ingest_queue')
          .update({ status: 'rejected', decided_at: new Date().toISOString() })
          .eq('id', id)
          .neq('status', 'stocked')
          .select('id')
          .maybeSingle();
        if (error) return json({ error: 'Could not reject' }, 500);
        return data ? json({ ok: true }) : json({ error: 'Not found' }, 404);
      }
      // Claim the row first, atomically: a second click (or a second tab) gets nothing back and spends nothing.
      let claimed = false;
      const giveBack = async () => {
        if (!claimed) return;
        try {
          await db.from('ingest_queue').update({ status: 'pending' }).eq('id', id).eq('status', 'approving');
        } catch (e) {
          console.error('[admin:approve] could not put the row back', e);
        }
      };
      try {
        const { data: row, error } = await db.from('ingest_queue').update({ status: 'approving' }).eq('id', id).eq('status', 'pending').select('*').maybeSingle();
        if (error) throw error;
        if (!row) {
          const { data: seen } = await db.from('ingest_queue').select('status').eq('id', id).maybeSingle();
          return seen ? json({ error: `Already ${seen.status}` }, 409) : json({ error: 'Not found' }, 404);
        }
        claimed = true;
        const done = () => db.from('ingest_queue').update({ status: 'stocked', decided_at: new Date().toISOString() }).eq('id', id);
        const ref = parseRepoRef(row.repo);
        // The tape may already exist: live means nothing to do; archived means bring it back.
        const slugs = ref ? [`gh-${ref.owner}-${ref.repo}`, `c-${ref.owner}-${ref.repo}`].map((x) => x.toLowerCase()) : [];
        const { data: found, error: findErr } = slugs.length ? await db.from('tapes').select('slug,kind,archived').in('slug', slugs) : { data: [], error: null };
        if (findErr) throw findErr;
        const live = (found ?? []).find((t: { archived: boolean }) => !t.archived);
        if (live) {
          const { error: e } = await done();
          if (e) throw e;
          claimed = false;
          return json({ ok: true, slug: live.slug, existing: true });
        }
        const old = (found ?? [])[0] as { slug: string; kind: string } | undefined;
        if (!(await budgetLeft())) {
          await giveBack();
          return json({ error: CLERK_LINES.budgetBusy }, 503);
        }
        const facts = ref ? await fetchRepoFacts(ref) : null;
        if (!facts) {
          await giveBack();
          return json({ error: 'That repo is no longer on GitHub' }, 404);
        }
        const review = await meter('admin', (onUsage) => reviewRepo(facts, onUsage));
        const tape = stockedTape(facts, review, { url: row.credit_url, title: row.credit_title });
        if (old) {
          const { error: e } = await db.from('tapes').upsert({ ...tape, slug: old.slug, kind: old.kind }, { onConflict: 'slug' }).select('id').single();
          if (e) throw e;
        } else {
          const ins = await db.from('tapes').insert(tape).select('id').single();
          if (ins.error && ins.error.code !== '23505') throw ins.error;
          if (ins.error) {
            await done();
            claimed = false;
            return json({ error: 'Already in the store' }, 409);
          }
        }
        await snapshotStars([{ repo: facts.full_name, stars: facts.stars }]);
        const { error: e } = await done();
        if (e) throw e;
        claimed = false;
        return json({ ok: true, slug: old?.slug ?? tape.slug });
      } catch (e) {
        console.error('[admin:approve]', e);
        await giveBack();
        return json({ error: 'Could not stock that tape' }, 500);
      }
    }

    if (path === 'admin/paste' && req.method === 'POST') {
      const urls = body.urls;
      if (!Array.isArray(urls) || urls.length < 1 || urls.length > 20 || !urls.every((u) => typeof u === 'string')) {
        return json({ error: 'Send 1 to 20 links as urls: string[]' }, 400);
      }
      try {
        // pasted links use no AI, so they ignore the daily budget
        const out = await runSources([manualSource(urls.map((u) => u.slice(0, 300)))], { ...liveCtx(), budget: async () => true });
        const s = out.sources[0];
        if (s.error) return json({ error: s.error }, 500);
        return json({ ok: true, found: s.found, queued: s.queued, ignored: urls.length - s.found });
      } catch (e) {
        console.error('[admin:paste]', e);
        return json({ error: 'Could not queue those links' }, 500);
      }
    }

    if (path === 'admin/spend' && req.method === 'GET') {
      const n = Number(q.get('days'));
      const days = Number.isFinite(n) && n >= 1 ? Math.min(90, Math.floor(n)) : 14;
      const { data, error } = await db.rpc('spend_by_day', { days });
      return error ? json({ error: 'Could not read spend' }, 500) : json({ days, rows: data ?? [] });
    }

    // the editable parts of source_config: GET reads, PUT replaces (the body is the value)
    const cfg = /^admin\/config\/([^/]+)$/.exec(path);
    if (cfg && (req.method === 'GET' || req.method === 'PUT')) {
      const key = cfg[1];
      if (!isConfigKey(key)) return json({ error: 'Not found' }, 404);
      if (req.method === 'GET') {
        const { data, error } = await db.from('source_config').select('value').eq('key', key).maybeSingle();
        return error ? json({ error: 'Could not read the config' }, 500) : json({ key, value: data?.value ?? null });
      }
      const parsed = parseSourceConfig(key, body);
      if ('error' in parsed) return json({ error: parsed.error }, 400);
      const { error } = await db.from('source_config').upsert({ key, value: parsed.value }, { onConflict: 'key' });
      return error ? json({ error: 'Could not save the config' }, 500) : json({ ok: true, key, value: parsed.value });
    }

    if (path === 'admin/runs' && req.method === 'GET') {
      const { data, error } = await db.from('source_runs').select('*').order('at', { ascending: false }).limit(20);
      return error ? json({ error: 'Could not read runs' }, 500) : json({ runs: data ?? [] });
    }
  }

  return json({ error: 'Not found' }, 404);
}
