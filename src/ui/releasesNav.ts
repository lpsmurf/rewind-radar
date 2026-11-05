// Pure helpers for the full-screen releases browser. No React, no DOM.
import type { Tape } from '../types';

/** A repo that is not a tape in the store (e.g. a personal recommendation). */
export interface GithubItem {
  kind: 'github';
  full_name: string;
  html_url: string;
  description: string | null;
  stars: number | null;
  language: string | null;
  license: string | null;
  why: string;
}
export type BrowseItem = Tape | GithubItem;
export const isGithubItem = (i: BrowseItem): i is GithubItem => i.kind === 'github';

export const itemKey = (i: BrowseItem): string => (isGithubItem(i) ? 'gh:' + i.full_name : i.id);
export const itemTitle = (i: BrowseItem): string => (isGithubItem(i) ? i.full_name : i.title);
/** Stars of a repo-like item; skills have none. */
export const itemStars = (i: BrowseItem): number | null =>
  isGithubItem(i) || i.kind === 'repo' || i.kind === 'community' ? i.stars : null;
/** The repo name without its owner, cut to `n` characters (a dot marks the cut). */
export function shortTitle(i: BrowseItem, n: number): string {
  const s = itemTitle(i).split('/').pop() || itemTitle(i);
  return s.length > n ? s.slice(0, n - 1) + '.' : s;
}

/** Next index in a list that wraps around at both ends. */
export function stepIndex(index: number, len: number, delta: number): number {
  return len <= 0 ? 0 : (((index + delta) % len) + len) % len;
}

/** Indexes of the neighbours drawn each side of `index`: left far-to-near, right near-to-far. Wraps; no repeats on short lists. */
export function neighbourWindow(len: number, index: number, per: number): { left: number[]; right: number[] } {
  const others = Math.max(0, len - 1);
  const l = Math.min(per, Math.ceil(others / 2));
  const r = Math.min(per, others - l);
  const left = Array.from({ length: l }, (_, k) => stepIndex(index, len, -(l - k)));
  const right = Array.from({ length: r }, (_, k) => stepIndex(index, len, k + 1));
  return { left, right };
}

export const positionLabel = (index: number, len: number): string => `${len ? index + 1 : 0} / ${len}`;

/** A stable colour for a spine, from its key. */
export function spineHue(key: string): number {
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) h = Math.imul(h ^ key.charCodeAt(i), 16777619);
  return (h >>> 0) % 360;
}
