import { describe, expect, it } from 'vitest';
import { classifyQuestion, CLERK_LINES } from '../lib/clerkGuard.ts';

describe('classifyQuestion', () => {
  it('routes a pasted repo to the assessment', () => {
    expect(classifyQuestion('what about https://github.com/gitroomhq/postiz-app ?')).toMatchObject({
      kind: 'repo',
      ref: { full: 'gitroomhq/postiz-app', bare: false },
    });
  });

  it.each(['', '   ', '???', '1234 5678', 'x'.repeat(301)])('treats %j as junk with a canned reply', (q) => {
    expect(classifyQuestion(q)).toEqual({ kind: 'junk', reply: CLERK_LINES.junk });
  });

  it('passes ordinary questions through, trimmed', () => {
    expect(classifyQuestion('  a skill for making diagrams ')).toEqual({ kind: 'ask', text: 'a skill for making diagrams' });
  });

  it('has in-character lines for every refusal', () => {
    for (const k of ['junk', 'offTopic', 'budget', 'free', 'freeNone', 'noRepo', 'rateLimit'] as const) {
      expect(CLERK_LINES[k].length).toBeGreaterThan(10);
    }
  });
});
