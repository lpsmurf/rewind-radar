import { describe, expect, it } from 'vitest';
import { acceptMove, capName, REMOTE_MAX, rememberPos, safeColor } from '../src/store/remote.ts';
import { H, W } from '../src/store/movement.ts';

const present = new Set(['bob~1', 'eve~1']);

describe('acceptMove', () => {
  it('accepts a move from someone in presence', () => {
    expect(acceptMove({ key: 'bob~1', x: 100, y: 200 }, present, 'me~1')).toEqual({ key: 'bob~1', x: 100, y: 200 });
  });
  it('ignores keys that are not in presence (spoofed or already gone) and my own key', () => {
    expect(acceptMove({ key: 'ghost~9', x: 1, y: 1 }, present, 'me~1')).toBeNull();
    expect(acceptMove({ key: 'me~1', x: 1, y: 1 }, new Set(['me~1']), 'me~1')).toBeNull();
  });
  it('clamps x and y to the canvas', () => {
    expect(acceptMove({ key: 'bob~1', x: -5000, y: 1e308 }, present, 'me~1')).toEqual({ key: 'bob~1', x: 0, y: H });
    expect(acceptMove({ key: 'bob~1', x: 9999, y: -1 }, present, 'me~1')).toEqual({ key: 'bob~1', x: W, y: 0 });
  });
  it('rejects malformed payloads', () => {
    for (const p of [null, undefined, {}, { key: 5, x: 1, y: 1 }, { key: 'bob~1', x: NaN, y: 1 }, { key: 'bob~1', x: '1', y: 1 }, { key: 'bob~1', x: 1, y: Infinity }]) {
      expect(acceptMove(p, present, 'me~1')).toBeNull();
    }
  });
});

describe('rememberPos', () => {
  it('caps the map at 200 entries, dropping the oldest', () => {
    const m = new Map<string, { x: number; y: number }>();
    for (let i = 0; i < REMOTE_MAX + 50; i++) rememberPos(m, `k${i}`, { x: i, y: 0 });
    expect(REMOTE_MAX).toBe(200);
    expect(m.size).toBe(200);
    expect(m.has('k0')).toBe(false);
    expect(m.has('k249')).toBe(true);
  });
  it('an update moves a key to the newest end', () => {
    const m = new Map<string, { x: number; y: number }>();
    rememberPos(m, 'a', { x: 1, y: 1 }, 2); rememberPos(m, 'b', { x: 1, y: 1 }, 2); rememberPos(m, 'a', { x: 2, y: 2 }, 2); rememberPos(m, 'c', { x: 1, y: 1 }, 2);
    expect([...m.keys()]).toEqual(['a', 'c']);
  });
});

describe('presence fields', () => {
  it('caps a name at 30 characters and drops non-strings', () => {
    expect(capName('x'.repeat(500))).toHaveLength(30);
    expect(capName('GUEST-AB12')).toBe('GUEST-AB12');
    expect(capName({ a: 1 })).toBeUndefined();
    expect(capName(undefined)).toBeUndefined();
  });
  it('only passes plain hex colours', () => {
    expect(safeColor('#ff4d6d', '#000')).toBe('#ff4d6d');
    expect(safeColor('url(evil)', '#123456')).toBe('#123456');
    expect(safeColor(5, '#123456')).toBe('#123456');
  });
});
