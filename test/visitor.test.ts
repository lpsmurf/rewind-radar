import { describe, expect, it } from 'vitest';
import { getTabId, presenceKey, visitorIdOfKey } from '../src/lib/visitor.ts';

const memStore = () => {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
};

describe('presenceKey', () => {
  it('differs per tab for the same visitor', () => {
    expect(presenceKey('abc123', 't1')).not.toBe(presenceKey('abc123', 't2'));
  });
  it('is stable for the same visitor and tab', () => {
    expect(presenceKey('abc123', 't1')).toBe(presenceKey('abc123', 't1'));
  });
  it('keeps the plain visitor id recoverable for votes', () => {
    expect(visitorIdOfKey(presenceKey('abc123', 't1'))).toBe('abc123');
    expect(visitorIdOfKey('plain')).toBe('plain');
  });
});

describe('getTabId', () => {
  it('is created once per storage and then reused', () => {
    const s = memStore();
    const a = getTabId(s);
    expect(a).toMatch(/^[0-9a-f]{4,6}$/);
    expect(getTabId(s)).toBe(a);
  });
  it('differs between two tabs (two storages)', () => {
    expect(getTabId(memStore())).not.toBe(getTabId(memStore()));
  });
  it('still returns an id when storage is blocked', () => {
    const bad = { getItem: () => { throw new Error('blocked'); }, setItem: () => {} };
    expect(getTabId(bad)).toBeTruthy();
  });
});
