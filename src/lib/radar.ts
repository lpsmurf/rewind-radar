// Pure mapping from the clerk and profile replies to items for the releases browser.
import type { Aisle, ClerkReply, Tape } from '../types';
import type { BrowseItem, GithubItem } from '../ui/releasesNav';

/** A GitHub repo found by the server (mirrors lib/github.ts RepoHit). */
export interface RepoHit {
  full_name: string;
  html_url: string;
  description: string | null;
  stars: number;
  language: string | null;
  license: string | null;
  pushed_at: string;
  archived: boolean;
  topics: string[];
  forks: number;
  open_issues: number;
  created_at: string;
}

/** /clerk answers may carry `github` hits (absent from older servers). */
export type ClerkAnswer = ClerkReply & { github?: RepoHit[] };

export type ProfilePick =
  | { type: 'tape'; slug: string; why: string }
  | { type: 'github'; repo: RepoHit & { signals?: unknown }; why: string };
export interface ProfileReply {
  answer: string;
  aisle: Aisle | string;
  name: string;
  kind: 'user' | 'repo' | string;
  picks: ProfilePick[];
  skills: { slug: string; why: string }[];
  slugs?: string[];
}

export const hitToItem = (h: RepoHit, why = ''): GithubItem => ({
  kind: 'github', full_name: h.full_name, html_url: h.html_url, description: h.description, stars: h.stars,
  language: h.language, license: h.license, why,
});

/** Picks in server order (store tapes resolved by slug, unknown ones skipped), then the skills; a tape never shows twice. */
export function radarItems(r: ProfileReply, tapes: Tape[]): { items: BrowseItem[]; why: Record<string, string> } {
  const bySlug = new Map(tapes.map((t) => [t.slug, t]));
  const items: BrowseItem[] = [];
  const why: Record<string, string> = {};
  const seen = new Set<string>();
  const add = (it: BrowseItem, w: string) => {
    const k = it.kind === 'github' ? 'gh:' + it.full_name : it.id;
    if (seen.has(k)) return;
    seen.add(k);
    items.push(it);
    why[k] = w;
  };
  for (const p of r.picks ?? []) {
    if (p.type === 'github') add(hitToItem(p.repo, p.why), p.why);
    else { const t = bySlug.get(p.slug); if (t) add(t, p.why); }
  }
  for (const s of r.skills ?? []) {
    const t = bySlug.get(s.slug);
    if (t) add(t, s.why);
  }
  return { items, why };
}

/** A clerk answer's GitHub picks first, then the store tapes it named. */
export function answerItems(r: { github?: RepoHit[]; slugs?: string[] }, tapes: Tape[]): BrowseItem[] {
  const bySlug = new Map(tapes.map((t) => [t.slug, t]));
  const store = (r.slugs ?? []).flatMap((s) => { const t = bySlug.get(s); return t ? [t] : []; });
  return [...(r.github ?? []).map((h) => hitToItem(h)), ...store];
}

export const radarTitle = (r: { kind: string; name: string }): string =>
  r.kind === 'user' ? `YOUR RADAR · @${r.name}` : `RADAR · ${r.name}`;
