import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { vi } from 'vitest';

const dir = fileURLToPath(new URL('../fixtures/github/', import.meta.url));
export const fixture = (name: string) => readFileSync(dir + name, 'utf8');

type Route = { status?: number; body: string };

/** Stub global fetch with a table of GitHub API paths -> responses; anything else 404s. */
export function stubGitHub(routes: Record<string, Route | number>) {
  const seen: { url: string; headers: Record<string, string> }[] = [];
  vi.stubGlobal('fetch', async (input: unknown, init?: { headers?: Record<string, string> }) => {
    const url = String(input);
    seen.push({ url, headers: init?.headers ?? {} });
    const path = url.replace('https://api.github.com', '');
    const r = routes[path];
    if (r === undefined) return new Response('{"message":"Not Found"}', { status: 404 });
    if (typeof r === 'number') return new Response('{}', { status: r });
    return new Response(r.body, { status: r.status ?? 200 });
  });
  return seen;
}

export const POSTIZ = {
  '/repos/gitroomhq/postiz-app': { body: fixture('postiz-repo.json') },
  '/repos/gitroomhq/postiz-app/readme': { body: fixture('postiz-readme.md') },
  '/repos/gitroomhq/postiz-app/contents': { body: fixture('postiz-contents.json') },
};

export const LPSMURF = {
  '/users/lpsmurf': { body: fixture('lpsmurf-user.json') },
  '/users/lpsmurf/repos?sort=pushed&per_page=30&type=owner': { body: fixture('lpsmurf-repos.json') },
};

/** A raw GitHub search item, as /search/repositories returns it. */
export const searchItem = (full: string, o: Record<string, unknown> = {}) => ({
  full_name: full,
  html_url: `https://github.com/${full}`,
  description: `${full} does things`,
  stargazers_count: 500,
  language: 'TypeScript',
  license: { spdx_id: 'MIT' },
  pushed_at: '2026-10-20T00:00:00Z',
  created_at: '2025-01-01T00:00:00Z',
  archived: false,
  topics: ['mcp'],
  forks_count: 20,
  open_issues_count: 5,
  ...o,
});

/** Stub fetch so every GitHub search answers `items` (or a status); returns the URLs asked. */
export function stubSearch(items: unknown[] | number) {
  const urls: string[] = [];
  vi.stubGlobal('fetch', async (input: unknown) => {
    const u = String(input);
    urls.push(u);
    if (typeof items === 'number') return new Response('{}', { status: items });
    return new Response(JSON.stringify({ items }), { status: 200 });
  });
  return urls;
}
