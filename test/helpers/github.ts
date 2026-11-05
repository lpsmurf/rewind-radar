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
