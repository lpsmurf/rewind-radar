import { describe, expect, it } from 'vitest';
import { joinPicks, latestPicks, MONTHLY_PLACEHOLDER, monthLabel, type PickRow } from '../src/store/monthly.ts';
import { MOCK_TAPES } from '../src/data/mock.ts';
import { ARCADE_CABINETS, DOOR, FLOOR, SHELVES } from '../src/store/movement.ts';

const row = (month: string, rank: number, tape_slug: string): PickRow => ({ month, rank, tape_slug });
const tape = (slug: string, id = `id-${slug}`) => ({ ...MOCK_TAPES[0], id, slug, votes: 0 });

describe('latestPicks', () => {
  it('keeps only the most recent month, in rank order', () => {
    const rows = [row('2026-09-01', 1, 'old'), row('2026-10-01', 2, 'b'), row('2026-10-01', 1, 'a'), row('2026-09-01', 2, 'older')];
    expect(latestPicks(rows)).toEqual([row('2026-10-01', 1, 'a'), row('2026-10-01', 2, 'b')]);
  });
  it('is empty when there are no picks yet', () => {
    expect(latestPicks([])).toEqual([]);
  });
  it('caps the shelf at 10', () => {
    const rows = Array.from({ length: 12 }, (_, i) => row('2026-10-01', i + 1, `t${i}`));
    expect(latestPicks(rows)).toHaveLength(10);
  });
});

describe('joinPicks', () => {
  it('joins tapes by slug in rank order, with their votes, dropping picks whose tape is gone', () => {
    const picks = [row('2026-10-01', 1, 'b'), row('2026-10-01', 2, 'gone'), row('2026-10-01', 3, 'a')];
    const out = joinPicks(picks, [tape('a'), tape('b')], new Map([['id-b', 7]]));
    expect(out.map((t) => [t.slug, t.votes])).toEqual([['b', 7], ['a', 0]]);
  });
});

describe('monthLabel', () => {
  it('names the month for the shelf', () => {
    expect(monthLabel('2026-10-01')).toBe('OCT 2026');
    expect(monthLabel('2026-01-01')).toBe('JAN 2026');
  });
});

describe('placeholder', () => {
  it('tells visitors when the first picks arrive', () => {
    expect(MONTHLY_PLACEHOLDER.join(' ').toLowerCase()).toContain('first picks');
    expect(MONTHLY_PLACEHOLDER.join(' ').toLowerCase()).toContain('1st');
  });
});

describe('movement obstacles are unchanged by the monthly shelf (it sits on the back wall, above the floor)', () => {
  it('every shelf, the counter and the door stay below the back wall; nothing new blocks the floor', () => {
    expect(SHELVES).toHaveLength(9);
    for (const s of SHELVES) expect(s.y).toBeGreaterThanOrEqual(FLOOR.y);
    expect(DOOR.y).toBeGreaterThanOrEqual(FLOOR.y);
    expect(ARCADE_CABINETS).toHaveLength(5);
  });
});
