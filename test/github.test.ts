import { describe, expect, it, vi } from 'vitest';
import { fetchProfile, fetchRepoFacts, githubUserExists, GitHubError, parseRepoRef } from '../lib/github.ts';
import { LPSMURF, POSTIZ, stubGitHub } from './helpers/github.ts';

const ref = parseRepoRef('https://github.com/gitroomhq/postiz-app')!;

describe('fetchRepoFacts', () => {
  it('collects repo facts, the README and the top-level listing', async () => {
    stubGitHub(POSTIZ);
    const f = await fetchRepoFacts(ref);
    expect(f).toMatchObject({
      full_name: 'gitroomhq/postiz-app',
      html_url: 'https://github.com/gitroomhq/postiz-app',
      license: 'AGPL-3.0',
      language: 'TypeScript',
      archived: false,
    });
    expect(f!.stars).toBeGreaterThan(1000);
    expect(f!.forks).toBeGreaterThan(100);
    expect(f!.open_issues).toBeGreaterThan(0);
    expect(f!.topics).toContain('typescript');
    expect(f!.pushed_at).toMatch(/^\d{4}-/);
    expect(f!.readme).toContain('Postiz');
    expect(f!.contents).toContain('.github/'); // directories get a trailing slash
    expect(f!.contents).toContain('.env.example');
  });

  it('returns null for a missing repo', async () => {
    stubGitHub({});
    expect(await fetchRepoFacts(ref)).toBeNull();
  });

  it('throws GitHubError when GitHub refuses (rate limit)', async () => {
    stubGitHub({ '/repos/gitroomhq/postiz-app': 403 });
    await expect(fetchRepoFacts(ref)).rejects.toBeInstanceOf(GitHubError);
  });

  it('survives a missing README and listing', async () => {
    stubGitHub({ '/repos/gitroomhq/postiz-app': POSTIZ['/repos/gitroomhq/postiz-app'] });
    const f = await fetchRepoFacts(ref);
    expect(f!.readme).toBe('');
    expect(f!.contents).toEqual([]);
  });

  it('caps the README at 14,000 characters', async () => {
    stubGitHub({ ...POSTIZ, '/repos/gitroomhq/postiz-app/readme': { body: 'x'.repeat(20000) } });
    expect((await fetchRepoFacts(ref))!.readme).toHaveLength(14000);
  });

  it('sends the token when GITHUB_TOKEN is set', async () => {
    vi.stubEnv('GITHUB_TOKEN', 'test-token');
    const seen = stubGitHub(POSTIZ);
    await fetchRepoFacts(ref);
    expect(seen[0].headers.authorization).toBe('Bearer test-token');
  });
});

describe('fetchProfile (existing behaviour)', () => {
  it('summarises a user and their recent non-fork repos', async () => {
    stubGitHub(LPSMURF);
    const p = await fetchProfile('https://github.com/lpsmurf');
    expect(p).toMatchObject({ kind: 'user', name: 'lpsmurf' });
    expect(p!.text).toContain('rewind-radar');
  });
});

describe('githubUserExists', () => {
  it('is true for a user, false for a 404, and throws GitHubError on 403/5xx', async () => {
    stubGitHub({ '/users/lpsmurf': 200, '/users/limited': 403, '/users/down': 502 });
    expect(await githubUserExists('lpsmurf')).toBe(true);
    expect(await githubUserExists('ghost')).toBe(false);
    await expect(githubUserExists('limited')).rejects.toBeInstanceOf(GitHubError);
    await expect(githubUserExists('down')).rejects.toBeInstanceOf(GitHubError);
  });

  it('caches hits for an hour and misses for ten minutes; errors are not cached', async () => {
    vi.useFakeTimers();
    try {
      const seen = stubGitHub({ '/users/lpsmurf': 200, '/users/flaky': 500 });
      await githubUserExists('lpsmurf');
      await githubUserExists('LPSmurf'); // same key, any case
      await githubUserExists('ghost');
      await githubUserExists('ghost');
      expect(seen).toHaveLength(2);
      vi.advanceTimersByTime(11 * 60_000);
      await githubUserExists('lpsmurf');
      await githubUserExists('ghost');
      expect(seen.map((s) => s.url.split('/').pop())).toEqual(['lpsmurf', 'ghost', 'ghost']);
      vi.advanceTimersByTime(60 * 60_000);
      await githubUserExists('lpsmurf');
      expect(seen).toHaveLength(4);
      await expect(githubUserExists('flaky')).rejects.toThrow();
      await expect(githubUserExists('flaky')).rejects.toThrow();
      expect(seen.filter((s) => s.url.endsWith('/flaky'))).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
