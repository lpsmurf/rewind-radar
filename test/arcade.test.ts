import { describe, expect, it } from 'vitest';
import { ARCADE_PROPOSAL_TITLE, findArcadeProposal } from '../src/store/arcade.ts';
import type { Proposal } from '../src/types.ts';

const prop = (o: Partial<Proposal>): Proposal => ({
  id: 'p1', kind: 'idea', title: 'x', pitch: '', link: null, submitter: null, genre: null, votes: 0,
  created_at: '2026-11-01T00:00:00Z', ...o,
});

describe('findArcadeProposal', () => {
  it('finds the open-the-arcade proposal, ignoring case and spacing', () => {
    const a = prop({ id: 'a', title: '  open THE  arcade ' });
    expect(findArcadeProposal([prop({ id: 'z', title: 'Figma skill' }), a])).toBe(a);
  });
  it('prefers the one with most votes', () => {
    const lo = prop({ id: 'lo', title: 'Open the arcade', votes: 1 });
    const hi = prop({ id: 'hi', title: 'Open the arcade!', votes: 9 });
    expect(findArcadeProposal([lo, hi])).toBe(hi);
  });
  it('returns undefined when there is none', () => {
    expect(findArcadeProposal([prop({ title: 'Arcade skins' })])).toBeUndefined();
    expect(findArcadeProposal([])).toBeUndefined();
  });
  it('the title we create matches our own finder', () => {
    expect(findArcadeProposal([prop({ title: ARCADE_PROPOSAL_TITLE })])).toBeDefined();
  });
});
