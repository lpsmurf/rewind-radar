import { admin } from './admin.ts';
import { clerk, moderateChat, recommendForProfile, reviewProposal, reviewSubmission, SONNET, type OnUsage } from './ai.ts';
import { BudgetError, BusyError, budgetLeft, getAssessment, personalFit, PROFILE_RESERVE_USD, RateLimitError, recordUsage, reserve } from './assess.ts';
import { candidates } from './catalog.ts';
import { checkMessage, CHAT_LINES } from './chatGuard.ts';
import { classifyQuestion, CLERK_LINES } from './clerkGuard.ts';
import { whoIs } from './identity.ts';
import { fetchProfile, fetchRepo, GitHubError } from './github.ts';
import { refreshRadar } from './radar.ts';
import { env } from './env.ts';
import { aisleOf } from '../src/types.ts';

const CORS: Record<string, string> = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'authorization, x-client-info, apikey, content-type, x-admin-token',
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
  const body = req.method === 'POST' ? ((await req.json().catch(() => ({}))) as Record<string, unknown>) : {};

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
    // Haiku moderation only while the daily budget allows (and the spend meter works): over budget or a broken meter
    // means the free checks above are all we have, per the roadmap. A moderation call that fails never posts unchecked.
    if (await budgetLeft()) {
      try {
        const verdict = await meter('chat', (onUsage) => moderateChat(checked.text, onUsage));
        if (!verdict.allowed) return json({ error: CHAT_LINES.moderated }, 422);
      } catch (e) {
        console.error('[chat:moderate]', e);
        return json({ error: CHAT_LINES.busy }, 503);
      }
    }
    try {
      const { data, error } = await admin()
        .from('chat_messages')
        .insert({ sender_key: key, sender_id: idKey, login: id.github, tier: id.tier, body: checked.text })
        .select('id,at,sender_key,login,tier,body')
        .single();
      if (error) throw error;
      return json(data);
    } catch (e) {
      console.error('[chat]', e);
      return json({ error: 'Could not post your message' }, 500);
    }
  }

  // --- admin: take a chat message down (header x-admin-token must equal env ADMIN_TOKEN; unset means always 403) ---
  if (path === 'chat/delete' && req.method === 'POST') {
    const secret = env('ADMIN_TOKEN');
    if (!secret || !sameSecret(req.headers.get('x-admin-token') ?? '', secret)) return json({ error: 'Forbidden' }, 403);
    const mid = Number(body.id);
    if (!Number.isSafeInteger(mid) || mid < 1) return json({ error: 'Bad message id' }, 400);
    const { error } = await admin().from('chat_messages').update({ hidden: true }).eq('id', mid);
    return error ? json({ error: 'Could not hide the message' }, 500) : json({ ok: true });
  }

  return json({ error: 'Not found' }, 404);
}
