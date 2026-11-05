import { useEffect, useRef } from 'react';
import type { Tape, Visitor, Aisle } from '../types';
import { GENRES, aisleOf, RING_COLORS, PALETTE as P } from '../types';

export interface StoreProps {
  tapes: Tape[];
  visitors: Visitor[]; // other visitors (not me)
  me: Visitor;
  highlighted: Set<string>;
  top10: Tape[];
  onTapeClick(t: Tape): void;
  onCounterClick(): void;
  onAisleChange(aisle: Aisle): void;
}

const W = 480;
const H = 270;
const FONT = '8px "Press Start 2P", monospace';
const FONT_S = '6px "Press Start 2P", monospace';
const LABEL: Record<string, string> = {
  Design: 'DESIGN', 'Growth & GTM': 'GROWTH', Web3: 'WEB3', 'Research & Web': 'RESEARCH',
  'Dev Workflow': 'DEV', Media: 'MEDIA', Security: 'SECURITY', 'Harness & Ops': 'OPS',
};
// shelf block geometry (genre aisles: 2 rows x 4)
const BW = 100;
const bx = (i: number) => 10 + (i % 4) * 116;
const by = (i: number) => (i < 4 ? 128 : 188); // front face top
const BH = 24;
const anchorOf = (a: Aisle): { x: number; y: number } => {
  const gi = (GENRES as readonly string[]).indexOf(a);
  if (gi >= 0) return { x: bx(gi) + BW / 2, y: by(gi) + BH + 20 };
  if (a === 'new') return { x: 130, y: 114 };
  if (a === 'community') return { x: 305, y: 114 };
  if (a === 'counter') return { x: 335, y: 254 };
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

function buildStatic(): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const g = c.getContext('2d')!;
  // back wall + trim
  g.fillStyle = P.navy; g.fillRect(0, 0, W, 108);
  g.fillStyle = P.navyDark; for (let x = 0; x < W; x += 16) g.fillRect(x, 0, 1, 100);
  g.fillStyle = P.navyDark; g.fillRect(0, 98, W, 6);
  g.fillStyle = P.yellow; g.fillRect(0, 104, W, 3);
  // iso floor
  for (let r = 0; r * 8 + 100 < H + 8; r++) {
    for (let col = -1; col < 16; col++) {
      const cx = col * 32 + (r % 2) * 16, cy = 108 + r * 8;
      g.fillStyle = r % 2 ? P.floorA : P.floorB;
      g.beginPath(); g.moveTo(cx - 16, cy); g.lineTo(cx, cy - 8); g.lineTo(cx + 16, cy); g.lineTo(cx, cy + 8); g.closePath(); g.fill();
    }
  }
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
  const meAt = useRef<{ x: number; y: number } | null>(null);

  useEffect(() => {
    const cv = ref.current!;
    const g = cv.getContext('2d')!;
    const bg = buildStatic();
    let raf = 0;

    const loop = (now: number) => {
      const p = pr.current;
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

      // avatars (depth-sorted)
      const anc = anchorOf(p.me.aisle);
      if (!meAt.current) meAt.current = { x: anc.x, y: anc.y };
      const m = meAt.current;
      m.x += (anc.x - m.x) * 0.08; m.y += (anc.y - m.y) * 0.08;
      const moving = Math.abs(anc.x - m.x) + Math.abs(anc.y - m.y) > 2;
      type Av = { v: Visitor; x: number; y: number; me: boolean };
      const avs: Av[] = p.visitors.map((v) => {
        const a = anchorOf(v.aisle), h = hash(v.id);
        return { v, x: a.x + ((h % 7) - 3) * 10, y: a.y + (((h >> 4) % 3) - 1) * 4, me: false };
      });
      avs.push({ v: p.me, x: m.x, y: m.y, me: true });
      avs.sort((a, b) => a.y - b.y);
      for (const a of avs) {
        const ph = hash(a.v.id) % 1000;
        const b = moving && a.me ? Math.abs(Math.sin(now / 90)) * 2 : Math.round(Math.sin((now + ph) / 450));
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
      const area = mp ? areaAt(mp.x, mp.y) : null;
      cv.style.cursor = ht || area ? 'pointer' : 'default';

      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
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
        const t = [...hits.current].reverse().find((h) => p.x >= h.x && p.x < h.x + h.w && p.y >= h.y && p.y < h.y + h.h)?.t;
        if (t) return props.onTapeClick(t);
        const a = areaAt(p.x, p.y);
        if (a === 'counter') props.onCounterClick();
        if (a) props.onAisleChange(a);
      }}
    />
  );
}
