import { describe, expect, it } from 'vitest';
import { compactStars, formatStars, starsLabel } from '../src/lib/stars.ts';
import { GLYPHS, textWidth } from '../src/store/pixelText.ts';

describe('formatStars', () => {
  it('999 stays 999, thousands get one decimal, millions too', () => {
    expect(formatStars(0)).toBe('0');
    expect(formatStars(999)).toBe('999');
    expect(formatStars(1000)).toBe('1k');
    expect(formatStars(1234)).toBe('1.2k');
    expect(formatStars(12400)).toBe('12.4k');
    expect(formatStars(999949)).toBe('999.9k');
    expect(formatStars(1200000)).toBe('1.2M');
  });
  it('never prints 1000k and drops a trailing .0', () => {
    expect(formatStars(999999)).toBe('1M');
    expect(formatStars(2000000)).toBe('2M');
  });
});

describe('compactStars (shelf spines have room for about 3 characters)', () => {
  it('is whole thousands or millions', () => {
    expect(compactStars(999)).toBe('999');
    expect(compactStars(1234)).toBe('1k');
    expect(compactStars(12400)).toBe('12k');
    expect(compactStars(1200000)).toBe('1M');
    expect(compactStars(999999)).toBe('1M');
    expect(compactStars(340000)).toBe('340k');
  });
  it('is never longer than 4 characters, and every character can be drawn', () => {
    for (const n of [0, 5, 999, 1000, 9999, 99999, 999499, 999500, 5e6, 5e9]) {
      const s = compactStars(n);
      expect(s.length).toBeLessThanOrEqual(4);
      for (const ch of s) expect(GLYPHS[ch]).toBeDefined();
    }
  });
});

describe('starsLabel (what a tape shows, if anything)', () => {
  it('shows stars only for repo and community tapes that have a count', () => {
    expect(starsLabel({ kind: 'repo', stars: 12400 })).toBe('★ 12.4k');
    expect(starsLabel({ kind: 'community', stars: 5 })).toBe('★ 5');
    expect(starsLabel({ kind: 'skill', stars: 99 })).toBeNull();
    expect(starsLabel({ kind: 'repo', stars: null })).toBeNull();
  });
});

describe('pixel text', () => {
  it('measures with one pixel between glyphs', () => {
    expect(textWidth('12k')).toBe(3 + 1 + 3 + 1 + 3);
    expect(textWidth('')).toBe(0);
  });
});
