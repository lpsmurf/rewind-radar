// Pure movement logic for the store and arcade rooms. No React, no DOM: the canvas and the tests both import this.
// Coordinates are canvas pixels (W x H). A character's position is where its feet are.

export interface Point { x: number; y: number }
export interface Rect { x: number; y: number; w: number; h: number }
export type Room = 'store' | 'arcade';

export const W = 480;
export const H = 270;

// Genre shelf blocks (2 rows x 4). Shared with the canvas drawing in Store.tsx.
export const BW = 100;
export const BH = 24;
export const bx = (i: number) => 10 + (i % 4) * 116;
export const by = (i: number) => (i < 4 ? 128 : 188); // front face top

/** Where feet may stand: the floor below the back wall. */
export const FLOOR: Rect = { x: 4, y: 110, w: W - 8, h: H - 4 - 110 };

/** Shelf footprints (front face plus the top face), plus the rental counter. */
export const SHELVES: Rect[] = [
  ...Array.from({ length: 8 }, (_, i): Rect => ({ x: bx(i), y: by(i) - 6, w: BW + 6, h: BH + 6 })),
  { x: 170, y: 238, w: 140, h: 26 },
];

/** Doorway to the arcade, on the right of the store floor. */
export const DOOR: Rect = { x: 404, y: 226, w: 66, h: 40 };

/** Arcade room: five cabinets against the back wall, and the way back to the store. */
export const CABINET_W = 60;
export const CABINET_TOP = 56;
export const ARCADE_CABINETS: Rect[] = Array.from({ length: 5 }, (_, i): Rect => ({ x: 24 + i * 88, y: 108, w: CABINET_W, h: 24 }));
export const ARCADE_EXIT: Rect = { x: 10, y: 228, w: 60, h: 38 };

/** Where you appear after walking through a door. */
export const STORE_SPAWN_FROM_ARCADE: Point = { x: DOOR.x + DOOR.w / 2, y: DOOR.y + DOOR.h - 2 };
export const ARCADE_SPAWN: Point = { x: ARCADE_EXIT.x + ARCADE_EXIT.w / 2, y: ARCADE_EXIT.y + ARCADE_EXIT.h - 2 };

const obstaclesOf = (room: Room): Rect[] => (room === 'arcade' ? ARCADE_CABINETS : SHELVES);

const strictlyInside = (p: Point, r: Rect) => p.x > r.x && p.x < r.x + r.w && p.y > r.y && p.y < r.y + r.h;

export const inRect = (p: Point, r: Rect) => p.x >= r.x && p.x < r.x + r.w && p.y >= r.y && p.y < r.y + r.h;

const clampRect = (p: Point): Point => ({
  x: Math.min(Math.max(p.x, FLOOR.x), FLOOR.x + FLOOR.w),
  y: Math.min(Math.max(p.y, FLOOR.y), FLOOR.y + FLOOR.h),
});

export function isWalkable(p: Point, room: Room = 'store'): boolean {
  if (p.x < FLOOR.x || p.x > FLOOR.x + FLOOR.w || p.y < FLOOR.y || p.y > FLOOR.y + FLOOR.h) return false;
  return !obstaclesOf(room).some((o) => strictlyInside(p, o));
}

/** Keep a point on the floor and out of shelves (pushed to the nearest free edge). */
export function clampToFloor(p: Point, room: Room = 'store'): Point {
  let q = clampRect(p);
  for (const o of obstaclesOf(room)) {
    if (!strictlyInside(q, o)) continue;
    const opts: Point[] = [
      { x: o.x, y: q.y }, { x: o.x + o.w, y: q.y }, { x: q.x, y: o.y }, { x: q.x, y: o.y + o.h },
    ].map(clampRect).filter((c) => isWalkable(c, room));
    if (!opts.length) continue;
    opts.sort((a, b) => Math.hypot(a.x - q.x, a.y - q.y) - Math.hypot(b.x - q.x, b.y - q.y));
    q = opts[0];
  }
  return q;
}

/** One straight-line walking step (px/s * s). Does not look at obstacles: pair it with findPath. */
export function stepToward(pos: Point, target: Point, speed: number, dt: number): Point {
  const dx = target.x - pos.x, dy = target.y - pos.y;
  const d = Math.hypot(dx, dy);
  const step = speed * dt;
  if (d <= step || d === 0) return { x: target.x, y: target.y };
  return { x: pos.x + (dx / d) * step, y: pos.y + (dy / d) * step };
}

/** Keyboard walking: move along a direction vector, sliding along shelves rather than stopping dead. */
export function stepBy(pos: Point, vec: Point, speed: number, dt: number, room: Room = 'store'): Point {
  if (!vec.x && !vec.y) return pos;
  const k = speed * dt;
  const tries: Point[] = [
    { x: pos.x + vec.x * k, y: pos.y + vec.y * k },
    { x: pos.x + vec.x * k, y: pos.y },
    { x: pos.x, y: pos.y + vec.y * k },
  ];
  return tries.find((t) => isWalkable(t, room)) ?? pos;
}

const segmentClear = (a: Point, b: Point, room: Room): boolean => {
  const n = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / 2));
  for (let i = 1; i <= n; i++) {
    if (!isWalkable({ x: a.x + ((b.x - a.x) * i) / n, y: a.y + ((b.y - a.y) * i) / n }, room)) return false;
  }
  return true;
};

/** Waypoints from `from` to `to` (last one is the clamped target) that never cross an obstacle. */
export function findPath(from: Point, to: Point, room: Room = 'store'): Point[] {
  const goal = clampToFloor(to, room);
  if (segmentClear(from, goal, room)) return [goal];
  // Visibility graph over obstacle corners (padded 1px outward), searched with Dijkstra.
  const nodes: Point[] = [from, goal];
  for (const o of obstaclesOf(room)) {
    for (const c of [
      { x: o.x - 1, y: o.y - 1 }, { x: o.x + o.w + 1, y: o.y - 1 },
      { x: o.x - 1, y: o.y + o.h + 1 }, { x: o.x + o.w + 1, y: o.y + o.h + 1 },
    ].map(clampRect)) if (isWalkable(c, room)) nodes.push(c);
  }
  const dist = nodes.map(() => Infinity);
  const prev = nodes.map(() => -1);
  const done = nodes.map(() => false);
  dist[0] = 0;
  for (;;) {
    let u = -1;
    for (let i = 0; i < nodes.length; i++) if (!done[i] && dist[i] < (u < 0 ? Infinity : dist[u])) u = i;
    if (u < 0 || u === 1) break;
    done[u] = true;
    for (let v = 0; v < nodes.length; v++) {
      if (done[v]) continue;
      const d = dist[u] + Math.hypot(nodes[u].x - nodes[v].x, nodes[u].y - nodes[v].y);
      if (d < dist[v] && segmentClear(nodes[u], nodes[v], room)) { dist[v] = d; prev[v] = u; }
    }
  }
  if (prev[1] < 0) return [goal];
  const path: Point[] = [];
  for (let i = 1; i > 0; i = prev[i]) path.unshift(nodes[i]);
  return path;
}

const KEY_DIR: Record<string, Point> = {
  arrowleft: { x: -1, y: 0 }, a: { x: -1, y: 0 },
  arrowright: { x: 1, y: 0 }, d: { x: 1, y: 0 },
  arrowup: { x: 0, y: -1 }, w: { x: 0, y: -1 },
  arrowdown: { x: 0, y: 1 }, s: { x: 0, y: 1 },
};

/** Unit direction (or zero) for the keys currently held (KeyboardEvent.key values). */
export function keyVector(keys: Iterable<string>): Point {
  let x = 0, y = 0;
  for (const k of keys) {
    const d = KEY_DIR[k.toLowerCase()];
    if (d) { x += d.x; y += d.y; }
  }
  x = Math.sign(x); y = Math.sign(y);
  const n = Math.hypot(x, y);
  return n ? { x: x / n, y: y / n } : { x: 0, y: 0 };
}

/** Smooth a remote character toward its last broadcast position (frame-rate independent). */
export function lerpRemote(pos: Point, target: Point, dt: number): Point {
  // Remote numbers are untrusted: clamp them, and never let NaN or Infinity into the drawn position.
  const n = (v: number, fallback: number) => (Number.isFinite(v) ? Math.max(-LERP_LIMIT, Math.min(LERP_LIMIT, v)) : fallback);
  const t = { x: n(target.x, 0), y: n(target.y, 0) };
  const p = { x: n(pos.x, t.x), y: n(pos.y, t.y) };
  const dx = t.x - p.x, dy = t.y - p.y;
  if (Math.hypot(dx, dy) < 0.3) return t;
  const f = 1 - Math.exp(-dt * 10);
  const out = { x: p.x + dx * f, y: p.y + dy * f };
  return Number.isFinite(out.x) && Number.isFinite(out.y) ? out : t;
}
const LERP_LIMIT = 1e6;

export const MOVE_SEND_MS = 125; // about 8 updates per second

/** Returns a gate: call it with the time, it says whether an update may go out now. `force` always passes. */
export function createSendGate(intervalMs = MOVE_SEND_MS): (nowMs: number, force?: boolean) => boolean {
  let last = -Infinity;
  return (now, force = false) => {
    if (!force && now - last < intervalMs) return false;
    last = now;
    return true;
  };
}
