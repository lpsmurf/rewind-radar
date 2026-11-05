import { admin } from './admin.ts';

export const MONTHLY_TOP = 10;
const VOTE_WEIGHT = 3;

export interface Pick {
  month: string;
  rank: number;
  tape_slug: string;
  votes: number;
  stars_gained: number;
  score: number;
}

const ymd = (d: Date) => d.toISOString().slice(0, 10);
const firstOf = (y: number, m: number) => ymd(new Date(Date.UTC(y, m, 1)));

/** The 1st of the calendar month before `now` (UTC), as YYYY-MM-DD. */
export function previousMonth(now = new Date()): string {
  return firstOf(now.getUTCFullYear(), now.getUTCMonth() - 1);
}

/** Rank by votes x 3 + stars gained; ties go to more votes, then slug (so a rebuild gives the same order). Top 10. */
export function scorePicks(items: { slug: string; votes: number; stars_gained: number }[], month = ''): Pick[] {
  return items
    .map((i) => ({ ...i, score: i.votes * VOTE_WEIGHT + i.stars_gained }))
    .sort((a, b) => b.score - a.score || b.votes - a.votes || a.slug.localeCompare(b.slug))
    .slice(0, MONTHLY_TOP)
    .map((i, n) => ({ month, rank: n + 1, tape_slug: i.slug, votes: i.votes, stars_gained: i.stars_gained, score: i.score }));
}

const repoOf = (url: string | null) => /^https:\/\/github\.com\/([^/]+\/[^/#?]+)/i.exec(url ?? '')?.[1].toLowerCase().replace(/\.git$/, '') ?? null;

/**
 * Build and store the picks of `month` (a 1st, YYYY-MM-DD). The month's tapes are the repo and community tapes whose
 * `month` column is that month, or (no month set) that were created in it. Replaces the month idempotently:
 * upsert on (month, rank), then drop ranks past the new count, so the shelf is never empty mid-rebuild.
 */
export async function buildMonthlyPicks(month: string): Promise<Pick[]> {
  const db = admin();
  const start = new Date(`${month}T00:00:00Z`);
  const next = firstOf(start.getUTCFullYear(), start.getUTCMonth() + 1);
  const { data: tapes, error } = await db
    .from('tapes')
    .select('id,slug,kind,source_url,stars')
    .in('kind', ['repo', 'community'])
    .or(`month.eq.${month},and(month.is.null,created_at.gte.${month},created_at.lt.${next})`);
  if (error) throw new Error(`monthly tapes read failed: ${error.message}`);
  const list = (tapes ?? []) as { id: string; slug: string; source_url: string | null; stars: number | null }[];

  let picks: Pick[] = [];
  if (list.length) {
    // Votes cast within the month, counted from the votes table. (The tape_votes view only counts the current week.)
    // PostgREST returns at most 1000 rows a call, so read in pages.
    const ids = list.map((t) => t.id);
    const votes = new Map<string, number>();
    for (let from = 0; ; from += 1000) {
      const { data: vrows, error: ve } = await db
        .from('votes')
        .select('tape_id')
        .in('tape_id', ids)
        .gte('created_at', start.toISOString())
        .lt('created_at', new Date(`${next}T00:00:00Z`).toISOString())
        .order('created_at', { ascending: true })
        .range(from, from + 999);
      if (ve) throw new Error(`monthly votes read failed: ${ve.message}`);
      for (const r of (vrows ?? []) as { tape_id: string }[]) votes.set(r.tape_id, (votes.get(r.tape_id) ?? 0) + 1);
      if ((vrows ?? []).length < 1000) break;
    }

    const repos = [...new Set(list.map((t) => repoOf(t.source_url)).filter((r): r is string => !!r))];
    const { data: srows, error: se } = await db.from('star_snapshots').select('repo,at,stars').in('repo', repos).gte('at', month).lt('at', next).order('at', { ascending: true });
    if (se) throw new Error(`monthly snapshots read failed: ${se.message}`);
    const span = new Map<string, { first: { at: string; stars: number }; last: { at: string; stars: number } }>();
    for (const r of (srows ?? []) as { repo: string; at: string; stars: number }[]) {
      const cur = span.get(r.repo);
      if (!cur) span.set(r.repo, { first: r, last: r });
      else {
        if (r.at < cur.first.at) cur.first = r;
        if (r.at > cur.last.at) cur.last = r;
      }
    }
    picks = scorePicks(
      list.map((t) => {
        const s = span.get(repoOf(t.source_url) ?? '');
        // two or more snapshots in the month: first to last. Only one: the stars at stocking time are the baseline.
        const base = s && s.first.at !== s.last.at ? s.first.stars : t.stars;
        return { slug: t.slug, votes: votes.get(t.id) ?? 0, stars_gained: s && base != null ? Math.max(0, s.last.stars - base) : 0 };
      }),
      month,
    );
  }

  if (picks.length) {
    const { error: ue } = await db.from('monthly_picks').upsert(picks, { onConflict: 'month,rank' });
    if (ue) throw new Error(ue.message);
  }
  const { error: de } = await db.from('monthly_picks').delete().eq('month', month).gt('rank', picks.length);
  if (de) throw new Error(de.message);
  return picks;
}
