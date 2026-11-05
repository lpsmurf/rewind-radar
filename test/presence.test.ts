import { describe, expect, it } from 'vitest';
import { visitorsFromPresence } from '../src/store/presence.ts';
import { H, W } from '../src/store/movement.ts';
import { staleThenFresh } from './helpers/presence.ts';

describe('visitorsFromPresence', () => {
  it('uses the last meta of each key, so a later entry beats a stale one', () => {
    const v = visitorsFromPresence(staleThenFresh, 'me~1').find((o) => o.id === 'ann~1')!;
    expect(v.aisle).toBe('arcade');
    expect(v).toMatchObject({ x: 40, y: 264 });
  });
  it('leaves out my own key', () => {
    expect(visitorsFromPresence(staleThenFresh, 'me~1').map((o) => o.id)).toEqual(['ann~1', 'bob~1']);
  });
  it('caps the name at 30, clamps x/y, and falls back on a bad colour', () => {
    const v = visitorsFromPresence(staleThenFresh, 'me~1').find((o) => o.id === 'bob~1')!;
    expect(v.name).toHaveLength(30);
    expect(v).toMatchObject({ x: W, y: 0, color: '#fff6d5' });
  });
  it('lets a live broadcast position win over presence', () => {
    const live = new Map([['ann~1', { x: 7, y: 8 }]]);
    expect(visitorsFromPresence(staleThenFresh, 'me~1', live).find((o) => o.id === 'ann~1')).toMatchObject({ x: 7, y: 8 });
    expect(H).toBeGreaterThan(0);
  });
  it('reads a room field, and survives an empty meta list', () => {
    const v = visitorsFromPresence({ 'a~1': [{ room: 'arcade' }], 'b~1': [], 'c~1': [{ room: 'store' }] }, 'me~1');
    expect(v.find((o) => o.id === 'a~1')!.aisle).toBe('arcade');
    expect(v.find((o) => o.id === 'c~1')!.aisle).toBe('entrance');
    expect(v.find((o) => o.id === 'b~1')!.name).toBe('GUEST');
  });
});
