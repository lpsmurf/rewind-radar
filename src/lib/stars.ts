// One star formatter for the whole app (panel, browser, shelves).
const one = (v: number) => String(Math.round(v * 10) / 10); // 1.0 -> "1"

/** 999 -> 999, 1234 -> 1.2k, 12400 -> 12.4k, 1200000 -> 1.2M */
export function formatStars(n: number): string {
  if (n < 1000) return String(Math.max(0, Math.round(n)));
  if (n < 1e6) {
    const k = Math.round((n / 1000) * 10) / 10;
    return k >= 1000 ? '1M' : one(k) + 'k';
  }
  return one(n / 1e6) + 'M';
}

/** Whole thousands/millions, at most 4 characters: what fits on a shelf spine (12400 -> 12k). */
export function compactStars(n: number): string {
  if (n < 1000) return String(Math.max(0, Math.round(n)));
  const k = Math.round(n / 1000);
  if (k < 1000) return k + 'k';
  return Math.min(999, Math.round(n / 1e6)) + 'M';
}

/** "★ 12.4k" for repo and community tapes with a star count; skills have none, so null. */
export function starsLabel(t: { kind: string; stars: number | null }): string | null {
  return (t.kind === 'repo' || t.kind === 'community') && t.stars != null ? '★ ' + formatStars(t.stars) : null;
}
