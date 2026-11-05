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
