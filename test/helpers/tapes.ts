// Shared Tape fixture builder for tests.
import type { Tape } from '../../src/types.ts';

let n = 0;
export const tapeFixture = (o: Partial<Tape> = {}): Tape => {
  n++;
  return {
    id: `t${n}`, kind: 'skill', slug: `slug-${n}`, title: `owner/repo-${n}`, genre: 'Design', blurb: 'blurb',
    source_url: null, stars: null, language: null, ring: null, rating: null, trust: 'clean', submitter: null,
    rentals: 0, created_at: '2026-11-01T00:00:00Z', votes: 0, ...o,
  };
};
