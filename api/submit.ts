import type { VercelRequest, VercelResponse } from '@vercel/node';
import { admin } from '../lib/admin';
import { fetchRepo } from '../lib/github';
import { reviewSubmission } from '../lib/ai';

const hits = new Map<string, number[]>();
function limited(id: string, max: number): boolean {
  const now = Date.now();
  const arr = (hits.get(id) ?? []).filter((t) => now - t < 3600_000);
  if (arr.length >= max) {
    hits.set(id, arr);
    return true;
  }
  arr.push(now);
  hits.set(id, arr);
  return false;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  const b = (req.body ?? {}) as Record<string, unknown>;
  const title = String(b.title ?? '').trim();
  const url = String(b.url ?? '').trim();
  const note = String(b.note ?? '').trim();
  const submitter = String(b.submitter ?? '').trim();
  const m = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/?$/.exec(url);
  if (!m) return res.status(400).json({ error: 'URL must look like https://github.com/owner/repo' });
  if (title.length < 1 || title.length > 80) return res.status(400).json({ error: 'Title must be 1-80 characters' });
  if (note.length > 200) return res.status(400).json({ error: 'Note must be 200 characters or fewer' });
  if (submitter.length > 30) return res.status(400).json({ error: 'Handle must be 30 characters or fewer' });
  if (limited(String(b.visitorId ?? req.headers['x-forwarded-for'] ?? 'anon'), 3))
    return res.status(429).json({ error: 'Max 3 submissions per hour' });
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
      .select('id,kind,slug,title,genre,blurb,source_url,stars,language,ring,rating,trust,submitter,rentals,created_at')
      .single();
    if (error) {
      if (error.code === '23505') return res.status(409).json({ error: 'Already in the store' });
      return res.status(500).json({ error: 'Could not save tape' });
    }
    return res.status(200).json(data);
  } catch {
    return res.status(500).json({ error: 'Review failed' });
  }
}
