import { formatStars } from '../lib/stars';

// A tiny 3x5 bitmap font (digits, k, M, '.') and a 3x3 star, for shelf-spine star counts that the 6px font cannot fit.
export const GLYPHS: Record<string, string[]> = {
  '0': ['111', '101', '101', '101', '111'], '1': ['010', '110', '010', '010', '111'],
  '2': ['111', '001', '111', '100', '111'], '3': ['111', '001', '111', '001', '111'],
  '4': ['101', '101', '111', '001', '001'], '5': ['111', '100', '111', '001', '111'],
  '6': ['111', '100', '111', '101', '111'], '7': ['111', '001', '010', '010', '010'],
  '8': ['111', '101', '111', '101', '111'], '9': ['111', '101', '111', '001', '111'],
  K: ['101', '101', '110', '101', '101'], M: ['101', '111', '111', '101', '101'], '.': ['0', '0', '0', '0', '1'],
};
/** A 5x5 pixel star (a sprite: the font has no star glyph). */
export const STAR = ['00100', '11111', '01110', '01110', '11011'];

/** Shorten to at most `n` characters, ending in "..." when cut. */
export const ellipsize = (s: string, n: number): string => (s.length <= n ? s : s.slice(0, Math.max(0, n - 3)) + '...');

export const textWidth = (s: string): number =>
  [...s].reduce((w, ch, i) => w + (GLYPHS[ch]?.[0].length ?? 0) + (i ? 1 : 0), 0);

/** Draw `s` with its top-left at (x, y), one canvas pixel per bitmap pixel. */
export function drawPixelText(g: CanvasRenderingContext2D, s: string, x: number, y: number, color: string): void {
  g.fillStyle = color;
  let cx = x;
  for (const ch of s) {
    const rows = GLYPHS[ch];
    if (!rows) continue;
    rows.forEach((row, r) => { for (let c = 0; c < row.length; c++) if (row[c] === '1') g.fillRect(cx + c, y + r, 1, 1); });
    cx += rows[0].length + 1;
  }
}

/** Width of a star sprite, a gap and the label. */
export const starCountWidth = (label: string): number => 6 + textWidth(label);

/** The count for a wall label under the sprite: the shared formatter uppercased; whole thousands only when that cannot fit `maxWidth`. */
export function wallStarLabel(n: number, maxWidth: number): string {
  const full = formatStars(n).toUpperCase();
  if (starCountWidth(full) <= maxWidth) return full;
  return formatStars(Math.round(n / 1000) * 1000).toUpperCase();
}

/** Draw the star sprite with its top-left at (x, y). */
export function drawStar(g: CanvasRenderingContext2D, x: number, y: number, color = '#ffd200'): void {
  g.fillStyle = color;
  STAR.forEach((row, r) => { for (let c = 0; c < 5; c++) if (row[c] === '1') g.fillRect(x + c, y + r, 1, 1); });
}

/** Star sprite then the count, left edge at `x`. */
export function drawStarCountAt(g: CanvasRenderingContext2D, label: string, x: number, y: number, color = '#fff6d5'): void {
  drawStar(g, x, y);
  drawPixelText(g, label, x + 6, y, color);
}

/** The same, centred on `cx`. */
export function drawStarCount(g: CanvasRenderingContext2D, label: string, cx: number, y: number): void {
  drawStarCountAt(g, label, Math.round(cx - starCountWidth(label) / 2), y);
}
