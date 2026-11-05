// Pure helpers for the Monthly Picks shelf. No React, no DOM, no Supabase: useStore fetches, these shape the rows.
import type { Tape } from '../types';

/** A row of the public monthly_picks table. */
export interface PickRow { month: string; rank: number; tape_slug: string }

export const MONTHLY_SHELF_SIZE = 10;
/** Drawn on the shelf until the first picks exist (they are built on the 1st of the month). */
export const MONTHLY_PLACEHOLDER = ['FIRST PICKS', 'ON THE 1ST'];

/** Only the most recent month's rows, best first, at most one shelf's worth. */
export function latestPicks(rows: PickRow[]): PickRow[] {
  const month = rows.reduce((m, r) => (r.month > m ? r.month : m), '');
  return rows.filter((r) => r.month === month).sort((a, b) => a.rank - b.rank).slice(0, MONTHLY_SHELF_SIZE);
}

/** Picks joined to their tapes by slug, in rank order; a pick whose tape no longer exists is dropped. */
export function joinPicks(picks: PickRow[], tapes: Omit<Tape, 'votes'>[], votes: Map<string, number>): Tape[] {
  const bySlug = new Map(tapes.map((t) => [t.slug, t]));
  return picks.flatMap((p) => {
    const t = bySlug.get(p.tape_slug);
    return t ? [{ ...t, votes: votes.get(t.id) ?? 0 } as Tape] : [];
  });
}

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
/** "2026-10-01" -> "OCT 2026" */
export const monthLabel = (month: string) => `${MONTHS[Number(month.slice(5, 7)) - 1] ?? ''} ${month.slice(0, 4)}`.trim();
