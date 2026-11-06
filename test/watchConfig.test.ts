import { describe, expect, it } from 'vitest';
import { isConfigKey, parseSourceConfig } from '../lib/sources/config.ts';
import { channelState, handlesOf, isHandle, watchSummaryLine } from '../src/lib/adminPanel.ts';

const CUR = {
  channels: [{ handle: '@TheNextNewThingAI', channel_id: 'UC' + 'a'.repeat(22), uploads: 'UU' + 'a'.repeat(22) }, { handle: '@Other' }],
  seen: ['v1', 'v2'],
};
const parse = (v: unknown, cur: unknown = CUR) => parseSourceConfig('watch', v, cur) as any;

describe('parseSourceConfig watch', () => {
  it('is an editable key', () => expect(isConfigKey('watch')).toBe(true));
  it('keeps seen and resolved ids for handles that stay, whatever the client sends', () => {
    const r = parse({ channels: [{ handle: '@thenextnewthingai', channel_id: 'UCevil', uploads: 'UUevil' }, { handle: '@Other' }], seen: ['hack'] });
    expect(r.value.seen).toEqual(['v1', 'v2']);
    expect(r.value.channels).toEqual([{ handle: '@thenextnewthingai', channel_id: 'UC' + 'a'.repeat(22), uploads: 'UU' + 'a'.repeat(22) }, { handle: '@Other' }]);
  });
  it('accepts plain handle strings, and a new handle starts unresolved', () => {
    expect(parse({ channels: ['@TheNextNewThingAI', ' @Fresh_One '] }).value.channels).toEqual([CUR.channels[0], { handle: '@Fresh_One' }]);
  });
  it('normalises links and ids: a handle is stored as @handle, a UC id as channel_id', () => {
    const UC = 'UC' + 'b'.repeat(22);
    const r = parse({ channels: ['https://www.youtube.com/@Fresh_One/videos?x=1', 'bare.name', `https://www.youtube.com/channel/${UC}`, { channel_id: UC }, 'youtube.com/@thenextnewthingai'] });
    expect(r.error).toBeUndefined();
    expect(r.value.channels).toEqual([{ handle: '@Fresh_One' }, { handle: '@bare.name' }, { channel_id: UC }, { ...CUR.channels[0], handle: '@thenextnewthingai' }]);
  });
  it('keeps the resolved uploads of an unchanged channel_id entry, not of a different one', () => {
    const UC = 'UC' + 'b'.repeat(22);
    const cur = { channels: [{ channel_id: UC, uploads: 'UU' + 'b'.repeat(22) }], seen: [] };
    expect(parse({ channels: [UC] }, cur).value.channels).toEqual(cur.channels);
    expect(parse({ channels: ['UC' + 'c'.repeat(22)] }, cur).value.channels).toEqual([{ channel_id: 'UC' + 'c'.repeat(22) }]);
  });
  it('refuses video, /c/ and /user/ links with a clear message', () => {
    for (const bad of ['https://www.youtube.com/watch?v=dQw4w9WgXcQ', 'https://www.youtube.com/c/Name', 'https://www.youtube.com/user/Name', 'random text']) {
      expect(parse({ channels: [bad] }).error, bad).toBe('Use a channel link, @handle or channel ID');
    }
  });
  it('works with nothing stored yet, and allows an empty list', () => {
    expect(parse({ channels: [{ handle: '@abc' }] }, null).value).toEqual({ channels: [{ handle: '@abc' }], seen: [] });
    expect(parse({ channels: [] }).value.channels).toEqual([]);
  });
  it('drops repeats in any case', () => {
    expect(parse({ channels: ['@Same', '@same'] }).value.channels).toHaveLength(1);
  });
  it('refuses bad shapes and handles, and more than 10', () => {
    for (const bad of [null, [], { channels: 'x' }, { channels: ['@ab'] }, { channels: ['@' + 'a'.repeat(31)] }, { channels: ['@has space'] }, { channels: [{}] }, { channels: [5] }, { channels: ['@a/b'] }]) {
      expect(parse(bad).error, JSON.stringify(bad)).toBeTruthy();
    }
    expect(parse({ channels: Array.from({ length: 11 }, (_, i) => `@chan${i}`) }).error).toMatch(/At most 10/);
    expect(parse({ channels: Array.from({ length: 10 }, (_, i) => `@chan${i}`) }).error).toBeUndefined();
  });
  it('leaves youtube and web validation as they were', () => {
    expect(parseSourceConfig('web', { query: ' q ' })).toEqual({ value: { query: 'q' } });
    expect((parseSourceConfig('youtube', { queries: [], channels: [] }) as any).error).toBeTruthy();
  });
});

describe('watch panel helpers', () => {
  it('isHandle matches the server rule', () => {
    expect(isHandle('@TheNextNewThingAI')).toBe(true);
    expect(isHandle('@a.b-c_d')).toBe(true);
    for (const bad of ['TheNextNewThingAI', '@ab', '@' + 'a'.repeat(31), '@a b', '@a/b', '']) expect(isHandle(bad)).toBe(false);
  });
  it('handlesOf trims, adds a missing @, drops blanks and repeats', () => {
    expect(handlesOf(' @Foo \n\nbar\n@FOO\r\n@baz')).toEqual(['@Foo', '@bar', '@baz']);
    expect(handlesOf('')).toEqual([]);
  });
  it('watchSummaryLine says what happened, or why it did not run', () => {
    const r = { channels: 1, videos_checked: 2, repos_found: 9, added: 3, restored: 1, duplicates: 5, errors: 0 };
    expect(watchSummaryLine(r)).toBe('1 channel · 2 new videos · 9 repos found · added 3 · restored 1 · already in store 5');
    expect(watchSummaryLine({ ...r, errors: 2 })).toMatch(/ · 2 errors$/);
    expect(watchSummaryLine({ ...r, skipped: 'YOUTUBE_API_KEY is not set' })).toBe('Skipped: YOUTUBE_API_KEY is not set');
  });
});

describe('parseSourceConfig watch keeps the backfill state', () => {
  const UC = 'UC' + 'b'.repeat(22);
  const AT = '2026-11-01T08:00:00.000Z';
  const cur = {
    channels: [
      { handle: '@Done', channel_id: 'UC' + 'a'.repeat(22), uploads: 'UU' + 'a'.repeat(22), backfilled_at: AT },
      { handle: '@Busy', backfill_left: 7 },
      { channel_id: UC, backfilled_at: AT },
    ],
    seen: [],
  };
  it('keeps backfilled_at and backfill_left of unchanged entries, resolved or not, whatever the client sends', () => {
    const r = parse({ channels: [{ handle: '@done', backfilled_at: 'hack' }, '@Busy', UC] }, cur);
    expect(r.value.channels).toEqual([
      { handle: '@done', channel_id: 'UC' + 'a'.repeat(22), uploads: 'UU' + 'a'.repeat(22), backfilled_at: AT },
      { handle: '@Busy', backfill_left: 7 },
      { channel_id: UC, backfilled_at: AT },
    ]);
  });
  it('a newly added channel starts without backfilled_at, so it backfills on its own', () => {
    const r = parse({ channels: ['@Done', { handle: '@Brand_New', backfilled_at: AT }] }, cur);
    expect(r.value.channels[1]).toEqual({ handle: '@Brand_New' });
  });
  it('a removed channel is gone, and adding it back later starts a fresh backfill', () => {
    const gone = parse({ channels: ['@Done'] }, cur);
    expect(gone.value.channels).toHaveLength(1);
    expect(parse({ channels: ['@Done', '@Busy'] }, gone.value).value.channels[1]).toEqual({ handle: '@Busy' });
  });
});

describe('channelState', () => {
  it('says backfilling, with the videos left when known', () => {
    expect(channelState({ handle: '@a' })).toBe('backfilling');
    expect(channelState({ handle: '@a', backfill_left: 7 })).toBe('backfilling (7 videos left)');
    expect(channelState({ handle: '@a', backfill_left: 1 })).toBe('backfilling (1 video left)');
  });
  it('says up to date since the date once backfilled', () => {
    expect(channelState({ handle: '@a', backfilled_at: '2026-11-01T08:00:00.000Z' })).toBe('up to date since 2026-11-01');
  });
});
