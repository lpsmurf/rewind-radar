// Pure helpers for Realtime presence. Everything in presence is untrusted input from other browsers.
import type { Visitor } from '../types';
import { H, W } from './movement';
import { capName, safeColor, type Pt } from './remote';

const clamp = (v: number, hi: number) => Math.max(0, Math.min(hi, v));

/**
 * Visitors other than me, from ch.presenceState(). A key holds one meta per track() call and the server
 * keeps the old ones too, so the LAST meta is the current one. A live broadcast position beats presence.
 */
export function visitorsFromPresence(
  state: Record<string, any[]>,
  myKey: string,
  live?: ReadonlyMap<string, Pt>,
): Visitor[] {
  return Object.entries(state)
    .filter(([k]) => k !== myKey)
    .map(([k, metas]) => {
      const m = Array.isArray(metas) ? metas[metas.length - 1] : undefined;
      const l = live?.get(k);
      const px = m?.x, py = m?.y;
      const x = l?.x ?? (typeof px === 'number' && Number.isFinite(px) ? clamp(px, W) : undefined);
      const y = l?.y ?? (typeof py === 'number' && Number.isFinite(py) ? clamp(py, H) : undefined);
      const inArcade = m?.room === 'arcade' || m?.aisle === 'arcade';
      return {
        id: k,
        name: capName(m?.name) ?? 'GUEST',
        color: safeColor(m?.color, '#fff6d5'),
        aisle: inArcade ? 'arcade' : (m?.aisle ?? 'entrance'),
        ...(x !== undefined && y !== undefined ? { x, y } : {}),
      } as Visitor;
    });
}
