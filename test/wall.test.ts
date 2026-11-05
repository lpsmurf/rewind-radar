import { describe, expect, it } from 'vitest';
import { WALL_SHELVES, TV_RECT, wallSlot, wallSplit } from '../src/store/wall.ts';
import { formatStars } from '../src/lib/stars.ts';
import { starCountWidth } from '../src/store/pixelText.ts';

describe('back-wall shelves', () => {
  it('weekly has 6 boxes per row, 24-ish px apart, 2 rows', () => {
    expect(WALL_SHELVES.weekly.perRow).toBe(6);
    expect(WALL_SHELVES.weekly.pitch).toBeGreaterThanOrEqual(22);
    expect(WALL_SHELVES.weekly.perRow * 2).toBe(12);
  });
  it('every slot sits inside its shelf, and its label fits under the box with a gap', () => {
    for (const sh of Object.values(WALL_SHELVES)) {
      for (let i = 0; i < sh.perRow * 2; i++) {
        const s = wallSlot(sh, i);
        expect(s.x).toBeGreaterThanOrEqual(sh.x);
        expect(s.x + 14).toBeLessThanOrEqual(sh.x + sh.w);
        expect(s.labelY).toBeGreaterThan(s.y + 20);
      }
      // widest label we expect on a spine: 999K, with the star sprite, still leaves a gap of 2px
      expect(starCountWidth(formatStars(999000).toUpperCase())).toBeLessThanOrEqual(sh.pitch - 2);
      expect(starCountWidth(formatStars(1200000).toUpperCase())).toBeLessThanOrEqual(sh.pitch - 2);
    }
  });
  it('shelves do not overlap each other or the TV', () => {
    const rs = Object.values(WALL_SHELVES).sort((a, b) => a.x - b.x);
    for (let i = 1; i < rs.length; i++) expect(rs[i - 1].x + rs[i - 1].w).toBeLessThanOrEqual(rs[i].x);
    expect(rs[rs.length - 1].x + rs[rs.length - 1].w).toBeLessThanOrEqual(TV_RECT.x);
  });
});

describe('wallSplit (what fits, and how many are left for the browser)', () => {
  it('shows the first N and counts the rest', () => {
    const list = Array.from({ length: 15 }, (_, i) => i);
    expect(wallSplit(list, 12)).toEqual({ shown: list.slice(0, 12), more: 3, firstHidden: 12 });
    expect(wallSplit([1, 2], 12)).toEqual({ shown: [1, 2], more: 0, firstHidden: -1 });
  });
});
