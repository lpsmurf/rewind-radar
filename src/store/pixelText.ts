// A tiny 3x5 bitmap font (digits, k, M, '.') and a 3x3 star, for shelf-spine star counts that the 6px font cannot fit.
export const GLYPHS: Record<string, string[]> = {
  '0': ['111', '101', '101', '101', '111'], '1': ['010', '110', '010', '010', '111'],
  '2': ['111', '001', '111', '100', '111'], '3': ['111', '001', '111', '001', '111'],
  '4': ['101', '101', '111', '001', '001'], '5': ['111', '100', '111', '001', '111'],
  '6': ['111', '100', '111', '101', '111'], '7': ['111', '001', '010', '010', '010'],
  '8': ['111', '101', '111', '101', '111'], '9': ['111', '101', '111', '001', '111'],
  k: ['101', '101', '110', '101', '101'], M: ['101', '111', '111', '101', '101'], '.': ['0', '0', '0', '0', '1'],
};
export const STAR = ['010', '111', '010'];

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

/** A small yellow star then the count, centred on `cx`; returns nothing. */
export function drawStarCount(g: CanvasRenderingContext2D, label: string, cx: number, y: number): void {
  const w = 4 + textWidth(label);
  const x = Math.round(cx - w / 2);
  g.fillStyle = '#ffd200';
  STAR.forEach((row, r) => { for (let c = 0; c < 3; c++) if (row[c] === '1') g.fillRect(x + c, y + 1 + r, 1, 1); });
  drawPixelText(g, label, x + 4, y, '#fff6d5');
}
