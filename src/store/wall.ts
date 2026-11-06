// Back-wall shelf geometry (pure). Six boxes per row leave room for a star label under each box.
export interface WallShelf { x: number; w: number; x0: number; pitch: number; perRow: number }
export const WALL_SHELVES: Record<'weekly' | 'monthly' | 'community', WallShelf> = {
  weekly: { x: 4, w: 150, x0: 10, pitch: 25, perRow: 6 },
  monthly: { x: 158, w: 98, x0: 164, pitch: 25, perRow: 4 },
  community: { x: 262, w: 98, x0: 268, pitch: 25, perRow: 4 },
};
/** The TV on the back wall (right of the shelves). */
export const TV_RECT = { x: 370, y: 12, w: 96, h: 68 };

/** Top-left of box `i` (0-based, row-major) and the y of its star label. */
export function wallSlot(sh: WallShelf, i: number): { x: number; y: number; labelY: number } {
  const y = i < sh.perRow ? 22 : 56;
  return { x: sh.x0 + (i % sh.perRow) * sh.pitch, y, labelY: y + 24 };
}

/** The first `cap` items for the shelf; `more` are left for the browser (`firstHidden` is the index of the first, or -1). */
export function wallSplit<T>(list: T[], cap: number): { shown: T[]; more: number; firstHidden: number } {
  const more = Math.max(0, list.length - cap);
  return { shown: list.slice(0, cap), more, firstHidden: more ? cap : -1 };
}
