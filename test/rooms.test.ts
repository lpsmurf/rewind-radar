import { describe, expect, it } from 'vitest';
import { aisleOf, roomOfKind, roomOfTape, placeOf } from '../src/types.ts';
import { clerkDestination, communityShelf, roomForAisle, standTapes, weeklyReleases } from '../src/store/rooms.ts';
import { tapeFixture } from './helpers/tapes.ts';

describe('roomOfKind / roomOfTape', () => {
  it('skills (and memory) live in the skills room, repos and community in the repos room', () => {
    expect(roomOfKind('skill')).toBe('store');
    expect(roomOfKind('memory')).toBe('store');
    expect(roomOfKind('skene')).toBe('store');
    expect(roomOfKind('repo')).toBe('repos');
    expect(roomOfKind('community')).toBe('repos');
    expect(roomOfTape(tapeFixture({ kind: 'repo' }))).toBe('repos');
  });
});

describe('placeOf', () => {
  it('sends a skill to its genre stand in the skills room', () => {
    expect(placeOf(tapeFixture({ kind: 'skill', genre: 'Media' }), '2026-11-02')).toEqual({ room: 'store', aisle: 'Media' });
  });
  it('sends the latest repos to NEW RELEASES and older repos to their genre stand, both in the repos room', () => {
    expect(placeOf(tapeFixture({ kind: 'repo', week: '2026-11-02' }), '2026-11-02')).toEqual({ room: 'repos', aisle: 'new' });
    expect(placeOf(tapeFixture({ kind: 'repo', week: '2026-10-26', genre: 'Security' }), '2026-11-02')).toEqual({ room: 'repos', aisle: 'Security' });
  });
  it('sends community tapes to COMMUNITY in the repos room', () => {
    expect(placeOf(tapeFixture({ kind: 'community' }), null)).toEqual({ room: 'repos', aisle: 'community' });
  });
  it('agrees with aisleOf', () => {
    const t = tapeFixture({ kind: 'repo', week: '2026-10-26', genre: 'Web3' });
    expect(placeOf(t, '2026-11-02').aisle).toBe(aisleOf(t, '2026-11-02'));
  });
});

describe('roomForAisle', () => {
  it('arcade is its own room, an explicit room wins, otherwise stay (leaving the arcade lands in skills)', () => {
    expect(roomForAisle('arcade', undefined, 'store')).toBe('arcade');
    expect(roomForAisle('Design', 'repos', 'store')).toBe('repos');
    expect(roomForAisle('Design', undefined, 'repos')).toBe('repos');
    expect(roomForAisle('entrance', undefined, 'arcade')).toBe('store');
  });
});

describe('clerkDestination (the clerk says an aisle; the tape kind says the room)', () => {
  const skill = tapeFixture({ id: 's', kind: 'skill', genre: 'Design' });
  const repo = tapeFixture({ id: 'r', kind: 'repo', genre: 'Design', week: '2026-10-26' });
  it('a genre aisle goes to the room of the matching recommended tape', () => {
    expect(clerkDestination('Design', [repo], '2026-11-02', 'store')).toEqual({ room: 'repos', aisle: 'Design' });
    expect(clerkDestination('Design', [skill], '2026-11-02', 'repos')).toEqual({ room: 'store', aisle: 'Design' });
  });
  it('prefers the tape whose own aisle is the one named', () => {
    expect(clerkDestination('Design', [tapeFixture({ id: 'x', kind: 'skill', genre: 'Media' }), repo], '2026-11-02', 'store')).toEqual({ room: 'repos', aisle: 'Design' });
  });
  it('community is always in the repos room', () => {
    expect(clerkDestination('community', [], null, 'store')).toEqual({ room: 'repos', aisle: 'community' });
  });
  it('with no tape to go by, stay in the current room (from the arcade, go to skills)', () => {
    expect(clerkDestination('Media', [], null, 'repos')).toEqual({ room: 'repos', aisle: 'Media' });
    expect(clerkDestination('counter', [], null, 'arcade')).toEqual({ room: 'store', aisle: 'counter' });
  });
  it('NEW RELEASES is a repos-room shelf too', () => {
    expect(clerkDestination('new', [], null, 'store')).toEqual({ room: 'repos', aisle: 'new' });
  });
});

describe('weeklyReleases', () => {
  it('is the latest week only, most stars first, stable for ties', () => {
    const a = tapeFixture({ id: 'a', kind: 'repo', week: '2026-11-02', stars: 10 });
    const b = tapeFixture({ id: 'b', kind: 'repo', week: '2026-11-02', stars: 500 });
    const c = tapeFixture({ id: 'c', kind: 'repo', week: '2026-11-02', stars: 10 });
    const old = tapeFixture({ id: 'o', kind: 'repo', week: '2026-10-26', stars: 9999 });
    const sk = tapeFixture({ id: 's', kind: 'skill', stars: 99999 });
    expect(weeklyReleases([a, old, sk, c, b]).map((t) => t.id)).toEqual(['b', 'a', 'c']);
  });
  it('treats missing stars as 0 and does not mutate its input', () => {
    const a = tapeFixture({ id: 'a', kind: 'repo', stars: null });
    const b = tapeFixture({ id: 'b', kind: 'repo', stars: 1 });
    const input = [a, b];
    expect(weeklyReleases(input).map((t) => t.id)).toEqual(['b', 'a']);
    expect(input.map((t) => t.id)).toEqual(['a', 'b']);
  });
});

describe('communityShelf', () => {
  it('keeps only community tapes, in order', () => {
    const a = tapeFixture({ id: 'a', kind: 'community' });
    const b = tapeFixture({ id: 'b', kind: 'repo' });
    const c = tapeFixture({ id: 'c', kind: 'community' });
    expect(communityShelf([a, b, c]).map((t) => t.id)).toEqual(['a', 'c']);
  });
});

describe('standTapes (what a genre stand holds)', () => {
  const week = '2026-11-02';
  const skill = tapeFixture({ id: 's', kind: 'skill', genre: 'Design' });
  const memory = tapeFixture({ id: 'm', kind: 'memory', genre: 'Design' });
  const thisWeek = tapeFixture({ id: 'r1', kind: 'repo', genre: 'Design', week });
  const older = tapeFixture({ id: 'r2', kind: 'repo', genre: 'Design', week: '2026-10-26' });
  const community = tapeFixture({ id: 'c', kind: 'community', genre: 'Design' });
  const other = tapeFixture({ id: 'x', kind: 'repo', genre: 'Media', week });
  const all = [skill, memory, thisWeek, older, community, other];
  it('the repos room holds every repo and community tape of the genre, this week included', () => {
    expect(standTapes(all, 'Design', 'repos').map((t) => t.id)).toEqual(['r1', 'r2', 'c']);
    expect(standTapes(all, 'Media', 'repos').map((t) => t.id)).toEqual(['x']);
  });
  it('the skills room holds only skills', () => {
    expect(standTapes(all, 'Design', 'store').map((t) => t.id)).toEqual(['s', 'm']);
    expect(standTapes(all, 'Media', 'store')).toEqual([]);
  });
  it('the arcade has no stands', () => {
    expect(standTapes(all, 'Design', 'arcade')).toEqual([]);
  });
});
