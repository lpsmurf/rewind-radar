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
export async function fetchProfile(input: string): Promise<{ kind: 'user' | 'repo'; name: string; text: string } | null> {
  const s = input.trim().replace(/^@/, '').replace(/^https?:\/\/(www\.)?github\.com\//, '').replace(/\.git$/, '').replace(/\/+$/, '');
  if (!/^[\w.-]+(\/[\w.-]+)?$/.test(s)) return null;
  if (s.includes('/')) {
    const r = await fetchRepo(`https://github.com/${s}`);
    if (!r) return null;
    return {
      kind: 'repo',
      name: r.full_name,
      text: `REPO ${r.full_name} (${r.language ?? 'unknown'}, ${r.stars}★)\n${r.description ?? ''}\n\nREADME:\n${r.readme.slice(0, 3500)}`,
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

/** Cheap existence check (one GitHub read). false = 404; throws GitHubError when GitHub refuses (e.g. rate limit). */
export async function repoExists(ref: RepoRef): Promise<boolean> {
  const r = await fetch(`https://api.github.com/repos/${ref.owner}/${ref.repo}`, { headers: headers() });
  if (r.status === 404) return false;
  if (!r.ok) throw new GitHubError(r.status);
  return true;
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
