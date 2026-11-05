import type { Proposal } from '../types';

export const ARCADE_PROPOSAL_TITLE = 'Open the arcade';
export const ARCADE_PROPOSAL_PITCH = 'Cabinets in the back room. Tell me when it opens.';

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();

/** The existing "Open the arcade" request, if someone already made one (highest votes wins). */
export function findArcadeProposal(proposals: Proposal[]): Proposal | undefined {
  return proposals
    .filter((p) => norm(p.title) === norm(ARCADE_PROPOSAL_TITLE))
    .sort((a, b) => b.votes - a.votes)[0];
}
