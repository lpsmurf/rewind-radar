import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { backoffMs, createTrackGate, visitorsFromPresence, type PresencePayload } from '../src/store/presence.ts';
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

describe('backoffMs', () => {
  it('doubles from 1 s and caps at 30 s', () => {
    expect([0, 1, 2, 3, 4, 5, 6, 20].map(backoffMs)).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000]);
  });
});

describe('createTrackGate', () => {
  let t = 0;
  const sent: any[] = [];
  const mk = () => createTrackGate((p) => sent.push(p), { minMs: 8000, now: () => t });
  const p = (room: 'store' | 'arcade', extra = {}): PresencePayload => ({ name: 'N', color: '#fff', room, ...extra });
  beforeEach(() => { vi.useFakeTimers(); t = 0; sent.length = 0; });
  afterEach(() => vi.useRealTimers());
  const wait = (ms: number) => { t += ms; vi.advanceTimersByTime(ms); };

  it('sends the first update at once and drops an identical repeat', () => {
    const g = mk();
    g.update(p('store'));
    g.update(p('store', { x: 5, y: 5 })); // position alone is not presence-worthy
    expect(sent).toHaveLength(1);
  });
  it('sends a room change immediately', () => {
    const g = mk();
    g.update(p('store'));
    wait(100);
    g.update(p('arcade'));
    expect(sent.map((s) => s.room)).toEqual(['store', 'arcade']);
  });
  it('coalesces a burst of name changes and sends the trailing value', () => {
    const g = mk();
    g.update(p('store'));
    wait(100);
    g.update(p('store', { name: 'A' }));
    g.update(p('store', { name: 'B' }));
    g.update(p('store', { name: 'C' }));
    expect(sent).toHaveLength(1);
    wait(8000);
    expect(sent.map((s) => s.name)).toEqual(['N', 'C']);
  });
  it('sends nothing at the end when the burst settled back to what was sent', () => {
    const g = mk();
    g.update(p('store'));
    wait(100);
    g.update(p('store', { name: 'A' }));
    g.update(p('store'));
    wait(9000);
    expect(sent).toHaveLength(1);
  });
  it('force re-sends the latest value (a fresh channel has no presence)', () => {
    const g = mk();
    g.update(p('arcade'));
    g.force(p('arcade'));
    expect(sent).toHaveLength(2);
  });
  it('cancel stops a pending trailing send', () => {
    const g = mk();
    g.update(p('store'));
    wait(100);
    g.update(p('store', { name: 'A' }));
    g.cancel();
    wait(9000);
    expect(sent).toHaveLength(1);
  });
});
