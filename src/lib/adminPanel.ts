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

/** The repo a line names, lowercase owner/repo: a github.com link or a bare owner/repo. null for anything else. */
export function repoKey(line: string): string | null {
  const m = line.trim().match(/^(?:(?:https?:\/\/)?(?:www\.)?github\.com\/|@)?([A-Za-z0-9-]{1,39})\/([A-Za-z0-9._-]{1,100}?)(?:\.git)?(?:[/?#].*)?$/i);
  return m ? `${m[1]}/${m[2]}`.toLowerCase() : null;
}

/** The "Add repos" box: one line per repo, blanks and repeats (same repo, any spelling) dropped. Not capped: the panel shows the limit. */
export function stockLines(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const key = repoKey(line) ?? line.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(line);
  }
  return out;
}

const STOCK_LABELS: Record<string, string> = { added: 'ADDED', restored: 'RESTORED', duplicate: 'ALREADY IN STORE', not_found: 'NOT FOUND', invalid: 'INVALID', error: 'ERROR' };
export const stockStatusLabel = (status: string): string => STOCK_LABELS[status] ?? 'ERROR';

/** The lines worth fixing and retrying: anything that was not added, restored or already in the store. */
export const failedLines = (results: { input: string; status: string }[]): string[] =>
  results.filter((r) => r.status === 'not_found' || r.status === 'invalid' || r.status === 'error').map((r) => r.input);

export const stockSummary = (r: { added: number; skipped: number }): string => `Added ${r.added} · skipped ${r.skipped}`;

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

import { CHANNEL_INPUT_HINT, parseChannelInput } from '../../lib/sources/config.ts';

export { CHANNEL_INPUT_HINT };

/**
 * A channel textarea, one per line, in any common form (link, @handle, handle, UC id), as the server will store it: a UC id
 * or an @handle, repeats dropped. `bad` holds the lines that are none of those.
 */
export function channelEntries(text: string): { entries: string[]; bad: string[] } {
  const entries: string[] = [];
  const bad: string[] = [];
  const have = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    const p = parseChannelInput(t);
    if (!p) {
      bad.push(t);
      continue;
    }
    const c = 'handle' in p ? p.handle : p.channel_id;
    const k = 'handle' in p ? c.toLowerCase() : c;
    if (have.has(k)) continue;
    have.add(k);
    entries.push(c);
  }
  return { entries, bad };
}

/** A textarea as a list: one entry per line, trimmed, no blanks or repeats. */
export const linesOf = (text: string): string[] => [...new Set(text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean))];

/** A YouTube channel id, as the API route requires. */
export const isChannelId = (s: string) => /^UC[\w-]{22}$/.test(s);

/** A YouTube handle, as the config route requires (the leading @ included). */
export const isHandle = (s: string) => /^@[A-Za-z0-9._-]{3,30}$/.test(s);

/** What the watcher's textarea holds: one handle per line, a missing @ added, blanks and repeats (any case) dropped. */
export function handlesOf(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    const h = t && !t.startsWith('@') ? `@${t}` : t;
    if (!h || seen.has(h.toLowerCase())) continue;
    seen.add(h.toLowerCase());
    out.push(h);
  }
  return out;
}

/** The watcher's answer in one line for the panel. */
export function watchSummaryLine(r: { skipped?: string; channels: number; videos_checked: number; repos_found: number; added: number; restored: number; duplicates: number; errors: number }): string {
  if (r.skipped) return `Skipped: ${r.skipped}`;
  return `${r.channels} channel${r.channels === 1 ? '' : 's'} · ${r.videos_checked} new video${r.videos_checked === 1 ? '' : 's'} · ${r.repos_found} repos found · added ${r.added} · restored ${r.restored} · already in store ${r.duplicates}${r.errors ? ` · ${r.errors} error${r.errors === 1 ? '' : 's'}` : ''}`;
}

export interface WatchRunResult {
  videos_checked: number;
  added: number;
  restored: number;
  duplicates: number;
  errors: number;
  remaining: number;
  skipped?: string;
}
export interface BackfillTotals { added: number; restored: number; duplicates: number; errors: number; videos: number; remaining: number; calls: number }
export type BackfillStop = 'done' | 'error' | 'skipped' | 'stalled' | 'limit' | 'cancelled';
export interface BackfillOutcome { stop: BackfillStop; totals: BackfillTotals; reason?: string }

/** The live progress line of a backfill, like "videos left: 7 · added 23 · already in store 9 · restored 1". */
export const backfillLine = (t: BackfillTotals): string => `videos left: ${t.remaining} · added ${t.added} · already in store ${t.duplicates} · restored ${t.restored}${t.errors ? ` · ${t.errors} error${t.errors === 1 ? '' : 's'}` : ''}`;

/**
 * Call the watcher again and again until nothing is left. Stops when `remaining` reaches 0, on a thrown error (budget 503 included),
 * when the watcher says it skipped (budget spent), when a call checked no video yet some remain (a fresh video still waiting for its
 * pinned comment: more calls will not help), after `maxCalls`, or when `cancelled()` turns true.
 */
export async function runBackfill(o: {
  days: number;
  call: (days: number) => Promise<WatchRunResult>;
  onProgress?: (t: BackfillTotals) => void;
  cancelled?: () => boolean;
  sleep?: (ms: number) => Promise<void>;
  maxCalls?: number;
  pauseMs?: number;
}): Promise<BackfillOutcome> {
  const maxCalls = o.maxCalls ?? 30;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const t: BackfillTotals = { added: 0, restored: 0, duplicates: 0, errors: 0, videos: 0, remaining: 0, calls: 0 };
  const out = (stop: BackfillStop, reason?: string): BackfillOutcome => ({ stop, totals: { ...t }, ...(reason ? { reason } : {}) });
  while (t.calls < maxCalls) {
    if (o.cancelled?.()) return out('cancelled');
    let r: WatchRunResult;
    try {
      r = await o.call(o.days);
    } catch (e) {
      return out('error', e instanceof Error ? e.message : 'Failed');
    }
    t.calls++;
    t.added += r.added;
    t.restored += r.restored;
    t.duplicates += r.duplicates;
    t.errors += r.errors;
    t.videos += r.videos_checked;
    t.remaining = r.remaining;
    o.onProgress?.({ ...t });
    if (r.skipped) return out('skipped', r.skipped);
    if (r.remaining <= 0) return out('done');
    if (r.videos_checked === 0) return out('stalled', 'No video could be processed yet (new uploads wait for the channel to pin its list).');
    if (t.calls >= maxCalls) break;
    await sleep(o.pauseMs ?? 1500);
  }
  return out('limit', `Stopped after ${maxCalls} calls.`);
}
