import { describe, expect, it } from 'vitest';
import { isConfigKey, parseSourceConfig } from '../lib/sources/config.ts';
import { handlesOf, isHandle, watchSummaryLine } from '../src/lib/adminPanel.ts';

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
  it('works with nothing stored yet, and allows an empty list', () => {
    expect(parse({ channels: [{ handle: '@abc' }] }, null).value).toEqual({ channels: [{ handle: '@abc' }], seen: [] });
    expect(parse({ channels: [] }).value.channels).toEqual([]);
  });
  it('drops repeats in any case', () => {
    expect(parse({ channels: ['@Same', '@same'] }).value.channels).toHaveLength(1);
  });
  it('refuses bad shapes and handles, and more than 10', () => {
    for (const bad of [null, [], { channels: 'x' }, { channels: ['nohandle'] }, { channels: ['@ab'] }, { channels: ['@' + 'a'.repeat(31)] }, { channels: ['@has space'] }, { channels: [{}] }, { channels: [5] }, { channels: ['@a/b'] }]) {
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
