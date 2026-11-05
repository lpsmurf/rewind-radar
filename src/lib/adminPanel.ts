/** Pure helpers for the /#admin panel (no React, no network), so they can be tested. */

export const isAdminHash = (hash: string) => /^#\/?admin$/.test(hash);

export const adminHeaders = (token: string): Record<string, string> => ({ 'x-admin-token': token });

export function formatUsd(v: number | string | null | undefined): string {
  const n = Number(v ?? 0) || 0;
  return n !== 0 && Math.abs(n) < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`;
}

/** A link target safe to put in href: only http(s) URLs. A credit link comes from a video or web page, so it may be hostile (javascript:, data:). Otherwise null: show plain text. */
export const safeHref = (url: string | null | undefined): string | null => (typeof url === 'string' && /^https?:\/\//i.test(url) ? url : null);

/** The paste box: links separated by whitespace or commas, no blanks or repeats, at most 20 (the API limit). */
export function pastedUrls(text: string): string[] {
  return [...new Set(text.split(/[\s,]+/).filter(Boolean))].slice(0, 20);
}

export interface SpendRow { day: string; route: string; calls: number | string; cost_usd: number | string }
export interface SpendDay { day: string; total: number; routes: { route: string; calls: number; cost: number }[] }

/** spend_by_day rows -> one entry per day (newest first) with each route's calls and cost, a total per day and overall. */
export function spendTable(rows: SpendRow[]): { days: SpendDay[]; total: number } {
  const by = new Map<string, SpendDay>();
  for (const r of rows) {
    const d = by.get(r.day) ?? { day: r.day, total: 0, routes: [] };
    const cost = Number(r.cost_usd) || 0;
    d.routes.push({ route: r.route, calls: Number(r.calls) || 0, cost });
    d.total += cost;
    by.set(r.day, d);
  }
  const days = [...by.values()].sort((a, b) => b.day.localeCompare(a.day));
  return { days, total: days.reduce((n, d) => n + d.total, 0) };
}

/** '2026-11-04T09:03:55Z' -> '2026-11-04 09:03' (UTC). Anything unparseable comes back unchanged. */
export function shortDate(iso: string): string {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(iso) ? iso.slice(0, 16).replace('T', ' ') : iso;
}

/** A textarea as a list: one entry per line, trimmed, no blanks or repeats. */
export const linesOf = (text: string): string[] => [...new Set(text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean))];

/** A YouTube channel id, as the API route requires. */
export const isChannelId = (s: string) => /^UC[\w-]{22}$/.test(s);
