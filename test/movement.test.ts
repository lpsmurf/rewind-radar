import { describe, expect, it } from 'vitest';
import {
  ARCADE_CABINETS, ARCADE_EXIT, DOOR, FLOOR, SHELVES, clampToFloor, createSendGate, inRect, isWalkable,
  findPath, keyVector, lerpRemote, stepBy, stepToward,
} from '../src/store/movement.ts';

const inside = (p: { x: number; y: number }, r: { x: number; y: number; w: number; h: number }) =>
  p.x > r.x && p.x < r.x + r.w && p.y > r.y && p.y < r.y + r.h;

describe('clampToFloor', () => {
  it('keeps a point already on open floor', () => {
    expect(clampToFloor({ x: 200, y: 165 })).toEqual({ x: 200, y: 165 });
  });
  it('pulls points back inside the room', () => {
    const p = clampToFloor({ x: -50, y: 9999 });
    expect(p.x).toBe(FLOOR.x);
    expect(p.y).toBe(FLOOR.y + FLOOR.h);
    expect(clampToFloor({ x: 5000, y: 0 })).toEqual({ x: FLOOR.x + FLOOR.w, y: FLOOR.y });
  });
  it('never leaves a point inside a shelf', () => {
    for (const s of SHELVES) {
      const p = clampToFloor({ x: s.x + s.w / 2, y: s.y + s.h / 2 });
      for (const o of SHELVES) expect(inside(p, o)).toBe(false);
    }
  });
  it('pushes out to the nearest edge', () => {
    const s = SHELVES[0];
    const p = clampToFloor({ x: s.x + s.w / 2, y: s.y + 1 });
    expect(p.y).toBe(s.y);
  });
  it('knows the arcade cabinets', () => {
    const c = ARCADE_CABINETS[0];
    const p = clampToFloor({ x: c.x + 5, y: c.y + 5 }, 'arcade');
    expect(inside(p, c)).toBe(false);
  });
  it('is idempotent', () => {
    const once = clampToFloor({ x: 120, y: 140 });
    expect(clampToFloor(once)).toEqual(once);
  });
});

describe('isWalkable', () => {
  it('rejects shelves and accepts the aisle between shelf rows', () => {
    const s = SHELVES[0];
    expect(isWalkable({ x: s.x + 10, y: s.y + 5 })).toBe(false);
    expect(isWalkable({ x: 60, y: 165 })).toBe(true);
  });
});

describe('stepToward', () => {
  it('moves at speed * dt along the line', () => {
    const p = stepToward({ x: 100, y: 165 }, { x: 200, y: 165 }, 60, 0.5);
    expect(p).toEqual({ x: 130, y: 165 });
  });
  it('does not overshoot the target', () => {
    expect(stepToward({ x: 100, y: 165 }, { x: 102, y: 165 }, 60, 1)).toEqual({ x: 102, y: 165 });
  });
  it('stays put when already there', () => {
    expect(stepToward({ x: 100, y: 165 }, { x: 100, y: 165 }, 60, 1)).toEqual({ x: 100, y: 165 });
  });
});

describe('stepBy (keyboard walking)', () => {
  it('slides along a shelf instead of walking through it', () => {
    const s = SHELVES[0];
    let p = { x: s.x + 20, y: s.y - 2 };
    for (let i = 0; i < 120; i++) {
      p = stepBy(p, { x: 0.7, y: 0.7 }, 80, 1 / 60);
      for (const o of SHELVES) expect(inside(p, o)).toBe(false);
    }
    expect(p.x).toBeGreaterThan(s.x + 20);
  });
  it('does nothing for a zero vector', () => {
    expect(stepBy({ x: 50, y: 165 }, { x: 0, y: 0 }, 80, 1)).toEqual({ x: 50, y: 165 });
  });
});

describe('findPath', () => {
  it('goes straight when nothing is in the way', () => {
    expect(findPath({ x: 20, y: 165 }, { x: 400, y: 165 })).toEqual([{ x: 400, y: 165 }]);
  });
  it('routes around shelves and never crosses one', () => {
    const s = SHELVES[0];
    const from = { x: s.x + 20, y: s.y - 2 };
    const to = { x: from.x, y: s.y + s.h + 10 };
    const path = findPath(from, to);
    expect(path.length).toBeGreaterThan(1);
    expect(path[path.length - 1]).toEqual(to);
    let p = from;
    for (const w of path) {
      for (let i = 0; i <= 50; i++) {
        const q = { x: p.x + ((w.x - p.x) * i) / 50, y: p.y + ((w.y - p.y) * i) / 50 };
        for (const o of SHELVES) expect(inside(q, o)).toBe(false);
      }
      p = w;
    }
  });
  it('walking the path reaches the target', () => {
    const s = SHELVES[0];
    let p = { x: s.x + 20, y: s.y - 2 };
    const to = { x: p.x, y: s.y + s.h + 10 };
    const path = findPath(p, to);
    for (let i = 0; i < 2000 && path.length; i++) {
      p = stepToward(p, path[0], 80, 1 / 60);
      if (p.x === path[0].x && p.y === path[0].y) path.shift();
    }
    expect(p).toEqual(to);
  });
  it('clamps a target inside a shelf onto the floor first', () => {
    const s = SHELVES[3];
    const path = findPath({ x: 60, y: 165 }, { x: s.x + 10, y: s.y + 10 });
    for (const o of SHELVES) expect(inside(path[path.length - 1], o)).toBe(false);
  });
});

describe('keyVector', () => {
  it('maps arrows and WASD', () => {
    expect(keyVector(['ArrowLeft'])).toEqual({ x: -1, y: 0 });
    expect(keyVector(['d'])).toEqual({ x: 1, y: 0 });
    expect(keyVector(['W'])).toEqual({ x: 0, y: -1 });
    expect(keyVector(['s'])).toEqual({ x: 0, y: 1 });
  });
  it('cancels opposite keys and ignores others', () => {
    expect(keyVector(['a', 'd'])).toEqual({ x: 0, y: 0 });
    expect(keyVector(['q', 'Enter'])).toEqual({ x: 0, y: 0 });
  });
  it('normalises diagonals', () => {
    const v = keyVector(['ArrowUp', 'ArrowRight']);
    expect(Math.hypot(v.x, v.y)).toBeCloseTo(1);
    expect(v.x).toBeGreaterThan(0);
    expect(v.y).toBeLessThan(0);
  });
});

describe('lerpRemote', () => {
  it('moves toward the target without overshooting', () => {
    const p = lerpRemote({ x: 0, y: 0 }, { x: 100, y: 50 }, 1 / 60);
    expect(p.x).toBeGreaterThan(0);
    expect(p.x).toBeLessThan(100);
    expect(p.y / p.x).toBeCloseTo(0.5);
  });
  it('converges and snaps when very close', () => {
    let p = { x: 0, y: 0 };
    for (let i = 0; i < 300; i++) p = lerpRemote(p, { x: 80, y: 120 }, 1 / 60);
    expect(p).toEqual({ x: 80, y: 120 });
  });
  it('is frame-rate independent', () => {
    const a = lerpRemote({ x: 0, y: 0 }, { x: 100, y: 0 }, 0.1);
    let b = { x: 0, y: 0 };
    for (let i = 0; i < 10; i++) b = lerpRemote(b, { x: 100, y: 0 }, 0.01);
    expect(a.x).toBeCloseTo(b.x, 1);
  });
});

describe('createSendGate', () => {
  it('allows about 8 sends per second', () => {
    const gate = createSendGate();
    let sent = 0;
    for (let t = 0; t < 1000; t += 16) if (gate(t)) sent++;
    expect(sent).toBeGreaterThanOrEqual(7);
    expect(sent).toBeLessThanOrEqual(9);
  });
  it('lets the first call through and blocks calls inside the interval', () => {
    const gate = createSendGate(100);
    expect(gate(1000)).toBe(true);
    expect(gate(1050)).toBe(false);
    expect(gate(1100)).toBe(true);
  });
  it('lets a forced send through and restarts the interval', () => {
    const gate = createSendGate(100);
    gate(0);
    expect(gate(10, true)).toBe(true);
    expect(gate(60)).toBe(false);
  });
});

describe('doors', () => {
  it('inRect tests half-open bounds', () => {
    expect(inRect({ x: DOOR.x, y: DOOR.y }, DOOR)).toBe(true);
    expect(inRect({ x: DOOR.x + DOOR.w, y: DOOR.y }, DOOR)).toBe(false);
  });
  it('keeps both doors on walkable floor', () => {
    expect(isWalkable({ x: DOOR.x + DOOR.w / 2, y: DOOR.y + DOOR.h - 2 })).toBe(true);
    expect(isWalkable({ x: ARCADE_EXIT.x + ARCADE_EXIT.w / 2, y: ARCADE_EXIT.y + ARCADE_EXIT.h - 2 }, 'arcade')).toBe(true);
  });
});
