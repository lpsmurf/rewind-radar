import type { RepoReview } from '../ai.ts';
import type { RepoFacts } from '../github.ts';

/** Monday of `d`'s week and the 1st of its month (UTC), as YYYY-MM-DD. Same week rule as refreshRadar. */
export function shelfDates(d: Date): { week: string; month: string } {
  const w = new Date(d);
  w.setUTCDate(w.getUTCDate() - ((w.getUTCDay() + 6) % 7));
  return { week: w.toISOString().slice(0, 10), month: `${d.toISOString().slice(0, 7)}-01` };
}

/** The tapes row for an approved queue item: the same shape refreshRadar writes, plus week/month and the source credit. */
export function stockedTape(f: RepoFacts, review: RepoReview, credit: { url?: string; title?: string }, now = new Date()) {
  return {
    kind: 'repo',
    slug: `gh-${f.full_name.replace('/', '-')}`.toLowerCase(),
    title: f.full_name,
    genre: review.genre,
    blurb: review.blurb,
    source_url: f.html_url,
    stars: f.stars,
    language: f.language,
    ring: review.ring,
    rating: review.rating,
    trust: 'clean',
    archived: false,
    ...shelfDates(now),
    credit_url: credit.url || null,
    credit_title: credit.title || null,
  };
}
