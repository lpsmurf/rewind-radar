// Pure guards for what other browsers tell us (move broadcasts, presence). Everything here is untrusted input.
import { H, W } from './movement';

export const REMOTE_MAX = 200;
export const NAME_MAX = 30;

export interface Pt { x: number; y: number }

const clamp = (v: number, hi: number) => Math.max(0, Math.min(hi, v));

/** A move broadcast we will use: from someone currently in presence, not me, with finite numbers clamped to the canvas. */
export function acceptMove(payload: unknown, present: { has(key: string): boolean }, selfKey: string): ({ key: string } & Pt) | null {
  const { key, x, y } = (payload ?? {}) as { key?: unknown; x?: unknown; y?: unknown };
  if (typeof key !== 'string' || key === selfKey || !present.has(key)) return null;
  if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y)) return null;
  return { key, x: clamp(x, W), y: clamp(y, H) };
}

/** Remember a position, keeping at most `max` keys (the oldest go first). */
export function rememberPos(map: Map<string, Pt>, key: string, p: Pt, max = REMOTE_MAX): void {
  map.delete(key); // re-insert so the newest sit last
  map.set(key, p);
  for (const k of map.keys()) {
    if (map.size <= max) break;
    map.delete(k);
  }
}

export const capName = (v: unknown): string | undefined => (typeof v === 'string' ? v.slice(0, NAME_MAX) : undefined);

export const safeColor = (v: unknown, fallback: string): string => (typeof v === 'string' && /^#[0-9a-f]{3,8}$/i.test(v) ? v : fallback);
