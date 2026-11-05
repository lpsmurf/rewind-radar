import type { Tape, Genre } from '../types';
import { GENRES } from '../types';

const now = new Date().toISOString();
let n = 0;
function t(p: Partial<Tape> & { title: string }): Tape {
  n++;
  return {
    id: `mock-${n}`,
    kind: 'skill',
    slug: p.title.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
    genre: 'Dev Workflow',
    blurb: 'A mock tape for local development.',
    source_url: null,
    stars: null,
    language: null,
    ring: null,
    rating: null,
    trust: 'clean',
    submitter: null,
    rentals: Math.floor(Math.random() * 20),
    created_at: now,
    votes: Math.floor(Math.random() * 10),
    ...p,
  };
}

const skills: Tape[] = GENRES.flatMap((g: Genre) =>
  Array.from({ length: 6 }, (_, i) => t({ title: `${g.split(' ')[0]} skill ${i + 1}`, genre: g })),
);
const repos: Tape[] = Array.from({ length: 12 }, (_, i) =>
  t({
    title: `owner/trending-repo-${i + 1}`,
    kind: 'repo',
    genre: GENRES[i % GENRES.length],
    stars: 20000 - i * 1500,
    language: ['TypeScript', 'Rust', 'Python', 'Go'][i % 4],
    ring: (['adopt', 'trial', 'assess', 'hold'] as const)[i % 4],
    rating: 5 - (i % 5),
    source_url: `https://github.com/owner/trending-repo-${i + 1}`,
  }),
);
const community: Tape[] = Array.from({ length: 5 }, (_, i) =>
  t({ title: `hackathon-project-${i + 1}`, kind: 'community', submitter: `team${i + 1}`, ring: 'trial', rating: 4, source_url: `https://github.com/team/p${i + 1}` }),
);

export const MOCK_TAPES: Tape[] = [...repos, ...community, ...skills];
