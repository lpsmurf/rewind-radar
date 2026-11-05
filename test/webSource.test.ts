import { beforeEach, describe, expect, it, vi } from 'vitest';
import { searchReply, toolReply } from './helpers/anthropic.ts';

const { create } = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock('@anthropic-ai/sdk', () => ({ default: class { messages = { create }; } }));

import { webSource } from '../lib/sources/web.ts';
import { costUsd, HAIKU, SONNET } from '../lib/ai.ts';
import type { SourceCtx } from '../lib/sources/types.ts';

const ART = { url: 'https://blog.example.com/best-skills', title: 'Best Claude Code skills' };
const ctx = (o: Partial<SourceCtx> = {}): SourceCtx => ({
  onUsage: vi.fn(),
  budget: async () => true,
  config: async (k) => (k === 'web' ? { query: 'best skills this week' } : null),
  now: new Date('2026-11-10T09:00:00Z'),
  ...o,
});
const extract = (items: unknown[]) => toolReply('list_repos', { items });

beforeEach(() => create.mockReset());

describe('webSource', () => {
  it('is named web', () => expect(webSource.name).toBe('web'));

  it('searches once with Sonnet and the web_search tool, then extracts repos with Haiku, crediting the article', async () => {
    create
      .mockResolvedValueOnce(searchReply({ text: 'gitroomhq/postiz-app | https://blog.example.com/best-skills | schedules posts', results: [ART] }))
      .mockResolvedValueOnce(extract([{ repo: 'gitroomhq/postiz-app', url: ART.url, why: 'schedules posts' }]));
    const out = await webSource.run(ctx());
    expect(out).toEqual([{ repo: 'gitroomhq/postiz-app', kind: 'repo', why: 'schedules posts', credit_url: ART.url, credit_title: ART.title }]);
    const [search, ex] = create.mock.calls.map((c) => c[0]);
    expect(search.model).toBe(SONNET);
    expect(search.tools).toEqual([{ type: 'web_search_20260209', name: 'web_search', max_uses: 5 }]);
    expect(search.output_config.effort).toBe('low');
    expect(search.tool_choice).toBeUndefined(); // Sonnet 5.5 rejects a forced tool
    expect(JSON.stringify(search.messages)).toContain('best skills this week');
    expect(ex.model).toBe(HAIKU);
    expect(ex.tool_choice).toEqual({ type: 'tool', name: 'list_repos' });
    expect(ex.messages[0].content).toMatch(/^<data>[\s\S]*<\/data>$/);
    expect(ex.system).toMatch(/untrusted/);
  });

  it('drops the credit but keeps the repo when the model cites a URL that was not in the search results', async () => {
    create
      .mockResolvedValueOnce(searchReply({ text: 'x', results: [ART] }))
      .mockResolvedValueOnce(extract([{ repo: 'o/r', url: 'https://made-up.example/post', why: 'w' }, { repo: 'o/s', url: `${ART.url}/`, why: 'w' }]));
    const out = await webSource.run(ctx());
    expect(out[0]).toEqual({ repo: 'o/r', kind: 'repo', why: 'w' });
    expect(out[1]).toMatchObject({ repo: 'o/s', credit_url: ART.url, credit_title: ART.title });
  });

  it('survives an error-object search result: no throw, no results, nothing credited', async () => {
    create
      .mockResolvedValueOnce(searchReply({ error: 'max_uses_exceeded', text: 'I could not search.' }))
      .mockResolvedValueOnce(extract([]));
    expect(await webSource.run(ctx())).toEqual([]);
  });

  it('returns [] without a Haiku call when the search answered with no text', async () => {
    create.mockResolvedValueOnce(searchReply({ error: 'unavailable' }));
    expect(await webSource.run(ctx())).toEqual([]);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('continues a pause_turn by re-sending the assistant content, at most twice', async () => {
    create
      .mockResolvedValueOnce(searchReply({ results: [ART], stop_reason: 'pause_turn' }))
      .mockResolvedValueOnce(searchReply({ results: [], stop_reason: 'pause_turn' }))
      .mockResolvedValueOnce(searchReply({ text: 'o/r', results: [], stop_reason: 'pause_turn' })) // still paused: stop here
      .mockResolvedValueOnce(extract([{ repo: 'o/r', url: ART.url, why: 'w' }]));
    const out = await webSource.run(ctx());
    expect(create).toHaveBeenCalledTimes(4); // 1 search + 2 continuations + 1 Haiku
    const second = create.mock.calls[1][0].messages;
    expect(second).toHaveLength(2);
    expect(second[1].role).toBe('assistant');
    expect(second[1].content[1].type).toBe('web_search_tool_result');
    expect(create.mock.calls[2][0].messages).toHaveLength(3);
    expect(out[0]).toMatchObject({ repo: 'o/r', credit_url: ART.url }); // results from the first turn still count
  });

  it('does nothing when the budget is spent', async () => {
    expect(await webSource.run(ctx({ budget: async () => false }))).toEqual([]);
    expect(create).not.toHaveBeenCalled();
  });

  it('returns [] when there is no web config', async () => {
    expect(await webSource.run(ctx({ config: async () => null }))).toEqual([]);
    expect(create).not.toHaveBeenCalled();
  });

  it('records the usage of every call, including web search requests', async () => {
    create
      .mockResolvedValueOnce(searchReply({ text: 'x', results: [ART], searches: 4 }))
      .mockResolvedValueOnce(extract([]));
    const c = ctx();
    await webSource.run(c);
    expect(c.onUsage).toHaveBeenCalledTimes(2);
    const [m, u] = (c.onUsage as any).mock.calls[0];
    expect(m).toBe(SONNET);
    expect(u.server_tool_use.web_search_requests).toBe(4);
    expect(costUsd(m, u)).toBeCloseTo(0.04 + (2000 * 2 + 500 * 10) / 1e6, 8);
    expect((c.onUsage as any).mock.calls[1][0]).toBe(HAIKU);
  });

  it('parses a malformed extraction defensively', async () => {
    create.mockResolvedValueOnce(searchReply({ text: 'x', results: [ART] })).mockResolvedValueOnce(toolReply('list_repos', { items: [null, { repo: 5 }, { repo: 'not a repo' }, { repo: 'a/b' }] }));
    expect((await webSource.run(ctx())).map((c) => c.repo)).toEqual(['a/b']);
  });
});
