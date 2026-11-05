import { describe, expect, it } from 'vitest';
import { formatStars, ratingLabel, starsLabel } from '../src/lib/stars.ts';
import { GLYPHS, STAR, ellipsize, textWidth, wallStarLabel } from '../src/store/pixelText.ts';

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

describe('wall labels use the shared formatter, uppercased for the pixel font', () => {
  it('every character of a label can be drawn', () => {
    for (const n of [0, 5, 999, 1000, 1234, 2100, 9999, 12400, 350000, 999499, 1200000, 5e9]) {
      for (const ch of formatStars(n).toUpperCase()) expect(GLYPHS[ch]).toBeDefined();
    }
  });
  it('1.2M and 2.1K are not rounded to 1M / 2K', () => {
    expect(formatStars(1200000).toUpperCase()).toBe('1.2M');
    expect(formatStars(2100).toUpperCase()).toBe('2.1K');
  });
});

describe('starsLabel (what a tape shows, if anything)', () => {
  it('shows stars only for repo and community tapes that have a count', () => {
    expect(starsLabel({ kind: 'repo', stars: 12400 })).toBe('★ 12.4k on GitHub');
    expect(starsLabel({ kind: 'community', stars: 5 })).toBe('★ 5 on GitHub');
    expect(starsLabel({ kind: 'skill', stars: 99 })).toBeNull();
    expect(starsLabel({ kind: 'repo', stars: null })).toBeNull();
  });
});

describe('pixel text', () => {
  it('measures with one pixel between glyphs', () => {
    expect(textWidth('12K')).toBe(3 + 1 + 3 + 1 + 3);
    expect(textWidth('')).toBe(0);
  });
});

describe('pixel star sprite', () => {
  it('is a 5x5 star, not a font glyph', () => {
    expect(STAR).toHaveLength(5);
    for (const row of STAR) expect(row).toHaveLength(5);
  });
});

describe('ellipsize (one line on the TV)', () => {
  it('keeps short text and ends long text with three dots within the limit', () => {
    expect(ellipsize('skill-1', 10)).toBe('skill-1');
    expect(ellipsize('skill-1-design-kit', 10)).toBe('skill-1...');
    expect(ellipsize('skill-1-design-kit', 10)).toHaveLength(10);
    expect(ellipsize('abcdef', 3)).toBe('...');
  });
});

describe('ratingLabel (the clerk rating, kept apart from GitHub stars)', () => {
  it('reads RATING n/5 with no star glyph', () => {
    expect(ratingLabel(4)).toBe('RATING 4/5');
    expect(ratingLabel(3.6)).toBe('RATING 4/5');
    expect(ratingLabel(null)).toBeNull();
    expect(ratingLabel(4)).not.toContain('★');
  });
});

describe('wallStarLabel (always keeps the sprite; drops the decimal only when it cannot fit)', () => {
  it('uses the shared formatter, uppercased, when it fits', () => {
    expect(wallStarLabel(12400, 23)).toBe('12.4K');
    expect(wallStarLabel(640, 23)).toBe('640');
    expect(wallStarLabel(1200000, 23)).toBe('1.2M');
  });
  it('rounds to whole thousands when the long form is too wide', () => {
    expect(wallStarLabel(999900, 23)).toBe('1M');
    expect(wallStarLabel(12400, 18)).toBe('12K');
    expect(wallStarLabel(345678, 17)).toBe('346K');
  });
});
