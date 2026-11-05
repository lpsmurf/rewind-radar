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
export type Aisle = Genre | 'new' | 'community' | 'counter' | 'entrance' | 'arcade';

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
  /** Monday of the week a repo tape was stocked (repo tapes only; may be missing on old data). */
  week?: string | null;
  /** votes this week (computed client-side from the tape_votes view + realtime) */
  votes: number;
}

export interface Visitor {
  id: string;
  name: string; // e.g. "GUEST-4F2A"
  color: string; // css color
  aisle: Aisle;
  /** Last known position on the canvas (remote visitors only). Mutated in place by move broadcasts. */
  x?: number;
  y?: number;
}

/** The most recent `week` among repo tapes: the week the Weekly New Releases shelf shows. Null when none has one. */
export function latestWeek(tapes: Pick<Tape, 'kind' | 'week'>[]): string | null {
  let best: string | null = null;
  for (const t of tapes) if (t.kind === 'repo' && t.week && (!best || t.week > best)) best = t.week;
  return best;
}

/**
 * Which aisle a tape lives in. Pass `newWeek` (latestWeek of the live tapes) and repo tapes from an earlier week leave the
 * Weekly New Releases shelf for their genre aisle, where they stay browsable. Repo tapes without a week count as current.
 */
export function aisleOf(t: Pick<Tape, 'kind' | 'genre'> & { week?: string | null }, newWeek?: string | null): Aisle {
  if (t.kind === 'repo') return newWeek && t.week && t.week < newWeek ? t.genre : 'new';
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

// ---------- clerk repo assessment (POST /clerk with a GitHub repo in the question) ----------
export type GateKey = 'licence' | 'maintenance' | 'security' | 'cost' | 'lockin';
/** ok=true means no concern for that gate. */
export interface Gate { ok: boolean; note: string }

export interface Assessment {
  title: string;
  /** 2-3 sentences: what it is, who it is for, how you run it. */
  what: string;
  ring: Ring;
  /** 0-1 */
  confidence: number;
  /** One sentence a non-technical person understands. */
  plain: string;
  benefits: string[];
  risks: string[];
  gates: Record<GateKey, Gate>;
  effort: 'S' | 'M' | 'L';
  /** Tapes already in the store that overlap or pair well. */
  overlaps: { slug: string; why: string }[];
  steps: string[];
  evidence: string[];
  /** The README held text aimed at AI reviewers (prompt injection). */
  ai_directed_text: boolean;
}

/** Computed in code from GitHub facts; never by the model. */
export interface HealthSignals {
  days_since_push: number;
  active: boolean;
  licence: string | null;
  licence_kind: 'permissive' | 'copyleft' | 'other' | 'none';
  archived: boolean;
  stars: number;
  forks: number;
  open_issues: number;
  issue_load: 'low' | 'medium' | 'high';
  age_days: number;
}

export interface RepoSummary {
  full_name: string;
  html_url: string;
  description: string | null;
  language: string | null;
  topics: string[];
  stars: number;
  forks: number;
  license: string | null;
  pushed_at: string;
  archived: boolean;
  open_issues: number;
  signals: HealthSignals;
}

export type FitLevel = 'strong' | 'some' | 'weak' | 'none';
export interface Fit { fit: FitLevel; why: string; helps: string[]; first_step: string }

/** Response of POST /clerk. The assessment fields are present only when the question held a GitHub repo. */
export interface ClerkReply {
  answer: string;
  slugs: string[];
  aisle: string;
  assessment?: Assessment;
  repo?: RepoSummary;
  fit?: Fit | null;
  /** slug of the tape if this repo is already on a shelf */
  in_store?: string | null;
  reviewed_at?: string;
  cached?: boolean;
  stale?: boolean;
}
