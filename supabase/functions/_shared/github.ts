import type { RepoInput } from './ai.ts';
import { env } from './env.ts';

export type RepoInfo = RepoInput & { html_url: string };

// Our own account is excluded so the radar shows the wider GitHub, not us.
const EXCLUDED_OWNERS = new Set(['lpsmurf']);

function headers(raw = false): Record<string, string> {
  const h: Record<string, string> = {
    accept: raw ? 'application/vnd.github.raw' : 'application/vnd.github+json',
    'user-agent': 'rewind-radar-video',
  };
  const tok = env('GITHUB_TOKEN');
  if (tok) h.authorization = `Bearer ${tok}`;
  return h;
}

async function readme(full: string): Promise<string> {
  try {
    const r = await fetch(`https://api.github.com/repos/${full}/readme`, { headers: headers(true) });
    return r.ok ? (await r.text()).slice(0, 5000) : '';
  } catch {
    return '';
  }
}

export async function fetchRepo(url: string): Promise<RepoInfo | null> {
  const m = url.match(/^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/);
  if (!m) return null;
  const r = await fetch(`https://api.github.com/repos/${m[1]}/${m[2]}`, { headers: headers() });
  if (!r.ok) return null;
  const j: any = await r.json();
  return {
    full_name: j.full_name,
    description: j.description,
    language: j.language,
    stars: j.stargazers_count,
    html_url: j.html_url,
    readme: await readme(j.full_name),
  };
}

/** Top-starred public repos created in the last 7 days. */
export async function searchWeekly(n = 20): Promise<RepoInfo[]> {
  const since = new Date(Date.now() - 7 * 864e5).toISOString().slice(0, 10);
  const q = encodeURIComponent(`created:>${since}`);
  const r = await fetch(`https://api.github.com/search/repositories?q=${q}&sort=stars&order=desc&per_page=${n + 5}`, {
    headers: headers(),
  });
  if (!r.ok) throw new Error(`GitHub search failed: ${r.status}`);
  const j: any = await r.json();
  const items = (j.items as any[]).filter((it) => !EXCLUDED_OWNERS.has(String(it.owner?.login).toLowerCase())).slice(0, n);
  return Promise.all(
    items.map(async (it) => ({
      full_name: it.full_name,
      description: it.description,
      language: it.language,
      stars: it.stargazers_count,
      html_url: it.html_url,
      readme: await readme(it.full_name),
    })),
  );
}

/** Read a public GitHub user (or a single repo) so the clerk can recommend tapes for it. */
export interface ProfileFacets {
  owner: string;
  repos: { name: string; language: string | null; topics: string[] }[];
}
export async function fetchProfile(input: string): Promise<{ kind: 'user' | 'repo'; name: string; text: string; facets: ProfileFacets } | null> {
  const s = input.trim().replace(/^@/, '').replace(/^https?:\/\/(www\.)?github\.com\//, '').replace(/\.git$/, '').replace(/\/+$/, '');
  if (!/^[\w.-]+(\/[\w.-]+)?$/.test(s)) return null;
  if (s.includes('/')) {
    const r = await fetchRepo(`https://github.com/${s}`);
    if (!r) return null;
    return {
      kind: 'repo',
      name: r.full_name,
      text: `REPO ${r.full_name} (${r.language ?? 'unknown'}, ${r.stars}★)\n${r.description ?? ''}\n\nREADME:\n${r.readme.slice(0, 3500)}`,
      facets: { owner: r.full_name.split('/')[0], repos: [{ name: r.full_name.split('/')[1] ?? r.full_name, language: r.language, topics: [] }] },
    };
  }
  const u = await fetch(`https://api.github.com/users/${s}`, { headers: headers() });
  if (!u.ok) return null;
  const user: any = await u.json();
  const rr = await fetch(`https://api.github.com/users/${s}/repos?sort=pushed&per_page=30&type=owner`, { headers: headers() });
  const repos: any[] = rr.ok ? ((await rr.json()) as any[]).filter((x) => !x.fork).slice(0, 20) : [];
  const lines = repos.map(
    (x) => `- ${x.name} [${x.language ?? '?'}] ${x.stargazers_count}★ ${(x.topics ?? []).join(',')} — ${x.description ?? ''}`,
  );
  return {
    kind: 'user',
    name: user.login,
    text: `USER ${user.login}${user.name ? ` (${user.name})` : ''}\nbio: ${user.bio ?? ''}\npublic repos: ${user.public_repos}\n\nRecently active repos:\n${lines.join('\n')}`,
    facets: { owner: String(user.login), repos: repos.map((x) => ({ name: String(x.name), language: x.language ?? null, topics: Array.isArray(x.topics) ? x.topics : [] })) },
  };
}

// ---------- repo assessment ----------
export interface RepoRef { owner: string; repo: string; full: string; bare: boolean }

// github.com paths that are not owner/repo.
const RESERVED_OWNERS = new Set(
  ('orgs topics marketplace sponsors features settings explore trending collections about pricing login join apps notifications ' +
    'search enterprise site events codespaces new organizations users pulls issues security readme customer-stories').split(' '),
);

/** Find a GitHub repo in free text: a github.com URL anywhere, or the whole text being `owner/repo` (bare, a guess). */
export function parseRepoRef(text: string): RepoRef | null {
  const re = /(?<![\w.-])(?:https?:\/\/)?(?:www\.)?github\.com\/([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)/gi;
  for (const m of text.matchAll(re)) {
    const repo = m[2].replace(/\.git$/i, '').replace(/\.+$/, '');
    if (!repo || RESERVED_OWNERS.has(m[1].toLowerCase())) continue;
    return { owner: m[1], repo, full: `${m[1]}/${repo}`, bare: false };
  }
  const b = text.trim().match(/^@?([A-Za-z0-9-]{1,39})\/([A-Za-z0-9._-]{1,100})$/);
  return b ? { owner: b[1], repo: b[2], full: `${b[1]}/${b[2]}`, bare: true } : null;
}

export class GitHubError extends Error {
  constructor(public status: number) {
    super(`GitHub responded ${status}`);
  }
}

export interface RepoFacts {
  full_name: string;
  html_url: string;
  description: string | null;
  stars: number;
  forks: number;
  license: string | null;
  language: string | null;
  topics: string[];
  pushed_at: string;
  created_at: string;
  archived: boolean;
  open_issues: number;
  /** top-level names; directories end in "/" */
  contents: string[];
  readme: string;
}

async function rawReadme(full: string): Promise<string> {
  try {
    const r = await fetch(`https://api.github.com/repos/${full}/readme`, { headers: headers(true) });
    return r.ok ? (await r.text()).slice(0, 14000) : '';
  } catch {
    return '';
  }
}

async function topLevel(full: string): Promise<string[]> {
  try {
    const r = await fetch(`https://api.github.com/repos/${full}/contents`, { headers: headers() });
    if (!r.ok) return [];
    const j: any = await r.json();
    return Array.isArray(j) ? j.map((f) => `${f.name}${f.type === 'dir' ? '/' : ''}`) : [];
  } catch {
    return [];
  }
}

const exists = new Map<string, { at: number; ok: boolean }>(); // insertion order = age
const EXISTS_MAX = 2000;
const EXISTS_TTL = { miss: 3600_000, hit: 600_000 };
const users = new Map<string, { at: number; ok: boolean }>();
const inflight = new Map<string, Promise<boolean>>(); // concurrent checks of one login share one GitHub call
const USER_TTL = { hit: 3600_000, miss: 600_000 };
export const clearRepoExistsCache = () => {
  exists.clear();
  users.clear();
  inflight.clear();
  searches.clear();
  searching.clear();
  searchTimes.length = 0;
  visitorSearches.clear();
};

/**
 * Cheap existence check (one GitHub read), cached per owner/repo so repeated guesses like "tcp/ip" cost nothing.
 * false = 404; throws GitHubError when GitHub refuses (e.g. rate limit; not cached).
 */
export async function repoExists(ref: RepoRef): Promise<boolean> {
  const key = `${ref.owner}/${ref.repo}`.toLowerCase();
  const hit = exists.get(key);
  if (hit && Date.now() - hit.at < (hit.ok ? EXISTS_TTL.hit : EXISTS_TTL.miss)) return hit.ok;
  const r = await fetch(`https://api.github.com/repos/${ref.owner}/${ref.repo}`, { headers: headers() });
  if (r.status !== 404 && !r.ok) throw new GitHubError(r.status);
  const ok = r.status !== 404;
  exists.delete(key);
  exists.set(key, { at: Date.now(), ok });
  if (exists.size > EXISTS_MAX) exists.delete(exists.keys().next().value as string);
  return ok;
}

/**
 * Does this GitHub login exist? Same bounded cache as repoExists (hits 1 h, misses 10 min, errors never cached).
 * false = 404; throws GitHubError when GitHub refuses (403 rate limit, 5xx).
 */
export async function githubUserExists(login: string): Promise<boolean> {
  const key = login.toLowerCase();
  const hit = peekGithubUser(login);
  if (hit !== undefined) return hit;
  const flying = inflight.get(key);
  if (flying) return flying;
  const p = (async () => {
    const r = await fetch(`https://api.github.com/users/${encodeURIComponent(login)}`, { headers: headers() });
    if (r.status !== 404 && !r.ok) throw new GitHubError(r.status);
    const ok = r.status !== 404;
    users.delete(key);
    users.set(key, { at: Date.now(), ok });
    if (users.size > EXISTS_MAX) users.delete(users.keys().next().value as string);
    return ok;
  })().finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

/** The cached answer for a login (true/false), or undefined when a GitHub call would be needed. */
export function peekGithubUser(login: string): boolean | undefined {
  const hit = users.get(login.toLowerCase());
  return hit && Date.now() - hit.at < (hit.ok ? USER_TTL.hit : USER_TTL.miss) ? hit.ok : undefined;
}

/** Facts the assessment is built on. null = no such repo; throws GitHubError when GitHub refuses (e.g. rate limit). */
export async function fetchRepoFacts(ref: RepoRef): Promise<RepoFacts | null> {
  const path = `${ref.owner}/${ref.repo}`;
  const [r, readme, contents] = await Promise.all([
    fetch(`https://api.github.com/repos/${path}`, { headers: headers() }),
    rawReadme(path),
    topLevel(path),
  ]);
  if (r.status === 404) return null;
  if (!r.ok) throw new GitHubError(r.status);
  const j: any = await r.json();
  return {
    full_name: j.full_name,
    html_url: j.html_url,
    description: j.description ?? null,
    stars: j.stargazers_count ?? 0,
    forks: j.forks_count ?? 0,
    license: j.license?.spdx_id ?? null,
    language: j.language ?? null,
    topics: Array.isArray(j.topics) ? j.topics : [],
    pushed_at: j.pushed_at,
    created_at: j.created_at,
    archived: !!j.archived,
    open_issues: j.open_issues_count ?? 0,
    contents,
    readme,
  };
}

// ---------- repo search (the official Search API, never HTML scraping) ----------
/** A repo found by search. The first nine fields are what the UI shows; forks, open_issues and created_at let healthSignals run on a hit. */
export interface RepoHit {
  full_name: string;
  html_url: string;
  description: string | null;
  stars: number;
  language: string | null;
  license: string | null; // SPDX id
  pushed_at: string;
  archived: boolean;
  topics: string[];
  forks: number;
  open_issues: number;
  created_at: string;
}

const SEARCH_TTL = 3600_000;
const SEARCH_MAX = 500;
const SEARCH_PER_MINUTE = 25; // GitHub allows 30 a minute; the ceiling is per isolate
const searches = new Map<string, { at: number; hits: RepoHit[] }>(); // insertion order = age
const searching = new Map<string, Promise<RepoHit[]>>(); // concurrent identical searches share one call
const searchTimes: number[] = [];
const SEARCH_PER_VISITOR = 10; // real searches a minute for one visitor (client IP), on top of the global ceiling
const visitorSearches = new Map<string, number[]>();
const VISITOR_KEYS_MAX = 2000;

const STOP = new Set(
  ('a an and are as at be by can for from get how i in is it me my of on or that the this to want what which with you ' +
    'need find looking something some any please skill skills tool tools repo repos github ' +
    // filler that is rarely in a repo description; GitHub ANDs every keyword, so one of these can zero a search
    'library libraries framework frameworks package packages build building make making create creating app apps ' +
    'use using best good great simple easy new code project projects help helps way like cool top recommend').split(' '),
);

/** Plain lowercase keywords: quotes, qualifiers (`user:x`), operators and punctuation are dropped; at most 5 distinct terms. */
export function searchTerms(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.toLowerCase().split(/\s+/)) {
    if (raw.includes(':')) continue; // a qualifier such as user:foo or stars:>1
    const t = raw.replace(/[^a-z0-9+#._-]/g, '').replace(/^[-.]+|[.]+$/g, '');
    if (t.length < 2 || STOP.has(t) || t === 'and' || t === 'or' || t === 'not' || out.includes(t)) continue;
    out.push(t);
    if (out.length === 5) break;
  }
  return out;
}

/** The full q= string. `language` is a single GitHub language name, checked before it is used as a qualifier. */
export function searchQuery(terms: string[], language?: string | null, now = Date.now()): string {
  const since = new Date(now - 365 * 864e5).toISOString().slice(0, 10);
  const lang = language && /^[A-Za-z0-9+#.-]{1,30}$/.test(language) ? ` language:${language}` : '';
  return `${terms.join(' ')}${lang} stars:>30 archived:false pushed:>${since}`.trim();
}

/** Only plain github.com/owner/repo links reach the UI (a search result is untrusted input). */
const GITHUB_URL = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+$/;
const FULL_NAME = /^[\w.-]+\/[\w.-]+$/;
const goodHit = (it: any): boolean => !!it && FULL_NAME.test(String(it.full_name)) && GITHUB_URL.test(String(it.html_url)) && !it.archived;

const toHit = (it: any): RepoHit => ({
  full_name: String(it.full_name),
  html_url: String(it.html_url),
  description: it.description ?? null,
  stars: it.stargazers_count ?? 0,
  language: it.language ?? null,
  license: it.license?.spdx_id && it.license.spdx_id !== 'NOASSERTION' ? it.license.spdx_id : null,
  pushed_at: it.pushed_at ?? '',
  archived: !!it.archived,
  topics: Array.isArray(it.topics) ? it.topics.filter((x: unknown) => typeof x === 'string') : [],
  forks: it.forks_count ?? 0,
  open_issues: it.open_issues_count ?? 0,
  created_at: it.created_at ?? '',
});

/**
 * Top-starred, recently pushed, live repos for some keywords. Cached an hour per normalised query (bounded), identical
 * concurrent searches share one call, and at most 25 real calls a minute leave this isolate. Never throws: a refusal
 * (403/429/5xx), a network error or the ceiling gives [] and a warning.
 */
export async function searchRepos(q: string, o: { limit?: number; language?: string | null; who?: string } = {}): Promise<RepoHit[]> {
  const terms = searchTerms(q);
  const limit = Math.min(Math.max(Math.floor(o.limit ?? 8), 1), 30);
  if (!terms.length && !o.language) return [];
  const key = `${terms.join(' ')}|${(o.language ?? '').toLowerCase()}|${limit}`;
  const hit = searches.get(key);
  if (hit && Date.now() - hit.at < SEARCH_TTL) return hit.hits;
  const flying = searching.get(key);
  if (flying) return flying;
  const now = Date.now();
  while (searchTimes.length && now - searchTimes[0] >= 60_000) searchTimes.shift();
  if (searchTimes.length >= SEARCH_PER_MINUTE) {
    console.warn('[github:search] per-minute ceiling reached, skipping');
    return [];
  }
  if (o.who) { // per-visitor limit: checked before anything is counted, cache hits never reach here
    const mine = (visitorSearches.get(o.who) ?? []).filter((t) => now - t < 60_000);
    if (mine.length >= SEARCH_PER_VISITOR) {
      console.warn('[github:search] per-visitor limit reached, skipping');
      return [];
    }
    mine.push(now);
    visitorSearches.delete(o.who);
    visitorSearches.set(o.who, mine);
    if (visitorSearches.size > VISITOR_KEYS_MAX) visitorSearches.delete(visitorSearches.keys().next().value as string);
  }
  searchTimes.push(now);
  const p = (async () => {
    try {
      const ask = async (ts: string[]) => {
        const url = `https://api.github.com/search/repositories?q=${encodeURIComponent(searchQuery(ts, o.language, now))}&sort=stars&order=desc&per_page=${limit}`;
        const r = await fetch(url, { headers: headers() });
        if (!r.ok) throw new GitHubError(r.status);
        const j: any = await r.json();
        return (Array.isArray(j.items) ? j.items : []).filter(goodHit).slice(0, limit).map(toHit) as RepoHit[];
      };
      let hits = await ask(terms);
      // GitHub requires every keyword to match: when a long question finds nothing, retry once with its first two terms
      // (the most specific ones come first in a question). The retry counts against the per-minute ceiling.
      if (!hits.length && terms.length > 2 && searchTimes.length < SEARCH_PER_MINUTE) {
        searchTimes.push(Date.now());
        hits = await ask(terms.slice(0, 2));
      }
      searches.delete(key);
      searches.set(key, { at: Date.now(), hits });
      if (searches.size > SEARCH_MAX) searches.delete(searches.keys().next().value as string);
      return hits;
    } catch (e) {
      console.warn('[github:search] failed, continuing without GitHub results', e instanceof Error ? e.message : e);
      return [];
    }
  })().finally(() => searching.delete(key));
  searching.set(key, p);
  return p;
}

const top = (counts: Map<string, number>, n: number) => [...counts].sort((a, b) => b[1] - a[1]).slice(0, n).map(([k]) => k);

/** Up to 2 GitHub searches for a visitor: their top language with their top topics, then the next topics (or their second language). */
export function profileQueries(f: ProfileFacets): { text: string; language: string | null }[] {
  const langs = new Map<string, number>();
  const topics = new Map<string, number>();
  for (const r of f.repos) {
    if (r.language) langs.set(r.language, (langs.get(r.language) ?? 0) + 1);
    for (const t of r.topics) if (/^[a-z0-9][a-z0-9-]*$/.test(t)) topics.set(t, (topics.get(t) ?? 0) + 1);
  }
  const [lang, lang2] = top(langs, 2);
  const tops = top(topics, 4);
  const out: { text: string; language: string | null }[] = [];
  if (lang || tops.length) out.push({ text: tops.slice(0, 2).join(' '), language: lang ?? null });
  if (tops.length > 2) out.push({ text: tops.slice(2, 4).join(' '), language: lang ?? null });
  else if (lang2 && tops.length) out.push({ text: tops.slice(0, 2).join(' '), language: lang2 });
  return out;
}
