import { describe, expect, it } from 'vitest';
import { parseRepoRef } from '../lib/github.ts';

describe('parseRepoRef', () => {
  it.each([
    ['https://github.com/gitroomhq/postiz-app', 'gitroomhq/postiz-app'],
    ['check this out https://www.github.com/gitroomhq/postiz-app.git please', 'gitroomhq/postiz-app'],
    ['github.com/vercel/next.js/tree/canary/packages', 'vercel/next.js'],
    ['https://github.com/vercel/next.js#readme', 'vercel/next.js'],
    ['https://github.com/vercel/next.js?tab=readme-ov-file', 'vercel/next.js'],
    ['is https://github.com/gitroomhq/postiz-app. any good?', 'gitroomhq/postiz-app'],
    ['gitroomhq/postiz-app', 'gitroomhq/postiz-app'],
    ['@gitroomhq/postiz-app', 'gitroomhq/postiz-app'],
  ])('%s -> %s', (text, full) => {
    expect(parseRepoRef(text)?.full).toBe(full);
  });

  it('splits owner and repo', () => {
    expect(parseRepoRef('https://github.com/gitroomhq/postiz-app')).toMatchObject({ owner: 'gitroomhq', repo: 'postiz-app', bare: false });
  });

  it('marks a bare owner/repo as a guess, so a 404 can fall back to a normal question', () => {
    expect(parseRepoRef('and/or')).toMatchObject({ full: 'and/or', bare: true });
  });

  it.each([
    'CI/CD tools?',
    'a skill for making diagrams',
    'https://github.com/lpsmurf',
    'https://github.com/orgs/vercel/repositories',
    'https://github.com/topics/mcp',
    'https://github.com/marketplace/actions/checkout',
    'https://gitlab.com/a/b',
    'https://notgithub.com/a/b',
    '',
  ])('%j -> null', (text) => {
    expect(parseRepoRef(text)).toBeNull();
  });

  it('skips a reserved path and finds a later repo URL', () => {
    expect(parseRepoRef('see https://github.com/topics/mcp and https://github.com/a/b')?.full).toBe('a/b');
  });
});
