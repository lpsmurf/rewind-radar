import { admin } from './admin.ts';

/** Record today's star count per repo, for "stars gained" in the monthly picks. One row per repo per day; best-effort. */
export async function snapshotStars(items: { repo: string; stars: number }[], day = new Date().toISOString().slice(0, 10)): Promise<void> {
  if (!items.length) return;
  try {
    const rows = items.map((i) => ({ repo: i.repo.toLowerCase(), at: day, stars: i.stars }));
    const { error } = await admin().from('star_snapshots').upsert(rows, { onConflict: 'repo,at' });
    if (error) console.warn('[stars]', error.message);
  } catch (e) {
    console.warn('[stars]', e);
  }
}
