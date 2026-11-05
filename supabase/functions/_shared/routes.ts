import { admin } from './admin.ts';
import { clerk, reviewSubmission } from './ai.ts';
import { fetchRepo } from './github.ts';
import { refreshRadar } from './radar.ts';
import { env } from './env.ts';

const CORS: Record<string, string> = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'authorization, x-client-info, apikey, content-type',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'content-type': 'application/json' } });

// Per-instance rate limits (good enough for a demo).
const hits = new Map<string, number[]>();
function limited(id: string, max: number): boolean {
  const now = Date.now();
  const arr = (hits.get(id) ?? []).filter((t) => now - t < 3600_000);
  if (arr.length >= max) return hits.set(id, arr), true;
  arr.push(now);
  hits.set(id, arr);
  return false;
}

const TAPE_COLS = 'id,kind,slug,title,genre,blurb,source_url,stars,language,ring,rating,trust,submitter,rentals,created_at';

export async function handle(req: Request): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  const path = new URL(req.url).pathname.replace(/^.*?\/api\/?/, '').replace(/\/$/, '');
  const ip = req.headers.get('x-forwarded-for') ?? 'anon';
  const body = req.method === 'POST' ? ((await req.json().catch(() => ({}))) as Record<string, unknown>) : {};
  const who = String(body.visitorId ?? ip);

  // --- Claude clerk ---
  if (path === 'clerk' && req.method === 'POST') {
    const question = String(body.question ?? '').trim();
    if (question.length < 1 || question.length > 300) return json({ error: 'Question must be 1-300 characters' }, 400);
    if (limited('clerk:' + who, 15)) return json({ error: 'The clerk needs a break. Try again later.' }, 429);
    try {
      const { data, error } = await admin().from('tapes').select('slug,title,genre,blurb,kind').limit(400);
      if (error) return json({ error: 'Catalog unavailable' }, 500);
      return json(await clerk(question, data ?? []));
    } catch (e) {
      console.error('[clerk]', e);
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
      const repo = await fetchRepo(url);
      const review = await reviewSubmission({ title, url, note, repo });
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

  // --- weekly radar refresh (cron) ---
  if (path === 'radar/refresh') {
    const secret = env('CRON_SECRET');
    if (!secret || req.headers.get('x-cron-secret') !== secret) return json({ error: 'Unauthorized' }, 401);
    try {
      return json({ ok: true, stocked: await refreshRadar(20) });
    } catch (e) {
      console.error('[radar]', e);
      return json({ error: 'Radar refresh failed' }, 500);
    }
  }

  return json({ error: 'Not found' }, 404);
}
