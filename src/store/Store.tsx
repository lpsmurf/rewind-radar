import { useEffect, useRef } from 'react';
import type { Tape, Visitor, Aisle } from '../types';
import { GENRES, aisleOf, RING_COLORS, PALETTE as P } from '../types';
import {
  ARCADE_CABINETS, ARCADE_EXIT, ARCADE_SPAWN, BH, BW, CABINET_TOP, DOOR, H, STORE_SPAWN_FROM_ARCADE, W,
  bx, by, clampToFloor, findPath, inRect, keyVector, lerpRemote, stepBy, stepToward,
  type Point, type Room,
} from './movement';
import { activeBubble, bubbleLines, type ChatEntry } from './chat';

export interface StoreProps {
  tapes: Tape[];
  visitors: Visitor[]; // other visitors (not me)
  me: Visitor;
  /** Recent chat and my own presence key: a sender's latest line shows as a bubble for a few seconds. */
  chat: ChatEntry[];
  meKey: string;
  highlighted: Set<string>;
  top10: Tape[];
  onTapeClick(t: Tape): void;
  onCounterClick(): void;
  onAisleChange(aisle: Aisle): void;
  /** My position changed. `force` skips the send throttle (last step, entering a room). */
  onMove(x: number, y: number, force?: boolean): void;
  onCabinetClick(): void;
}

const SPEED = 70; // px per second
const FONT = '8px "Press Start 2P", monospace';
const FONT_S = '6px "Press Start 2P", monospace';
const LABEL: Record<string, string> = {
  Design: 'DESIGN', 'Growth & GTM': 'GROWTH', Web3: 'WEB3', 'Research & Web': 'RESEARCH',
  'Dev Workflow': 'DEV', Media: 'MEDIA', Security: 'SECURITY', 'Harness & Ops': 'OPS',
};
const anchorOf = (a: Aisle): { x: number; y: number } => {
  const gi = (GENRES as readonly string[]).indexOf(a);
  if (gi >= 0) return { x: bx(gi) + BW / 2, y: by(gi) + BH + 20 };
  if (a === 'new') return { x: 130, y: 114 };
  if (a === 'community') return { x: 305, y: 114 };
  if (a === 'counter') return { x: 335, y: 254 };
  if (a === 'arcade') return ARCADE_SPAWN;
  return { x: 30, y: 256 };
};

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}
const coverColor = (t: Tape) => `hsl(${hash(t.slug + (t.language ?? '')) % 360} 60% 50%)`;
const trunc = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '.' : s);

function areaAt(x: number, y: number): Aisle | null {
  if (x >= 170 && x < 310 && y >= 218) return 'counter';
  if (y < 108) return x < 256 ? 'new' : x < 360 ? 'community' : null;
  if (y >= 238) return x < 70 ? 'entrance' : null;
  const row = y < 176 ? 0 : 1;
  const col = Math.min(3, Math.floor(x / 116));
  if (x >= 470) return null;
  return GENRES[row * 4 + col];
}

/** Aisle under a walking character's feet (the strip above the shelves belongs to the wall aisles). */
function walkArea(x: number, y: number): Aisle | null {
  if (y < 122) return x < 256 ? 'new' : x < 360 ? 'community' : null;
  return areaAt(x, y);
}

function iso(g: CanvasRenderingContext2D) {
  for (let r = 0; r * 8 + 100 < H + 8; r++) {
    for (let col = -1; col < 16; col++) {
      const cx = col * 32 + (r % 2) * 16, cy = 108 + r * 8;
      g.fillStyle = r % 2 ? P.floorA : P.floorB;
      g.beginPath(); g.moveTo(cx - 16, cy); g.lineTo(cx, cy - 8); g.lineTo(cx + 16, cy); g.lineTo(cx, cy + 8); g.closePath(); g.fill();
    }
  }
}

function buildArcade(): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const g = c.getContext('2d')!;
  g.fillStyle = '#12082e'; g.fillRect(0, 0, W, 108);
  g.fillStyle = '#1d0f4a'; for (let x = 0; x < W; x += 16) g.fillRect(x, 0, 1, 100);
  g.fillStyle = P.navyDark; g.fillRect(0, 98, W, 6);
  g.fillStyle = '#ff6bd6'; g.fillRect(0, 104, W, 3);
  iso(g);
  // exit door back to the store
  const e = ARCADE_EXIT;
  g.fillStyle = P.ink; g.fillRect(e.x, e.y, e.w, e.h);
  g.fillStyle = P.yellowDark; g.fillRect(e.x + 3, e.y + 3, e.w - 6, e.h - 3);
  g.fillStyle = P.navy; g.fillRect(e.x + 6, e.y + 6, e.w - 12, e.h - 6);
  return c;
}

function buildStatic(): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const g = c.getContext('2d')!;
  // back wall + trim
  g.fillStyle = P.navy; g.fillRect(0, 0, W, 108);
  g.fillStyle = P.navyDark; for (let x = 0; x < W; x += 16) g.fillRect(x, 0, 1, 100);
  g.fillStyle = P.navyDark; g.fillRect(0, 98, W, 6);
  g.fillStyle = P.yellow; g.fillRect(0, 104, W, 3);
  iso(g);
  // arcade doorway
  g.fillStyle = P.ink; g.fillRect(DOOR.x, DOOR.y, DOOR.w, DOOR.h);
  g.fillStyle = '#ff6bd6'; g.fillRect(DOOR.x + 3, DOOR.y + 3, DOOR.w - 6, DOOR.h - 3);
  g.fillStyle = '#12082e'; g.fillRect(DOOR.x + 6, DOOR.y + 6, DOOR.w - 12, DOOR.h - 6);
  // wall shelves (new / community)
  const wallShelf = (x: number, w: number) => {
    g.fillStyle = P.navyDark; g.fillRect(x, 18, w, 58);
    g.fillStyle = P.yellowDark;
    g.fillRect(x, 42, w, 2); g.fillRect(x, 76, w, 3);
  };
  wallShelf(6, 246); wallShelf(262, 90);
  // genre shelf blocks
  for (let i = 0; i < 8; i++) {
    const x = bx(i), y = by(i);
    g.fillStyle = 'rgba(0,0,0,.25)'; g.fillRect(x + 4, y + BH, BW + 6, 4);
    g.fillStyle = P.navyLight; g.beginPath(); // top
    g.moveTo(x, y); g.lineTo(x + 6, y - 6); g.lineTo(x + BW + 6, y - 6); g.lineTo(x + BW, y); g.closePath(); g.fill();
    g.fillStyle = P.navyDark; g.beginPath(); // side
    g.moveTo(x + BW, y); g.lineTo(x + BW + 6, y - 6); g.lineTo(x + BW + 6, y + BH - 6); g.lineTo(x + BW, y + BH); g.closePath(); g.fill();
    g.fillStyle = P.navy; g.fillRect(x, y, BW, BH);
    g.fillStyle = P.yellowDark; g.fillRect(x, y + 11, BW, 1); g.fillRect(x, y + BH - 1, BW, 1);
    g.fillStyle = P.ink; g.fillRect(x + 1, y + 1, BW - 2, 10); g.fillRect(x + 1, y + 12, BW - 2, 11);
    g.fillStyle = P.navyDark; g.fillRect(x + 1, y + 1, BW - 2, 10); g.fillRect(x + 1, y + 12, BW - 2, 11);
  }
  // counter
  g.fillStyle = P.navyLight; g.fillRect(170, 238, 140, 4);
  g.fillStyle = P.yellowDark; g.fillRect(170, 242, 140, 2);
  g.fillStyle = P.navy; g.fillRect(170, 244, 140, 20);
  g.fillStyle = P.navyDark; for (let x = 176; x < 310; x += 12) g.fillRect(x, 248, 8, 12);
  g.fillStyle = P.yellow; g.fillRect(10, 258, 40, 6); // entrance mat
  g.fillStyle = P.ink; g.fillRect(14, 260, 32, 2);
  return c;
}

const BODY = [
  '..hhhh..', '.hhhhhh.', '.hhhhhh.', '..hhhh..', '.cccccc.', 'cccccccc',
  'cccccccc', 'c.cccc.c', '..cccc..', '..dd.dd.', '..dd.dd.', '..kk.kk.',
];
function drawPerson(g: CanvasRenderingContext2D, x: number, y: number, color: string, skin = '#f1c9a0') {
  for (let r = 0; r < 12; r++) for (let c = 0; c < 8; c++) {
    const ch = BODY[r][c];
    if (ch === '.') continue;
    g.fillStyle = ch === 'h' ? skin : ch === 'c' ? color : ch === 'd' ? P.ink : '#000';
    g.fillRect(x + c, y + r, 1, 1);
  }
}

interface Hit { x: number; y: number; w: number; h: number; t: Tape }

export default function Store(props: StoreProps) {
  const ref = useRef<HTMLCanvasElement>(null);
  const pr = useRef(props);
  pr.current = props;
  const hits = useRef<Hit[]>([]);
  const mouse = useRef<{ x: number; y: number } | null>(null);
  const hover = useRef<Tape | null>(null);
  const meAt = useRef<Point | null>(null);
  const path = useRef<Point[]>([]);
  const keys = useRef(new Set<string>());
  const reported = useRef<Aisle | null>(null); // last aisle I reported, to tell my own aisle changes from the clerk's
  const roomRef = useRef<Room | null>(null);
  const smooth = useRef(new Map<string, Point>()); // drawn position of each remote visitor
  const cabHover = useRef(-1);

  useEffect(() => {
    const cv = ref.current!;
    const g = cv.getContext('2d')!;
    const bgStore = buildStatic();
    const bgArcade = buildArcade();
    let raf = 0;
    let last = 0;
    let wasMoving = false;

    const typing = (t: EventTarget | null) => !!(t as HTMLElement | null)?.closest?.('input, textarea, select, [contenteditable]');
    const onKeyDown = (e: KeyboardEvent) => {
      if (typing(e.target) || e.metaKey || e.ctrlKey || e.altKey) return;
      if (keyVector([e.key]).x === 0 && keyVector([e.key]).y === 0) return;
      keys.current.add(e.key.toLowerCase());
      e.preventDefault(); // arrows would scroll the page
    };
    const onKeyUp = (e: KeyboardEvent) => { keys.current.delete(e.key.toLowerCase()); };
    const onBlur = () => keys.current.clear();
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);

    const loop = (now: number) => {
      const p = pr.current;
      const room: Room = p.me.aisle === 'arcade' ? 'arcade' : 'store';
      const bg = room === 'arcade' ? bgArcade : bgStore;
      const dt = Math.min(0.05, last ? (now - last) / 1000 : 0.016);
      last = now;
      const blink = Math.floor(now / 250) % 2 === 0;
      const hl = p.highlighted;
      g.imageSmoothingEnabled = false;
      g.drawImage(bg, 0, 0);
      const hs: Hit[] = [];
      g.textBaseline = 'top';

      const sign = (label: string, cx: number, y: number, pulse: boolean) => {
        g.font = FONT;
        const w = label.length * 8 + 6;
        g.fillStyle = pulse && blink ? P.cream : P.yellow;
        g.fillRect(Math.round(cx - w / 2), y, w, 11);
        g.fillStyle = P.yellowDark; g.fillRect(Math.round(cx - w / 2), y + 10, w, 1);
        g.fillStyle = P.ink; g.fillText(label, Math.round(cx - w / 2) + 3, y + 2);
      };
      const outline = (x: number, y: number, w: number, h: number, col = P.yellow) => {
        g.strokeStyle = col; g.lineWidth = 1; g.strokeRect(x - 0.5, y - 0.5, w + 1, h + 1);
      };

      if (room === 'arcade') {
        // marquee
        g.fillStyle = P.ink; g.fillRect(90, 8, 300, 40);
        g.fillStyle = blink ? '#ff6bd6' : '#c77dff'; g.fillRect(93, 11, 294, 34);
        g.fillStyle = '#12082e'; g.fillRect(97, 15, 286, 26);
        g.font = '16px "Press Start 2P", monospace';
        g.fillStyle = blink ? P.yellow : P.cream;
        g.fillText('OPENING SOON', 120, 22);
        g.font = FONT; g.fillStyle = '#ff6bd6'; g.fillText('THE ARCADE', 188, 52);
        // cabinets
        const cabColors = ['#ff4d6d', '#3ddc84', '#4aa3ff', '#ff9f1c', '#c77dff'];
        ARCADE_CABINETS.forEach((c, i) => {
          const x = c.x, y = CABINET_TOP, w = c.w, h = c.y + c.h - CABINET_TOP;
          g.fillStyle = 'rgba(0,0,0,.3)'; g.fillRect(x + 2, y + h, w, 3);
          g.fillStyle = P.ink; g.fillRect(x, y, w, h);
          g.fillStyle = cabColors[i]; g.fillRect(x + 2, y + 2, w - 4, 10); // header
          g.fillStyle = P.ink; g.font = FONT_S; g.fillText('SOON', x + 14, y + 4);
          g.fillStyle = '#06210f'; g.fillRect(x + 6, y + 15, w - 12, 26); // screen
          g.fillStyle = `rgba(77,255,136,${0.15 + 0.1 * Math.sin(now / 250 + i)})`; g.fillRect(x + 6, y + 15, w - 12, 26);
          g.fillStyle = '#4dff88'; g.fillText(blink ? '...' : '..', x + 22, y + 24);
          g.fillStyle = cabColors[i]; g.fillRect(x + 8, y + 46, 8, 3); g.fillRect(x + 22, y + 46, 3, 3); g.fillRect(x + 28, y + 46, 3, 3);
          g.fillStyle = P.navyDark; g.fillRect(x + 4, y + 52, w - 8, h - 54);
        });
        const mp0 = mouse.current;
        cabHover.current = mp0 ? ARCADE_CABINETS.findIndex((c) => mp0.x >= c.x && mp0.x < c.x + c.w && mp0.y >= CABINET_TOP && mp0.y < c.y + c.h) : -1;
        if (cabHover.current >= 0) {
          const c = ARCADE_CABINETS[cabHover.current];
          outline(c.x - 1, CABINET_TOP - 1, c.w + 2, c.y + c.h - CABINET_TOP + 2, '#fff');
        }
        sign('< STORE', ARCADE_EXIT.x + ARCADE_EXIT.w / 2 + 6, ARCADE_EXIT.y - 14, false);
        hits.current = hs;
      } else {
        // bucket tapes
        const by_: Record<string, Tape[]> = {};
        for (const t of p.tapes) (by_[aisleOf(t)] ||= []).push(t);

        // face-out wall boxes
        const faceOut = (list: Tape[], x0: number, perRow: number, aisle: Aisle) => {
          let any = false;
          list.slice(0, perRow * 2).forEach((t, i) => {
            const x = x0 + (i % perRow) * 16, y = i < perRow ? 22 : 56;
            g.fillStyle = coverColor(t); g.fillRect(x, y, 14, 20);
            g.fillStyle = 'rgba(255,255,255,.25)'; g.fillRect(x + 1, y + 1, 12, 2);
            g.fillStyle = P.cream; g.fillRect(x + 2, y + 6, 10, 6);
            g.fillStyle = P.ink; g.fillRect(x + 3, y + 8, 8, 1);
            g.fillStyle = t.ring ? RING_COLORS[t.ring] : P.cream; g.fillRect(x + 9, y + 15, 3, 3);
            hs.push({ x, y, w: 14, h: 20, t });
            if (hl.has(t.id)) { any = true; if (blink) outline(x - 1, y - 1, 16, 22); }
          });
          return any;
        };
        const hlNew = faceOut(by_['new'] ?? [], 10, 15, 'new') || (by_['new'] ?? []).some((t) => hl.has(t.id));
        const hlCom = faceOut(by_['community'] ?? [], 266, 5, 'community') || (by_['community'] ?? []).some((t) => hl.has(t.id));
        sign('NEW RELEASES', 130, 5, hlNew);
        sign('COMMUNITY PICKS', 305, 5, hlCom);
        sign('ARCADE →', DOOR.x + DOOR.w / 2, DOOR.y - 14, true);

        // genre aisles
        GENRES.forEach((gn, i) => {
          const x = bx(i), y = by(i);
          const list = by_[gn] ?? [];
          const cap = Math.floor((BW - 4) / 3);
          list.slice(0, cap * 2).forEach((t, k) => {
            const lv = k < cap ? 0 : 1, j = k % cap;
            const sh = 7 + (hash(t.id) % 2);
            const sx = x + 2 + j * 3, sy = y + 1 + lv * 11 + (10 - sh);
            g.fillStyle = coverColor(t); g.fillRect(sx, sy, 2, sh);
            g.fillStyle = 'rgba(255,255,255,.35)'; g.fillRect(sx, sy, 1, sh);
            hs.push({ x: sx, y: sy, w: 3, h: sh, t });
            if (hl.has(t.id) && blink) outline(sx - 1, sy - 1, 4, sh + 2);
          });
          sign(LABEL[gn] ?? gn, x + BW / 2, y - 18, list.some((t) => hl.has(t.id)));
        });
        hits.current = hs;

        // TV
        g.fillStyle = P.ink; g.fillRect(370, 12, 96, 68);
        g.fillStyle = '#2b2b3a'; g.fillRect(372, 14, 92, 64);
        g.fillStyle = '#06210f'; g.fillRect(376, 18, 84, 52);
        g.fillStyle = P.navyDark; g.fillRect(396, 80, 44, 4); g.fillRect(410, 76, 16, 4);
        g.font = FONT;
        const tt = Math.floor(now / 2200) % Math.max(1, p.top10.length);
        const cur = p.top10[tt];
        g.fillStyle = '#ffb000'; g.fillText('TOP 10', 380, 22);
        g.fillStyle = '#4dff88';
        if (cur) {
          g.fillText('#' + (tt + 1), 380, 38);
          g.fillText(trunc(cur.title.split('/').pop() || cur.title, 10), 380, 50);
          g.fillStyle = '#ffb000'; g.fillText(cur.stars != null ? '*' + cur.stars : 'v' + cur.votes, 380, 60);
        } else g.fillText('NO DATA', 380, 42);
        g.fillStyle = 'rgba(0,0,0,.28)'; for (let y = 18; y < 70; y += 2) g.fillRect(376, y, 84, 1);
        g.fillStyle = `rgba(77,255,136,${0.06 + 0.03 * Math.sin(now / 300)})`; g.fillRect(376, 18, 84, 52);

        // clerk + bubble
        const bob = Math.round(Math.sin(now / 400));
        drawPerson(g, 236, 224 + bob, P.yellow);
        g.fillStyle = P.cream; g.fillRect(250, 206 + bob, 14, 12);
        g.fillRect(252, 218 + bob, 3, 3);
        g.fillStyle = P.ink; g.font = FONT; g.fillText('?', 254, 208 + bob);
        g.fillStyle = P.yellow; g.fillRect(222, 244, 36, 8);
        g.fillStyle = P.ink; g.font = FONT_S; g.fillText('HELP', 227, 246);
      }

      // avatars (depth-sorted)
      // me: keys win over a click-to-walk path; the clerk changing my aisle sends me to its anchor
      if (roomRef.current && roomRef.current !== room) {
        meAt.current = { ...(room === 'arcade' ? ARCADE_SPAWN : STORE_SPAWN_FROM_ARCADE) };
        path.current = [];
        smooth.current.clear();
      }
      roomRef.current = room;
      if (reported.current === null) reported.current = p.me.aisle;
      if (p.me.aisle !== reported.current) {
        reported.current = p.me.aisle;
        if (room === 'store' && meAt.current) path.current = findPath(meAt.current, anchorOf(p.me.aisle), room);
      }
      if (!meAt.current) {
        const anc = anchorOf(p.me.aisle);
        meAt.current = clampToFloor({ x: anc.x, y: anc.y }, room);
      }
      let m = meAt.current;
      const before = m;
      const vec = keyVector(keys.current);
      if (vec.x || vec.y) {
        path.current = [];
        m = stepBy(m, vec, SPEED, dt, room);
      } else if (path.current.length) {
        m = stepToward(m, path.current[0], SPEED, dt);
        if (m.x === path.current[0].x && m.y === path.current[0].y) path.current.shift();
      }
      const moving = m.x !== before.x || m.y !== before.y;
      meAt.current = m;
      if (moving) p.onMove(m.x, m.y);
      else if (wasMoving) p.onMove(m.x, m.y, true);
      wasMoving = moving;
      if (moving && room === 'store') {
        const a = walkArea(m.x, m.y);
        if (a && a !== reported.current) { reported.current = a; p.onAisleChange(a); }
      }

      // everyone else in this room walks toward their last broadcast position
      type Av = { v: Visitor; x: number; y: number; me: boolean; walking: boolean };
      const inRoom = p.visitors.filter((v) => (v.aisle === 'arcade') === (room === 'arcade'));
      if (smooth.current.size > inRoom.length + 8) {
        const ids = new Set(inRoom.map((v) => v.id));
        for (const k of smooth.current.keys()) if (!ids.has(k)) smooth.current.delete(k);
      }
      const avs: Av[] = inRoom.map((v) => {
        const h = hash(v.id);
        const known = Number.isFinite(v.x) && Number.isFinite(v.y);
        const a = anchorOf(v.aisle);
        const target = clampToFloor(
          known ? { x: v.x!, y: v.y! } : { x: a.x + ((h % 7) - 3) * 10, y: a.y + (((h >> 4) % 3) - 1) * 4 },
          room,
        );
        const cur = lerpRemote(smooth.current.get(v.id) ?? target, target, dt);
        smooth.current.set(v.id, cur);
        return { v, x: cur.x, y: cur.y, me: false, walking: Math.abs(target.x - cur.x) + Math.abs(target.y - cur.y) > 1 };
      });
      avs.push({ v: p.me, x: m.x, y: m.y, me: true, walking: moving });
      avs.sort((a, b) => a.y - b.y);
      for (const a of avs) {
        const ph = hash(a.v.id) % 1000;
        const b = a.walking ? Math.abs(Math.sin(now / 90)) * 2 : Math.round(Math.sin((now + ph) / 450));
        const px = Math.round(a.x - 4), py = Math.round(a.y - 12 - b);
        g.fillStyle = 'rgba(0,0,0,.3)'; g.fillRect(px, Math.round(a.y), 8, 2);
        drawPerson(g, px, py, a.v.color);
        g.font = FONT_S;
        const nm = a.v.name.replace('GUEST-', '#');
        const tw = nm.length * 6;
        g.fillStyle = 'rgba(6,24,70,.85)'; g.fillRect(Math.round(a.x - tw / 2) - 1, py - 9, tw + 2, 8);
        g.fillStyle = a.me ? P.yellow : P.cream; g.fillText(nm, Math.round(a.x - tw / 2), py - 8);
        if (a.me) {
          const ay = py - 16 - Math.round(Math.sin(now / 200) * 2);
          g.fillStyle = P.yellow;
          g.fillRect(px + 2, ay, 4, 3); g.fillRect(px + 3, ay + 3, 2, 2);
          g.fillStyle = P.ink; g.fillRect(px + 3, ay + 5, 2, 1);
        }
      }

      // speech bubbles on top of everyone: matched by presence key (my own key for my own character)
      const wall = Date.now();
      for (const a of avs) {
        const b = activeBubble(p.chat, a.me ? p.meKey : a.v.id, wall);
        if (!b) continue;
        const lines = bubbleLines(b);
        g.font = FONT_S;
        const bw = Math.max(...lines.map((l) => l.length)) * 6 + 6, bh = lines.length * 8 + 4;
        const feet = Math.round(a.y) - 12 - (a.me ? 18 : 10); // above the name tag (and my arrow)
        const bxp = Math.min(Math.max(2, Math.round(a.x - bw / 2)), W - bw - 2);
        const byp = Math.max(2, feet - bh - 4);
        g.fillStyle = P.ink; g.fillRect(bxp - 1, byp - 1, bw + 2, bh + 2);
        g.fillStyle = P.cream; g.fillRect(bxp, byp, bw, bh);
        const tx = Math.min(Math.max(bxp + 3, Math.round(a.x) - 2), bxp + bw - 7); // pixel tail pointing at the sender
        g.fillStyle = P.ink; g.fillRect(tx - 1, byp + bh, 6, 2); g.fillRect(tx, byp + bh + 2, 4, 2); g.fillRect(tx + 1, byp + bh + 4, 2, 1);
        g.fillStyle = P.cream; g.fillRect(tx, byp + bh, 4, 2); g.fillRect(tx + 1, byp + bh + 2, 2, 2);
        g.fillStyle = P.ink;
        lines.forEach((l, i) => g.fillText(l, bxp + 3, byp + 3 + i * 8));
      }

      // hover + tooltip
      const mp = mouse.current;
      let ht: Tape | null = null;
      if (mp) for (let i = hs.length - 1; i >= 0; i--) {
        const h = hs[i];
        if (mp.x >= h.x && mp.x < h.x + h.w && mp.y >= h.y && mp.y < h.y + h.h) { ht = h.t; break; }
      }
      hover.current = ht;
      if (ht && mp) {
        const hh = hs.find((h) => h.t === ht)!;
        outline(hh.x - 1, hh.y - 1, hh.w + 2, hh.h + 2, '#fff');
        const title = trunc(ht.title, 26);
        const sub = ht.kind === 'repo' && ht.stars != null ? '* ' + ht.stars : '';
        g.font = FONT;
        const w = Math.max(title.length, sub.length) * 8 + 8, h = sub ? 24 : 14;
        const tx = Math.min(Math.max(2, mp.x + 8), W - w - 2), ty = Math.min(mp.y + 10, H - h - 2);
        g.fillStyle = P.ink; g.fillRect(tx - 1, ty - 1, w + 2, h + 2);
        g.fillStyle = P.yellow; g.fillRect(tx, ty, w, h);
        g.fillStyle = P.ink; g.fillText(title, tx + 4, ty + 3);
        if (sub) g.fillText(sub, tx + 4, ty + 13);
      }
      const area = mp && room === 'store' ? areaAt(mp.x, mp.y) : null;
      const onDoor = !!mp && (room === 'store' ? inRect(mp, DOOR) : inRect(mp, ARCADE_EXIT));
      cv.style.cursor = ht || area || onDoor || cabHover.current >= 0 ? 'pointer' : 'crosshair';

      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
    };
  }, []);

  const pos = (e: React.MouseEvent) => {
    const r = ref.current!.getBoundingClientRect();
    return { x: ((e.clientX - r.left) * W) / r.width, y: ((e.clientY - r.top) * H) / r.height };
  };

  return (
    <canvas
      ref={ref}
      width={W}
      height={H}
      style={{ width: '100%', height: 'auto', aspectRatio: `${W} / ${H}`, display: 'block', imageRendering: 'pixelated' }}
      onMouseMove={(e) => { mouse.current = pos(e); }}
      onMouseLeave={() => { mouse.current = null; }}
      onClick={(e) => {
        const p = pos(e);
        mouse.current = p;
        const room: Room = props.me.aisle === 'arcade' ? 'arcade' : 'store';
        const go = (to: Room) => {
          // Move first so the presence update that follows already carries the new room's position.
          const spawn = to === 'arcade' ? ARCADE_SPAWN : STORE_SPAWN_FROM_ARCADE;
          meAt.current = { ...spawn };
          path.current = [];
          props.onMove(spawn.x, spawn.y, true);
          reported.current = to === 'arcade' ? 'arcade' : 'entrance';
          props.onAisleChange(reported.current);
        };
        if (room === 'arcade') {
          if (cabHover.current >= 0 || ARCADE_CABINETS.some((c) => p.x >= c.x && p.x < c.x + c.w && p.y >= CABINET_TOP && p.y < c.y + c.h)) return props.onCabinetClick();
          if (inRect(p, ARCADE_EXIT)) return go('store');
        } else {
          const t = [...hits.current].reverse().find((h) => p.x >= h.x && p.x < h.x + h.w && p.y >= h.y && p.y < h.y + h.h)?.t;
          if (t) return props.onTapeClick(t);
          if (inRect(p, DOOR)) return go('arcade');
          if (areaAt(p.x, p.y) === 'counter') props.onCounterClick();
        }
        if (meAt.current) path.current = findPath(meAt.current, p, room);
      }}
    />
  );
}
