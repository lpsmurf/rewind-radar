// Shared contract for every lane. Do not change shapes without telling the lead.
export type TapeKind = 'skill' | 'repo' | 'community' | 'memory' | 'skene';
export type Ring = 'adopt' | 'trial' | 'assess' | 'hold';
export type Trust = 'clean' | 'caution' | 'flagged';

export const GENRES = [
  'Design',
  'Growth & GTM',
  'Web3',
  'Research & Web',
  'Dev Workflow',
  'Media',
  'Security',
  'Harness & Ops',
] as const;
export type Genre = (typeof GENRES)[number];

/** Aisle ids: a genre name, or one of the special areas. */
export type Aisle = Genre | 'new' | 'community' | 'counter' | 'entrance';

export interface Tape {
  id: string;
  kind: TapeKind;
  slug: string;
  title: string;
  genre: Genre;
  blurb: string;
  source_url: string | null;
  stars: number | null;
  language: string | null;
  ring: Ring | null; // repos + community only
  rating: number | null; // 1-5
  trust: Trust;
  submitter: string | null; // community only
  rentals: number;
  created_at: string;
  /** votes this week (computed client-side from the tape_votes view + realtime) */
  votes: number;
}

export interface Visitor {
  id: string;
  name: string; // e.g. "GUEST-4F2A"
  color: string; // css color
  aisle: Aisle;
}

/** Which aisle a tape lives in. */
export function aisleOf(t: Pick<Tape, 'kind' | 'genre'>): Aisle {
  if (t.kind === 'repo') return 'new';
  if (t.kind === 'community') return 'community';
  return t.genre;
}

export const RING_COLORS: Record<Ring, string> = {
  adopt: '#3ddc84',
  trial: '#ffd200',
  assess: '#4aa3ff',
  hold: '#ff4d4d',
};

/** Brand palette: navy + ticket yellow. */
export const PALETTE = {
  navy: '#0b2a6f',
  navyDark: '#061846',
  navyLight: '#1f4fbf',
  yellow: '#ffd200',
  yellowDark: '#c9a400',
  cream: '#fff6d5',
  ink: '#0a0a14',
  red: '#e63946',
  floorA: '#243b7a',
  floorB: '#1d3168',
};

/** Request Box entry: an idea, a skill to build, or a repo to stock. */
export interface Proposal {
  id: string;
  kind: 'idea' | 'skill' | 'repo';
  title: string;
  pitch: string;
  link: string | null;
  submitter: string | null;
  genre: string | null;
  votes: number;
  created_at: string;
}
