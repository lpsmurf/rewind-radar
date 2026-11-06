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

  it('resolves a channel_id-only entry with channels.list?id and stores its uploads', async () => {
    const calls = api([vid('v1', 72)], { v1: [owner('https://github.com/a/one')] });
    const s = setup({ watch: { channels: [{ channel_id: CH }], seen: [] } });
    const r = await watchChannels(s.ctx);
    const ch = calls.filter((c) => c.kind === 'channels');
    expect(ch).toHaveLength(1);
    expect(ch[0].params).toMatchObject({ id: CH, part: 'contentDetails', key: 'test-key' });
    expect(ch[0].params.forHandle).toBeUndefined();
    expect(s.stocked.map((x) => x.repo)).toEqual(['a/one']);
    expect(r.errors).toBe(0);
    expect((s.store.watch as any).channels).toEqual([{ channel_id: CH, uploads: UPLOADS }]);
    await watchChannels(s.ctx);
    expect(calls.filter((c) => c.kind === 'channels')).toHaveLength(1);
  });

  it('reports an unknown channel_id by id, and keeps going', async () => {
    api([]);
    const s = setup({ watch: { channels: [{ channel_id: 'UC' + 'q'.repeat(22) }], seen: [] } });
    const r = await watchChannels(s.ctx);
    expect(r.errors).toBe(1);
    expect(r.messages?.[0]).toContain('UC' + 'q'.repeat(22));
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

  // SEEN_MAX was 300; raised to 1000 so a 4 month backfill never forgets ids.
  it('keeps only the newest 1000 seen ids', async () => {
    api([vid('n1', 72), vid('n2', 72)], {});
    const seen = Array.from({ length: 999 }, (_, i) => `s${i}`);
    const s = setup({ watch: { channels: [{ handle: '@Chan', channel_id: CH, uploads: UPLOADS }], seen } });
    await watchChannels(s.ctx);
    const after = (s.store.watch as any).seen as string[];
    expect(after).toHaveLength(1000);
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
    it('dedupes merged seen ids and keeps the newest 1000', async () => {
      api([vid('n1', 72)], {});
      const cur = Array.from({ length: 1000 }, (_, i) => `s${i}`);
      const { s } = await runWithEdit({ channels: [{ handle: '@Chan' }], seen: [] }, { channels: [{ handle: '@Chan' }], seen: [...cur, 'n1'] });
      const seen = (s.store.watch as any).seen as string[];
      expect(seen).toHaveLength(1000);
      expect(seen.at(-1)).toBe('n1');
      expect(seen[0]).toBe('s1');
      expect(new Set(seen).size).toBe(1000);
    });
  });
});

describe('watchChannels backfill', () => {
  const daysAgo = (d: number) => d * 24;
  const pages = (calls: ReturnType<typeof api>) => calls.filter((c) => c.kind === 'playlistItems');
  /** n videos, newest first, one per day starting `from` days ago. */
  const many = (n: number, from = 1) => Array.from({ length: n }, (_, i) => vid(`v${i + 1}`, daysAgo(from + i)));
  const link = (ids: string[]) => Object.fromEntries(ids.map((id) => [id, [owner(`https://github.com/o/${id}`)]]));

  it('keeps the 14 day window and one page of 5 by default', async () => {
    const calls = api(many(30));
    await watchChannels(setup().ctx);
    expect(pages(calls)).toHaveLength(1);
    expect(pages(calls)[0].params).toMatchObject({ maxResults: '5' });
  });

  it('pages 50 at a time with pageToken and stops once items are older than the window', async () => {
    const calls = api(many(150)); // v1 is 1 day old, v150 150 days old
    await watchChannels(setup().ctx, { days: 120 });
    const p = pages(calls);
    expect(p.map((c) => c.params.maxResults)).toEqual(['50', '50', '50']);
    expect(p.map((c) => c.params.pageToken)).toEqual([undefined, '50', '100']); // page 3 holds v101..v150, v121+ is out of window
  });

  it('reads at most 4 pages', async () => {
    const calls = api(many(400, 1));
    await watchChannels(setup().ctx, { days: 180 });
    expect(pages(calls)).toHaveLength(4);
  });

  it('processes the oldest videos first, 10 per call', async () => {
    api(many(25, 20), link(many(25, 20).map((v) => v.id)));
    const s = setup();
    const r = await watchChannels(s.ctx, { days: 60 });
    expect(r.videos_checked).toBe(10);
    expect(s.stocked.map((x) => x.repo)).toEqual(many(25, 20).slice(-10).reverse().map((v) => `o/${v.id}`));
    expect(r.remaining).toBe(15);
  });

  it('counts remaining down across repeated calls until 0', async () => {
    api(many(25, 20), link(many(25, 20).map((v) => v.id)));
    const s = setup();
    const left: number[] = [];
    for (let i = 0; i < 4; i++) left.push((await watchChannels(s.ctx, { days: 60 })).remaining);
    expect(left).toEqual([15, 5, 0, 0]);
    expect(s.stocked).toHaveLength(25);
  });

  it('clamps days to 1..180', async () => {
    const calls = api(many(5, 1));
    await watchChannels(setup().ctx, { days: 9999 });
    expect(pages(calls)[0].params.maxResults).toBe('50');
    // 1 day: only a video under a day old is in window
    api([vid('new', 5), vid('old', 30)], { new: [owner('https://github.com/a/new')], old: [owner('https://github.com/a/old')] });
    const s = setup();
    await watchChannels(s.ctx, { days: -5 });
    expect(s.stocked.map((x) => x.repo)).toEqual(['a/new']);
    api([vid('d100', daysAgo(100))], { d100: [owner('https://github.com/a/d100')] });
    const t = setup();
    await watchChannels(t.ctx, { days: 1000 });
    expect(t.stocked).toHaveLength(1);
    api([vid('d200', daysAgo(200))], { d200: [owner('https://github.com/a/d200')] });
    const u = setup();
    await watchChannels(u.ctx, { days: 1000 });
    expect(u.stocked).toHaveLength(0);
  });

  it('keeps every seen id across a 30 video backfill', async () => {
    api(many(30, 20));
    const s = setup();
    for (let i = 0; i < 3; i++) await watchChannels(s.ctx, { days: 90 });
    expect((s.store.watch as any).seen).toHaveLength(30);
  });

  it('marks old videos without links seen and reports remaining 0', async () => {
    api(many(3, 5));
    const s = setup();
    const r = await watchChannels(s.ctx, { days: 30 });
    expect(r.remaining).toBe(0);
    expect((s.store.watch as any).seen).toHaveLength(3);
  });
});

describe('watchChannels automatic backfill (cron path, auto: true)', () => {
  const daysAgo = (d: number) => hoursAgo(d * 24);
  const resolved = { handle: '@Chan', channel_id: CH, uploads: UPLOADS };

  it('gives a channel without backfilled_at the 120 day window and pages 50 at a time', async () => {
    const calls = api([vid('old', 24 * 100), vid('older', 24 * 130)], {});
    const s = setup();
    const r = await watchChannels(s.ctx, { auto: true });
    expect(calls.find((c) => c.kind === 'playlistItems')!.params.maxResults).toBe('50');
    expect(r.videos_checked).toBe(1); // 100 days old is inside 120, 130 is not
  });
  it('gives a channel with backfilled_at only the 14 day window and one page of 5', async () => {
    const calls = api([vid('old', 24 * 100), vid('recent', 72)], {});
    const s = setup({ watch: { channels: [{ ...resolved, backfilled_at: daysAgo(1) }], seen: [] } });
    const r = await watchChannels(s.ctx, { auto: true });
    expect(calls.find((c) => c.kind === 'playlistItems')!.params.maxResults).toBe('5');
    expect(r.videos_checked).toBe(1);
    expect(s.stocked).toEqual([]);
  });
  it('mixes windows per channel', async () => {
    const CH2 = 'UC' + 'b'.repeat(22);
    stubWatchApi({
      handles: { '@Chan': CH, '@Two': CH2 },
      uploads: { [UPLOADS]: [vid('a', 24 * 60)], ['UU' + 'b'.repeat(22)]: [vid('b', 24 * 60)] },
    });
    const s = setup({ watch: { channels: [{ handle: '@Chan' }, { handle: '@Two', backfilled_at: daysAgo(1) }], seen: [] } });
    const r = await watchChannels(s.ctx, { auto: true });
    expect(r.videos_checked).toBe(1);
  });
  it('without auto, a config without backfilled_at still uses 14 days and sets nothing', async () => {
    api([vid('old', 24 * 60)], {});
    const s = setup();
    const r = await watchChannels(s.ctx);
    expect(r.videos_checked).toBe(0);
    expect((s.store.watch as any).channels[0].backfilled_at).toBeUndefined();
  });
  it('sets backfilled_at when remaining reaches 0', async () => {
    api([vid('a', 24 * 100)], {});
    const s = setup();
    const r = await watchChannels(s.ctx, { auto: true });
    expect(r.remaining).toBe(0);
    expect((s.store.watch as any).channels[0].backfilled_at).toBe(NOW.toISOString());
  });
  it('keeps backfilling (no backfilled_at) while videos remain, and records how many are left', async () => {
    api(Array.from({ length: 45 }, (_, i) => vid(`v${i}`, 24 * (100 - i))), {}); // the cron batch loop stops at 40 videos
    const s = setup();
    const r = await watchChannels(s.ctx, { auto: true });
    expect(r.remaining).toBe(5);
    const ch = (s.store.watch as any).channels[0];
    expect(ch.backfilled_at).toBeUndefined();
    expect(ch.backfill_left).toBe(5);
    await watchChannels(s.ctx, { auto: true });
    const done = (s.store.watch as any).channels[0];
    expect(done.backfilled_at).toBe(NOW.toISOString());
    expect(done.backfill_left).toBeUndefined();
  });
  it('does not mark a channel whose API call failed', async () => {
    api([vid('a', 24 * 100)], {}, { fail: (k) => (k === 'playlistItems' ? 500 : undefined) });
    const s = setup();
    await watchChannels(s.ctx, { auto: true });
    expect((s.store.watch as any).channels[0].backfilled_at).toBeUndefined();
  });
  it('only marks handles still present, and never re-adds a removed one', async () => {
    api([vid('a', 24 * 100)], {});
    const s = setup();
    const real = s.ctx.config;
    let reads = 0;
    s.ctx.config = async (k) => (++reads === 2 ? { channels: [{ handle: '@Other' }], seen: [] } : real(k));
    await watchChannels(s.ctx, { auto: true });
    expect((s.store.watch as any).channels).toEqual([{ handle: '@Other' }]);
  });
  it('an existing backfilled_at survives the merge', async () => {
    api([], {});
    const at = daysAgo(3);
    const s = setup({ watch: { channels: [{ handle: '@Chan', backfilled_at: at }], seen: [] } });
    await watchChannels(s.ctx, { auto: true });
    expect((s.store.watch as any).channels[0]).toEqual({ ...resolved, backfilled_at: at });
  });
});

describe('watchChannels batch loop while backfilling (auto: true)', () => {
  const many = (n: number, o: (i: number) => Partial<WatchVideo> = () => ({})) => Array.from({ length: n }, (_, i) => vid(`v${i}`, 24 * (100 - i * 0.5), o(i)));
  const links = (id: string, k: number) => ({ [id]: [owner(Array.from({ length: k }, (_, j) => `https://github.com/${id}/r${j}`).join(' '))] });
  const playlistCalls = (calls: { kind: string }[]) => calls.filter((c) => c.kind === 'playlistItems').length;

  it('runs batches of 10 until nothing is left, and logs the run once', async () => {
    const calls = api(many(25));
    const s = setup();
    const r = await watchChannels(s.ctx, { auto: true });
    expect(r.videos_checked).toBe(25);
    expect(r.remaining).toBe(0);
    expect(playlistCalls(calls)).toBe(3);
    expect(s.runs).toHaveLength(1);
    expect((s.store.watch as any).channels[0].backfilled_at).toBe(NOW.toISOString());
  });
  it('stops at 40 videos', async () => {
    const calls = api(many(48)); // one playlist page of 50 per batch
    const s = setup();
    const r = await watchChannels(s.ctx, { auto: true });
    expect(r.videos_checked).toBe(40);
    expect(r.remaining).toBe(8);
    expect(playlistCalls(calls)).toBe(4);
    expect((s.store.watch as any).channels[0].backfilled_at).toBeUndefined();
    expect((s.store.watch as any).channels[0].backfill_left).toBe(8);
  });
  it('stops at 60 repos stocked, with no batch stocking past it', async () => {
    const vids = many(30);
    api(vids, Object.assign({}, ...vids.map((v) => links(v.id, 3))));
    const s = setup();
    const r = await watchChannels(s.ctx, { auto: true });
    expect(s.stocked).toHaveLength(60);
    expect(r.added).toBe(60);
    expect(r.remaining).toBeGreaterThan(0);
    expect(r.videos_checked).toBeLessThan(40);
  });
  it('stops when the AI budget is spent', async () => {
    const calls = api(many(48));
    let n = 0;
    const s = setup({ budget: () => n++ < 10 });
    const r = await watchChannels(s.ctx, { auto: true });
    expect(r.videos_checked).toBe(10);
    expect(r.skipped).toMatch(/budget/);
    expect(playlistCalls(calls)).toBe(2);
  });
  it('stops after 100 s of wall time, measured by ctx.clock', async () => {
    const calls = api(many(48));
    const s = setup();
    let t = 0;
    s.ctx.clock = () => t;
    s.ctx.stock = async () => ({ status: 'added' });
    // each batch costs 60 s: the first batch ends at 60 s (carry on), the second at 120 s (stop)
    const cfg = s.ctx.config;
    s.ctx.config = async (k) => {
      const v = await cfg(k);
      t += 30_000; // two config reads per batch
      return v;
    };
    const r = await watchChannels(s.ctx, { auto: true });
    expect(r.videos_checked).toBe(20);
    expect(playlistCalls(calls)).toBe(2);
  });
  it('does not stop early on the clock when the batches are quick', async () => {
    api(many(48));
    const s = setup();
    s.ctx.clock = () => 5_000;
    const r = await watchChannels(s.ctx, { auto: true });
    expect(r.videos_checked).toBe(40);
  });
  it('a normal run (nothing backfilling) keeps one batch and the latest 5', async () => {
    const calls = api(Array.from({ length: 20 }, (_, i) => vid(`v${i}`, 72 + i)));
    const s = setup({ watch: { channels: [{ handle: '@Chan', channel_id: CH, uploads: UPLOADS, backfilled_at: hoursAgo(5) }], seen: [] } });
    const r = await watchChannels(s.ctx, { auto: true });
    expect(r.videos_checked).toBe(5); // a normal run reads the latest 5
    expect(playlistCalls(calls)).toBe(1);
  });
  it('stops when a batch makes no progress instead of looping', async () => {
    const calls = api(many(5), {}, { fail: (k) => (k === 'commentThreads' ? 500 : undefined) });
    const s = setup();
    await watchChannels(s.ctx, { auto: true });
    expect(playlistCalls(calls)).toBeLessThanOrEqual(2);
  });
  it('the explicit admin run stays one batch of 10 even with an unfinished channel', async () => {
    const calls = api(many(25));
    const s = setup();
    const r = await watchChannels(s.ctx, { days: 120 });
    expect(r.videos_checked).toBe(10);
    expect(r.remaining).toBe(15);
    expect(playlistCalls(calls)).toBe(1);
  });
});
