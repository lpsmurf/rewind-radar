import { describe, expect, it } from 'vitest';
import { answerItems, hitToItem, radarItems, radarTitle, type ProfileReply, type RepoHit } from '../src/lib/radar.ts';
import { itemKey } from '../src/ui/releasesNav.ts';
import { tapeFixture } from './helpers/tapes.ts';

const hit = (name: string, o: Partial<RepoHit> = {}): RepoHit => ({
  full_name: name, html_url: `https://github.com/${name}`, description: `${name} desc`, stars: 1200, language: 'Go', license: 'MIT',
  pushed_at: '2026-11-01T00:00:00Z', archived: false, topics: [], forks: 3, open_issues: 1, created_at: '2024-01-01T00:00:00Z', ...o,
});
const a = tapeFixture({ id: 'a', slug: 'skill-a' });
const b = tapeFixture({ id: 'b', slug: 'skill-b' });
const c = tapeFixture({ id: 'c', slug: 'repo-c', kind: 'repo' });
const tapes = [a, b, c];

describe('hitToItem', () => {
  it('maps a GitHub hit to the light browser item', () => {
    expect(hitToItem(hit('o/r'), 'because')).toEqual({
      kind: 'github', full_name: 'o/r', html_url: 'https://github.com/o/r', description: 'o/r desc', stars: 1200, language: 'Go', license: 'MIT', why: 'because',
    });
  });
});

describe('radarItems', () => {
  const reply = (o: Partial<ProfileReply>): ProfileReply => ({ answer: 'x', aisle: 'Design', name: 'ann', kind: 'user', picks: [], skills: [], slugs: [], ...o });
  it('keeps pick order (tapes and repos mixed), then the skills', () => {
    const r = radarItems(reply({
      picks: [
        { type: 'github', repo: { ...hit('o/one'), signals: {} }, why: 'g1' },
        { type: 'tape', slug: 'repo-c', why: 't1' },
        { type: 'github', repo: { ...hit('o/two'), signals: {} }, why: 'g2' },
      ],
      skills: [{ slug: 'skill-b', why: 's1' }, { slug: 'skill-a', why: 's2' }],
    }), tapes);
    expect(r.items.map(itemKey)).toEqual(['gh:o/one', 'c', 'gh:o/two', 'b', 'a']);
  });
  it('skips unknown slugs and drops a tape that already appeared', () => {
    const r = radarItems(reply({
      picks: [{ type: 'tape', slug: 'nope', why: 'x' }, { type: 'tape', slug: 'skill-a', why: 'first' }],
      skills: [{ slug: 'skill-a', why: 'again' }, { slug: 'ghost', why: 'x' }],
    }), tapes);
    expect(r.items.map(itemKey)).toEqual(['a']);
    expect(r.why['a']).toBe('first');
  });
  it('collects a why line per item key, for tapes and repos', () => {
    const r = radarItems(reply({ picks: [{ type: 'github', repo: { ...hit('o/one'), signals: {} }, why: 'g1' }], skills: [{ slug: 'skill-b', why: 's1' }] }), tapes);
    expect(r.why).toEqual({ 'gh:o/one': 'g1', b: 's1' });
  });
  it('survives missing arrays', () => {
    expect(radarItems({ answer: '', aisle: 'x', name: 'a', kind: 'user' } as any, tapes).items).toEqual([]);
  });
});

describe('answerItems (a clerk answer: GitHub picks, then the store slugs)', () => {
  it('lists github hits first, then known store tapes; a missing github list is empty', () => {
    const items = answerItems({ github: [hit('o/one')], slugs: ['skill-b', 'ghost'] }, tapes);
    expect(items.map(itemKey)).toEqual(['gh:o/one', 'b']);
    expect(answerItems({ slugs: ['skill-a'] }, tapes).map(itemKey)).toEqual(['a']);
    expect(answerItems({}, tapes)).toEqual([]);
  });
  it('github items from a plain answer carry an empty why', () => {
    expect((answerItems({ github: [hit('o/one')] }, tapes)[0] as any).why).toBe('');
  });
});

describe('radarTitle', () => {
  it('names a user with @ and a repo without', () => {
    expect(radarTitle({ kind: 'user', name: 'ann' })).toBe('YOUR RADAR · @ann');
    expect(radarTitle({ kind: 'repo', name: 'o/r' })).toBe('RADAR · o/r');
  });
});
