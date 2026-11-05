import type { VercelRequest, VercelResponse } from '@vercel/node';
import { refreshRadar } from '../../lib/radar';

export const config = { maxDuration: 60 };

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.authorization !== `Bearer ${secret}`) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const n = await refreshRadar(20);
    return res.status(200).json({ ok: true, stocked: n });
  } catch (e: any) {
    return res.status(500).json({ error: String(e.message ?? e) });
  }
}
