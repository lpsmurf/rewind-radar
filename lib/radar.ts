import { admin } from './admin.ts';
import { reviewRepo, type OnUsage } from './ai.ts';
import { searchWeekly } from './github.ts';

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
export async function refreshRadar(n = 20, onUsage?: OnUsage): Promise<number> {
  const repos = await searchWeekly(n);
  const week = new Date();
  week.setUTCDate(week.getUTCDate() - ((week.getUTCDay() + 6) % 7));
  const rows = await pool(repos, 5, async (r) => {
    const rev = await reviewRepo(r, onUsage);
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
      archived: false,
      week: week.toISOString().slice(0, 10),
    };
  });
  const { error } = await admin().from('tapes').upsert(rows, { onConflict: 'slug' });
  if (error) throw new Error(error.message);
  // Retire repos from earlier runs: they leave the wall but keep their votes.
  const keep = rows.map((r) => `"${r.slug}"`).join(',');
  const { error: e2 } = await admin().from('tapes').update({ archived: true }).eq('kind', 'repo').not('slug', 'in', `(${keep})`);
  if (e2) throw new Error(e2.message);
  return rows.length;
}

export { pool };
