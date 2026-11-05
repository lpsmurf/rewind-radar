import { describe, expect, it } from 'vitest';
import { stockedTape } from '../lib/sources/stock.ts';
import { facts } from './helpers/samples.ts';

const REVIEW = { genre: 'Dev Workflow', blurb: 'b', ring: 'trial', rating: 4 } as any;
const NOW = new Date('2026-11-05T00:00:00Z');
const trust = (o: Parameters<typeof facts>[0]) => stockedTape(facts(o), REVIEW, {}, NOW).trust;

describe('stockedTape trust', () => {
  it("is 'clean' only for a licensed, unarchived repo pushed within 365 days", () => {
    expect(trust({ license: 'MIT', pushed_at: '2026-10-01T00:00:00Z' })).toBe('clean');
    expect(trust({ license: 'MIT', pushed_at: '2025-11-06T00:00:00Z' })).toBe('clean'); // 364 days
  });
  it("is 'caution' without a licence, when archived, or when stale", () => {
    expect(trust({ license: null })).toBe('caution');
    expect(trust({ archived: true })).toBe('caution');
    expect(trust({ pushed_at: '2025-11-04T00:00:00Z' })).toBe('caution'); // 366 days
    expect(trust({ pushed_at: null as any })).toBe('caution'); // unknown push date counts as stale
  });
});
