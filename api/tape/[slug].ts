import type { VercelRequest, VercelResponse } from '@vercel/node';
import { admin } from '../../lib/admin';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });
  const slug = String(req.query.slug ?? '');
  const { data } = await admin()
    .from('tapes')
    .select('body_md')
    .eq('slug', slug)
    .in('kind', ['skill', 'memory'])
    .maybeSingle();
  if (!data || !data.body_md) return res.status(404).json({ error: 'Not found' });
  res.setHeader('content-type', 'text/markdown; charset=utf-8');
  return res.status(200).send(data.body_md);
}
