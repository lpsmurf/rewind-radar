// Pure room routing: which room a place is in, where the clerk sends you, and the weekly shelf order.
import type { Aisle, Genre, Room, Tape } from '../types';
import { aisleOf, latestWeek, placeOf, roomOfTape } from '../types';

/** The room I end up in for an aisle. The arcade is its own room; an explicit room wins; else I stay (the arcade lands in skills). */
export function roomForAisle(aisle: Aisle, explicit: Room | undefined, current: Room): Room {
  if (aisle === 'arcade') return 'arcade';
  if (explicit) return explicit;
  return current === 'arcade' ? 'store' : current;
}

/**
 * The clerk names an aisle; the kind of the tape it recommends decides the room (a genre stand exists in both rooms).
 * No matching tape: community and NEW RELEASES are repos shelves, anything else stays where I am.
 */
export function clerkDestination(aisle: Aisle, tapes: Tape[], newWeek: string | null, current: Room): { room: Room; aisle: Aisle } {
  const match = tapes.find((t) => aisleOf(t, newWeek) === aisle) ?? tapes[0];
  if (match && aisle !== 'counter' && aisle !== 'entrance') return { room: placeOf(match, newWeek).room, aisle };
  if (aisle === 'community' || aisle === 'new') return { room: 'repos', aisle };
  return { room: roomForAisle(aisle, undefined, current), aisle };
}

/** The WEEKLY NEW RELEASES shelf: the latest week's repo tapes, most stars first (stable for ties). */
export function weeklyReleases(tapes: Tape[]): Tape[] {
  const week = latestWeek(tapes);
  return tapes.filter((t) => aisleOf(t, week) === 'new' && t.kind === 'repo').sort((a, b) => (b.stars ?? 0) - (a.stars ?? 0));
}

/** The COMMUNITY PICKS shelf, in the order the tapes were loaded. */
export const communityShelf = (tapes: Tape[]): Tape[] => tapes.filter((t) => t.kind === 'community');

/** A genre stand's tapes: the room's own kinds of that genre. The REPOS stands keep this week's repos too (the wall shows them as well). */
export const standTapes = (tapes: Tape[], genre: Genre, room: Room): Tape[] =>
  room === 'arcade' ? [] : tapes.filter((t) => t.genre === genre && roomOfTape(t) === room);
