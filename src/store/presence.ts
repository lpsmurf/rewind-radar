// Pure helpers for Realtime presence. Everything in presence is untrusted input from other browsers.
import type { Room, Visitor } from '../types';
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
      const room: Room = inArcade ? 'arcade' : m?.room === 'repos' ? 'repos' : 'store';
      return {
        id: k,
        name: capName(m?.name) ?? 'GUEST',
        color: safeColor(m?.color, '#fff6d5'),
        aisle: inArcade ? 'arcade' : (m?.aisle ?? 'entrance'),
        room,
        ...(x !== undefined && y !== undefined ? { x, y } : {}),
      } as Visitor;
    });
}

/** Wait before reconnect attempt n (0-based): 1 s, 2 s, 4 s ... capped at 30 s. */
export const backoffMs = (attempt: number): number => Math.min(30_000, 1000 * 2 ** Math.max(0, attempt));

export interface PresencePayload { name: string; color: string; room: Room; x?: number; y?: number }

/** The server closes a channel that tracks more than about 5 times in 30 s, so only presence-worthy changes go out. */
const sigOf = (p: PresencePayload) => `${p.room}|${p.name}|${p.color}`;

export interface TrackGateOpts {
  minMs?: number;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (h: any) => void;
}

/**
 * Decides when to call track(). A room change goes out at once. Name or colour changes are deduped and sent at
 * most once per `minMs`, with a trailing send so the final value always arrives. Position alone never counts.
 */
export function createTrackGate(send: (p: PresencePayload) => void, o: TrackGateOpts = {}) {
  const minMs = o.minMs ?? 8000;
  const now = o.now ?? Date.now;
  const setTimer = o.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = o.clearTimer ?? ((h) => clearTimeout(h));
  let last: PresencePayload | null = null;
  let lastAt = 0;
  let pending: PresencePayload | null = null;
  let timer: unknown = null;

  const stop = () => {
    if (timer !== null) clearTimer(timer);
    timer = null;
    pending = null;
  };
  const fire = (p: PresencePayload) => {
    stop();
    last = p;
    lastAt = now();
    send(p);
  };

  return {
    update(p: PresencePayload) {
      if (last && sigOf(p) === sigOf(last)) return stop(); // back to what was sent: nothing to say
      if (!last || p.room !== last.room || now() - lastAt >= minMs) return fire(p);
      pending = p;
      if (timer === null) {
        timer = setTimer(() => {
          timer = null;
          const q = pending;
          pending = null;
          if (q) fire(q);
        }, Math.max(0, lastAt + minMs - now()));
      }
    },
    /** Send now whatever the state (a fresh channel has no presence yet). */
    force(p: PresencePayload) {
      fire(p);
    },
    cancel: stop,
  };
}

export interface ChannelStatusDeps<C> {
  isCurrent: (ch: C) => boolean;
  clear: () => void;
  onUp: () => void;
  onDown: () => void;
  remove: (ch: C) => void;
  retry: () => void;
}

/**
 * React to a Realtime channel status. On CLOSED/CHANNEL_ERROR/TIMED_OUT the channel is forgotten *before* it is
 * removed: removeChannel() leaves the channel, which fires this callback with CLOSED again synchronously, and the
 * isCurrent guard must already say no, or the two call each other until the stack overflows.
 */
export function handleChannelStatus<C>(status: string, ch: C, d: ChannelStatusDeps<C>): void {
  if (!d.isCurrent(ch)) return; // a channel we already replaced or tore down
  if (status === 'SUBSCRIBED') return d.onUp();
  if (status !== 'CLOSED' && status !== 'CHANNEL_ERROR' && status !== 'TIMED_OUT') return;
  d.clear();
  d.onDown();
  d.retry();
  try {
    d.remove(ch);
  } catch {
    /* already gone */
  }
}
