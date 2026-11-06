import { beforeEach, describe, expect, it, vi } from 'vitest';
import { stubWatchApi, type WatchThread, type WatchVideo } from './helpers/youtube.ts';
import { watchChannels, type WatchCtx } from '../lib/sources/watch.ts';

const NOW = new Date('2026-11-10T09:00:00Z');
const CH = 'UC' + 'a'.repeat(22);
const UPLOADS = 'UU' + 'a'.repeat(22);
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000).toISOString();
const vid = (id: string, h: number, o: Partial<WatchVideo> = {}): WatchVideo => ({ id, publishedAt: hoursAgo(h), ...o });
const owner = (text: string, replies?: WatchThread['replies']): WatchThread => ({ author: CH, text, replies });

type StockResult = { status: 'added' | 'restored' | 'duplicate' | 'not_found' | 'error'; cost_usd?: number };
function setup(o: { watch?: unknown; stock?: (repo: string) => StockResult; budget?: () => boolean } = {}) {
  const store: Record<string, unknown> = { watch: o.watch ?? { channels: [{ handle: '@Chan' }], seen: [] } };
  const stocked: { repo: string; credit: { url: string; title: string } }[] = [];
  const runs: any[] = [];
  const ctx: WatchCtx = {
    now: NOW,
    config: async (k) => store[k] ?? null,
    saveConfig: async (k, v) => void (store[k] = v),
    budget: async () => (o.budget ? o.budget() : true),
    stock: async (repo, credit) => {
      stocked.push({ repo, credit });
      return o.stock ? o.stock(repo) : { status: 'added', cost_usd: 0.004 };
    },
    logRun: async (r) => void runs.push(r),
  };
  return { ctx, store, stocked, runs };
}
const api = (uploads: WatchVideo[], threads: Record<string, WatchThread[]> = {}, extra: Parameters<typeof stubWatchApi>[0] = {}) =>
  stubWatchApi({ handles: { '@Chan': CH }, uploads: { [UPLOADS]: uploads }, threads, ...extra });

beforeEach(() => vi.stubEnv('YOUTUBE_API_KEY', 'test-key'));

describe('watchChannels', () => {
  it('resolves the handle once, stores the ids, and does not resolve again', async () => {
    const calls = api([]);
    const s = setup();
    await watchChannels(s.ctx);
    expect(calls.filter((c) => c.kind === 'channels')).toHaveLength(1);
    expect(calls[0].params).toMatchObject({ part: 'id,contentDetails', forHandle: '@Chan', key: 'test-key' });
    expect((s.store.watch as any).channels[0]).toMatchObject({ handle: '@Chan', channel_id: CH, uploads: UPLOADS });
    await watchChannels(s.ctx);
    expect(calls.filter((c) => c.kind === 'channels')).toHaveLength(1);
    expect(calls.filter((c) => c.kind === 'playlistItems')[1].params).toMatchObject({ playlistId: UPLOADS, part: 'contentDetails,snippet', maxResults: '5' });
  });

  it('reads only the owner\'s comments and replies, never other commenters\' links', async () => {
    api([vid('v1', 72)], {
      v1: [
        { author: 'UCother', text: 'try https://github.com/spam/spam' },
        owner('1. https://github.com/a/one', [{ author: 'UCother', text: 'https://github.com/spam/reply' }, { author: CH, text: 'and https://github.com/b/two' }]),
      ],
    });
    const s = setup();
    const r = await watchChannels(s.ctx);
    expect(s.stocked.map((x) => x.repo).sort()).toEqual(['a/one', 'b/two']);
    expect(r).toMatchObject({ channels: 1, videos_checked: 1, repos_found: 2, added: 2 });
  });

  it('asks for comments by relevance, 100 at a time', async () => {
    const calls = api([vid('v1', 72)]);
    await watchChannels(setup().ctx);
    expect(calls.find((c) => c.kind === 'commentThreads')!.params).toMatchObject({ part: 'snippet,replies', videoId: 'v1', maxResults: '100', order: 'relevance' });
  });

  it('includes links in the video description, deduped and parsed in code', async () => {
    api([vid('v1', 72, { description: 'Repos: https://github.com/a/one, github.com/a/one and https://github.com/c/three.git\nme: https://github.com/someuser\ngist https://gist.github.com/u/abc\nbug https://github.com/x/y/issues/3' })], {
      v1: [owner('https://github.com/A/One')],
    });
    const s = setup();
    await watchChannels(s.ctx);
    expect(s.stocked.map((x) => x.repo.toLowerCase()).sort()).toEqual(['a/one', 'c/three']);
  });

  it('credits the video: its url, its title and the channel', async () => {
    api([vid('v1', 72, { title: 'Weekly repos', channel: 'Next New Thing' })], { v1: [owner('https://github.com/a/one')] });
    const s = setup();
    await watchChannels(s.ctx);
    expect(s.stocked[0].credit).toEqual({ url: 'https://www.youtube.com/watch?v=v1', title: 'Weekly repos · Next New Thing' });
  });

  it('skips seen videos and videos older than 14 days, without reading their comments', async () => {
    const calls = api([vid('seen1', 72), vid('old', 15 * 24), vid('new', 72)], { new: [owner('https://github.com/a/one')] });
    const s = setup({ watch: { channels: [{ handle: '@Chan', channel_id: CH, uploads: UPLOADS }], seen: ['seen1'] } });
    const r = await watchChannels(s.ctx);
    expect(calls.filter((c) => c.kind === 'commentThreads').map((c) => c.params.videoId)).toEqual(['new']);
    expect(r.videos_checked).toBe(1);
    expect((s.store.watch as any).seen).toEqual(['seen1', 'new']);
  });

  it('retries a fresh video with no owner links, and marks an old one without links as seen', async () => {
    api([vid('fresh', 5), vid('stale', 72)], { fresh: [{ author: 'UCother', text: 'https://github.com/x/y' }], stale: [] });
    const s = setup();
    await watchChannels(s.ctx);
    expect((s.store.watch as any).seen).toEqual(['stale']);
    expect(s.stocked).toHaveLength(0);
  });

  it('marks a fresh video seen once its owner comment has links', async () => {
    api([vid('fresh', 5)], { fresh: [owner('https://github.com/a/one')] });
    const s = setup();
    await watchChannels(s.ctx);
    expect((s.store.watch as any).seen).toEqual(['fresh']);
  });

  it('keeps only the newest 300 seen ids', async () => {
    api([vid('n1', 72), vid('n2', 72)], {});
    const seen = Array.from({ length: 299 }, (_, i) => `s${i}`);
    const s = setup({ watch: { channels: [{ handle: '@Chan', channel_id: CH, uploads: UPLOADS }], seen } });
    await watchChannels(s.ctx);
    const after = (s.store.watch as any).seen as string[];
    expect(after).toHaveLength(300);
    expect(after.slice(-2)).toEqual(['n1', 'n2']);
    expect(after[0]).toBe('s1');
  });

  it('counts added, restored and duplicate repos, and logs the run', async () => {
    api([vid('v1', 72)], { v1: [owner('https://github.com/a/new https://github.com/b/back https://github.com/c/dup https://github.com/d/gone')] });
    const s = setup({
      stock: (repo) => ({ status: ({ 'a/new': 'added', 'b/back': 'restored', 'c/dup': 'duplicate', 'd/gone': 'not_found' } as const)[repo as 'a/new'], cost_usd: repo === 'c/dup' ? 0 : 0.004 }),
    });
    const r = await watchChannels(s.ctx);
    expect(r).toMatchObject({ repos_found: 4, added: 1, restored: 1, duplicates: 1, errors: 0 });
    expect(s.runs).toEqual([{ found: 4, queued: 2, cost_usd: expect.closeTo(0.012, 6), error: undefined }]);
  });

  it('stops without marking anything seen when the AI budget is spent', async () => {
    api([vid('v1', 72)], { v1: [owner('https://github.com/a/one')] });
    const s = setup({ budget: () => false });
    const r = await watchChannels(s.ctx);
    expect(s.stocked).toHaveLength(0);
    expect((s.store.watch as any).seen).toEqual([]);
    expect(r.skipped).toMatch(/budget/i);
  });

  it('does nothing and is not an error without YOUTUBE_API_KEY', async () => {
    vi.stubEnv('YOUTUBE_API_KEY', '');
    const calls = api([vid('v1', 72)]);
    const s = setup();
    const r = await watchChannels(s.ctx);
    expect(calls).toEqual([]);
    expect(r.skipped).toMatch(/YOUTUBE_API_KEY/);
    expect(r.errors).toBe(0);
    expect(s.runs).toEqual([]);
  });

  it('an API error on one channel does not stop the others', async () => {
    const other = 'UC' + 'b'.repeat(22);
    stubWatchApi({
      handles: { '@Bad': 'UC' + 'z'.repeat(22), '@Good': other },
      uploads: { ['UU' + 'b'.repeat(22)]: [vid('g1', 72)] },
      threads: { g1: [{ author: other, text: 'https://github.com/a/one' }] },
      fail: (kind, p) => (kind === 'playlistItems' && p.playlistId === 'UU' + 'z'.repeat(22) ? 500 : undefined),
    });
    const s = setup({ watch: { channels: [{ handle: '@Bad' }, { handle: '@Good' }], seen: [] } });
    const r = await watchChannels(s.ctx);
    expect(r).toMatchObject({ channels: 2, errors: 1, added: 1 });
    expect(s.runs[0].error).toMatch(/@Bad/);
  });

  it('stocks at most 25 repos a run and leaves the cut video unseen', async () => {
    const links = Array.from({ length: 30 }, (_, i) => `https://github.com/o/r${i}`).join(' ');
    api([vid('v1', 72)], { v1: [owner(links)] });
    const s = setup();
    const r = await watchChannels(s.ctx);
    expect(s.stocked).toHaveLength(25);
    expect(r.added).toBe(25);
    expect((s.store.watch as any).seen).toEqual([]);
  });

  it('does not mark a video seen when one of its repos errored', async () => {
    api([vid('v1', 72)], { v1: [owner('https://github.com/a/one https://github.com/b/two')] });
    const s = setup({ stock: (repo) => ({ status: repo === 'a/one' ? 'error' : 'added' }) });
    const r = await watchChannels(s.ctx);
    expect(r).toMatchObject({ added: 1, errors: 1 });
    expect((s.store.watch as any).seen).toEqual([]);
  });

  it('treats comments turned off as no comments, but a quota error as an error', async () => {
    api([vid('v1', 72)], {}, { fail: (k) => (k === 'commentThreads' ? [403, 'commentsDisabled'] : undefined) });
    const off = setup();
    expect((await watchChannels(off.ctx)).errors).toBe(0);
    expect((off.store.watch as any).seen).toEqual(['v1']);
    api([vid('v1', 72)], {}, { fail: (k) => (k === 'commentThreads' ? [403, 'quotaExceeded'] : undefined) });
    const quota = setup();
    expect((await watchChannels(quota.ctx)).errors).toBe(1);
    expect((quota.store.watch as any).seen).toEqual([]);
  });

  describe('saving while the admin edits', () => {
    const resolved = { handle: '@Chan', channel_id: CH, uploads: UPLOADS };
    /** Run with `edit` applied to the stored config in the middle of the run (at the first playlist call). */
    const runWithEdit = async (start: unknown, edit: unknown) => {
      const s = setup({ watch: start });
      const real = s.ctx.config;
      let reads = 0;
      s.ctx.config = async (k) => (++reads === 2 ? edit : real(k)); // the second read is the re-read at the end
      const r = await watchChannels(s.ctx);
      return { s, r };
    };
    it('keeps a handle the admin added mid-run, and the seen ids from both sides', async () => {
      api([vid('n1', 72)], {});
      const { s } = await runWithEdit({ channels: [{ handle: '@Chan' }], seen: ['old'] }, { channels: [{ handle: '@Chan' }, { handle: '@Added' }], seen: ['old', 'adminseen'] });
      const w = s.store.watch as any;
      expect(w.channels).toEqual([resolved, { handle: '@Added' }]);
      expect(w.seen).toEqual(['old', 'adminseen', 'n1']);
    });
    it('does not bring back a handle the admin removed mid-run, nor its resolved ids', async () => {
      api([vid('n1', 72)], {});
      const { s } = await runWithEdit({ channels: [{ handle: '@Chan' }], seen: [] }, { channels: [{ handle: '@Other' }], seen: [] });
      const w = s.store.watch as any;
      expect(w.channels).toEqual([{ handle: '@Other' }]);
      expect(JSON.stringify(w)).not.toContain(CH);
    });
    it('dedupes merged seen ids and keeps the newest 300', async () => {
      api([vid('n1', 72)], {});
      const cur = Array.from({ length: 300 }, (_, i) => `s${i}`);
      const { s } = await runWithEdit({ channels: [{ handle: '@Chan' }], seen: [] }, { channels: [{ handle: '@Chan' }], seen: [...cur, 'n1'] });
      const seen = (s.store.watch as any).seen as string[];
      expect(seen).toHaveLength(300);
      expect(seen.at(-1)).toBe('n1');
      expect(seen[0]).toBe('s1');
      expect(new Set(seen).size).toBe(300);
    });
  });
});
