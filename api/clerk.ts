import type { VercelRequest, VercelResponse } from '@vercel/node';
import { admin } from '../lib/admin';
import { clerk } from '../lib/ai';

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
  const { question, visitorId } = (req.body ?? {}) as { question?: string; visitorId?: string };
  if (typeof question !== 'string' || question.trim().length < 1 || question.length > 300)
    return res.status(400).json({ error: 'Question must be 1-300 characters' });
  if (limited(String(visitorId ?? req.headers['x-forwarded-for'] ?? 'anon'), 15))
    return res.status(429).json({ error: 'The clerk needs a break. Try again later.' });
  try {
    const { data, error } = await admin().from('tapes').select('slug,title,genre,blurb,kind').limit(400);
    if (error) return res.status(500).json({ error: 'Catalog unavailable' });
    return res.status(200).json(await clerk(question.trim(), data ?? []));
  } catch (e) {
    console.error('[clerk]', e);
    return res.status(500).json({ error: 'The clerk is on break.' });
  }
}
