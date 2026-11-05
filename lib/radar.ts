import { admin } from './admin';
import { reviewRepo } from './ai';
import { searchWeekly } from './github';

async function pool<T, R>(items: T[], size: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  let i = 0;
  await Promise.all(
    Array.from({ length: size }, async () => {
      while (i < items.length) {
        const idx = i++;
        out[idx] = await fn(items[idx]);
      }
    }),
  );
  return out;
}

/** Fetch this week's top GitHub repos, have Claude review them, upsert as New Releases. */
export async function refreshRadar(n = 20): Promise<number> {
  const repos = await searchWeekly(n);
  const week = new Date();
  week.setUTCDate(week.getUTCDate() - ((week.getUTCDay() + 6) % 7));
  const rows = await pool(repos, 5, async (r) => {
    const rev = await reviewRepo(r);
    return {
      kind: 'repo',
      slug: `gh-${r.full_name.replace('/', '-')}`.toLowerCase(),
      title: r.full_name,
      genre: rev.genre,
      blurb: rev.blurb,
      source_url: r.html_url,
      stars: r.stars,
      language: r.language,
      ring: rev.ring,
      rating: rev.rating,
      trust: 'clean',
      week: week.toISOString().slice(0, 10),
    };
  });
  const { error } = await admin().from('tapes').upsert(rows, { onConflict: 'slug' });
  if (error) throw new Error(error.message);
  return rows.length;
}

export { pool };
