import { fetchRepoFacts, parseRepoRef, type RepoFacts } from '../github.ts';
import { pool } from '../radar.ts';
import type { Candidate } from './types.ts';

/**
 * Check a candidate against GitHub. Returns the facts (full_name is the canonical owner/repo case) or null when the text
 * holds no repo or GitHub has none: a repo is never taken on a source's word. Throws GitHubError when GitHub refuses.
 */
export async function verifyCandidate(c: Candidate): Promise<RepoFacts | null> {
  const ref = parseRepoRef(c.repo);
  return ref ? fetchRepoFacts(ref) : null;
}

/** Verify many candidates, at most `size` at a time. Result i is for candidate i; a failed lookup is `null` plus its error. */
export async function verifyAll(cands: Candidate[], size = 4, onError?: (e: unknown) => void): Promise<(RepoFacts | null)[]> {
  return pool(cands, size, async (c) => {
    try {
      return await verifyCandidate(c);
    } catch (e) {
      onError?.(e);
      return null;
    }
  });
}
