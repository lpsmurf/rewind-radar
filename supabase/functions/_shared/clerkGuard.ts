import { parseRepoRef, type RepoRef } from './github.ts';

// In-character canned replies: used when we refuse or cannot afford to spend an AI call.
export const CLERK_LINES = {
  junk: "Hmm, that came through as static. Tell me what you're hunting for, or paste a GitHub repo, and I'll check the shelves.",
  offTopic:
    "Sorry, kiddo, I only talk tapes: Claude Code skills, GitHub repos and dev tools. Ask me what to rent, or paste a GitHub repo and I'll look it over.",
  budget:
    "The store's AI is out of quarters for today, so I can't read new repos right now. Come back tomorrow, or ask me about a tape and I'll search the shelves.",
  free: "My brain's on the fritz today, but I dug through the shelves for you. These look closest:",
  freeNone: "My brain's on the fritz and nothing on the shelves matched. Try different words, or come back tomorrow.",
  noRepo: "I looked everywhere, but GitHub doesn't have that one. Check the spelling, or make sure the repo is public.",
  rateLimit: "Whoa, slow down! The clerk needs a break from all those reviews. Try again in a little while.",
} as const;

export type Classified = { kind: 'junk'; reply: string } | { kind: 'repo'; ref: RepoRef } | { kind: 'ask'; text: string };

/** Cheap, free first pass over a clerk question, before any DB or AI call. */
export function classifyQuestion(text: string): Classified {
  const t = text.trim();
  if (!t || t.length > 300 || !/\p{L}/u.test(t)) return { kind: 'junk', reply: CLERK_LINES.junk };
  const ref = parseRepoRef(t);
  return ref ? { kind: 'repo', ref } : { kind: 'ask', text: t };
}
