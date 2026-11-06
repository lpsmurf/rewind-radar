import { afterEach, describe, expect, it, vi } from 'vitest';
import { profileQueries, searchQuery, searchRepos, searchTerms } from '../lib/github.ts';
import { searchItem, stubSearch } from './helpers/github.ts';

const qOf = (url: string) => new URL(url).searchParams.get('q')!;

afterEach(() => vi.useRealTimers());

describe('search query building', () => {
  it('keeps at most 5 plain keywords and drops operators, quotes and qualifiers', () => {
    expect(searchTerms('"a skill for making diagrams" user:evil OR -foo AND stars:>1 NOT bar baz qux quux corge')).toEqual([
      'making', 'diagrams', 'foo', 'bar', 'baz',
    ]);
  });

  it('always adds stars, archived and pushed-in-the-last-year qualifiers', () => {
    const q = searchQuery(['mcp', 'server'], 'TypeScript', Date.parse('2026-11-06T00:00:00Z'));
    expect(q).toBe('mcp server language:TypeScript stars:>30 archived:false pushed:>2025-11-06');
  });

  it('refuses a language that is not a plain name', () => {
    expect(searchQuery(['x'], 'a b stars:>1', 0)).not.toContain('language:');
  });

  it('asks the Search API sorted by stars with the token, and returns light hits', async () => {
    vi.stubEnv('GITHUB_TOKEN', 'tok');
    const urls = stubSearch([searchItem('a/b', { license: { spdx_id: 'NOASSERTION' } }), searchItem('c/d', { archived: true })]);
    const hits = await searchRepos('mcp server', { limit: 8 });
    const u = new URL(urls[0]);
    expect(u.pathname).toBe('/search/repositories');
    expect(u.searchParams.get('sort')).toBe('stars');
    expect(u.searchParams.get('per_page')).toBe('8');
    expect(qOf(urls[0])).toMatch(/^mcp server stars:>30 archived:false pushed:>\d{4}-\d\d-\d\d$/);
    expect(hits).toHaveLength(1); // the archived one is dropped
    expect(hits[0]).toMatchObject({ full_name: 'a/b', stars: 500, license: null, language: 'TypeScript', topics: ['mcp'], archived: false });
  });

  it('does not search for nothing', async () => {
    const urls = stubSearch([]);
    expect(await searchRepos('the a of')).toEqual([]);
    expect(urls).toHaveLength(0);
  });
});

describe('search cache, dedupe, errors and ceiling', () => {
  it('serves a repeated query (any case or order of noise) from cache for an hour', async () => {
    vi.useFakeTimers();
    const urls = stubSearch([searchItem('a/b')]);
    await searchRepos('MCP  Server', { limit: 8 });
    await searchRepos('mcp server!', { limit: 8 });
    expect(urls).toHaveLength(1);
    vi.advanceTimersByTime(61 * 60_000);
    await searchRepos('mcp server', { limit: 8 });
    expect(urls).toHaveLength(2);
  });

  it('shares one call between concurrent identical searches', async () => {
    const urls = stubSearch([searchItem('a/b')]);
    const rs = await Promise.all([searchRepos('rag pipeline'), searchRepos('rag pipeline'), searchRepos('RAG pipeline')]);
    expect(urls).toHaveLength(1);
    expect(rs.map((r) => r.length)).toEqual([1, 1, 1]);
  });

  it.each([403, 429, 502])('answers [] on a %i, logs a warning, and does not cache the failure', async (status) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const urls = stubSearch(status);
    await expect(searchRepos('vector db')).resolves.toEqual([]);
    expect(warn).toHaveBeenCalled();
    await searchRepos('vector db');
    expect(urls).toHaveLength(2);
    warn.mockRestore();
  });

  it('answers [] when fetch itself throws', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(searchRepos('anything')).resolves.toEqual([]); // setup.ts: unmocked fetch throws
    warn.mockRestore();
  });

  it('allows 25 real searches a minute per isolate, then skips until the minute passes', async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const urls = stubSearch([searchItem('a/b')]);
    for (let i = 0; i < 25; i++) await searchRepos(`topic${i}`);
    expect(urls).toHaveLength(25);
    expect(await searchRepos('topic-extra')).toEqual([]);
    expect(urls).toHaveLength(25);
    expect(await searchRepos('topic3')).toHaveLength(1); // cache hits do not count
    vi.advanceTimersByTime(61_000);
    expect(await searchRepos('topic-extra')).toHaveLength(1);
    expect(urls).toHaveLength(26);
    warn.mockRestore();
  });

  it('drops hits whose url is not a plain github.com/owner/repo', async () => {
    stubSearch([
      searchItem('a/b'),
      searchItem('evil/site', { html_url: 'https://evil.com/evil/site' }),
      searchItem('js/x', { html_url: 'javascript:alert(1)' }),
      searchItem('deep/path', { html_url: 'https://github.com/deep/path/issues' }),
      searchItem('bad name/x'),
    ]);
    expect((await searchRepos('mcp server')).map((h) => h.full_name)).toEqual(['a/b']);
  });

  it('allows 10 real searches a minute per visitor on top of the global ceiling; others are not affected', async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const urls = stubSearch([searchItem('a/b')]);
    for (let i = 0; i < 10; i++) await searchRepos(`kw${i}`, { who: '1.2.3.4' });
    expect(urls).toHaveLength(10);
    expect(await searchRepos('kw-over', { who: '1.2.3.4' })).toEqual([]);
    expect(urls).toHaveLength(10);
    expect(await searchRepos('kw3', { who: '1.2.3.4' })).toHaveLength(1); // cache hits do not count
    expect(await searchRepos('kw-other', { who: '5.6.7.8' })).toHaveLength(1);
    vi.advanceTimersByTime(61_000);
    expect(await searchRepos('kw-over', { who: '1.2.3.4' })).toHaveLength(1);
    warn.mockRestore();
  });

  it('keeps the cache bounded at 500 entries', async () => {
    vi.useFakeTimers();
    const urls = stubSearch([searchItem('a/b')]);
    for (let i = 0; i < 501; i++) {
      await searchRepos(`word${i}`);
      vi.advanceTimersByTime(3000); // stay under the per-minute ceiling
    }
    const n = urls.length;
    await searchRepos('word500'); // newest: cached
    expect(urls).toHaveLength(n);
    await searchRepos('word0'); // oldest: evicted
    expect(urls).toHaveLength(n + 1);
  });
});

describe('profileQueries', () => {
  const r = (language: string | null, topics: string[] = []) => ({ name: 'x', language, topics });
  it('makes at most 2 queries: top language with top topics, then the next topics', () => {
    const qs = profileQueries({ owner: 'o', repos: [r('Go', ['mcp', 'cli']), r('Go', ['mcp', 'agent']), r('Ruby', ['rag', 'llm'])] });
    expect(qs).toEqual([{ text: 'mcp cli', language: 'Go' }, { text: 'agent rag', language: 'Go' }]);
  });
  it('falls back to the second language, or to the language alone, or to nothing', () => {
    expect(profileQueries({ owner: 'o', repos: [r('Go', ['mcp']), r('Rust')] })).toEqual([{ text: 'mcp', language: 'Go' }, { text: 'mcp', language: 'Rust' }]);
    expect(profileQueries({ owner: 'o', repos: [r('Go')] })).toEqual([{ text: '', language: 'Go' }]);
    expect(profileQueries({ owner: 'o', repos: [] })).toEqual([]);
  });
});
