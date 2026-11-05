import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeDb } from './helpers/fakeDb.ts';
import { githubMember } from './helpers/samples.ts';
import { stubGitHub } from './helpers/github.ts';

const { db } = vi.hoisted(() => ({ db: { current: null as any } }));
vi.mock('../lib/admin.ts', () => ({ admin: () => db.current.client }));

import { whoIs } from '../lib/identity.ts';

const req = (token?: string) =>
  new Request('http://localhost/api/clerk', { method: 'POST', headers: token ? { authorization: `Bearer ${token}` } : {} });

beforeEach(() => {
  db.current = fakeDb();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('whoIs: member', () => {
  it('accepts a valid token of a GitHub user and takes the login from the token', async () => {
    db.current.tokens.t1 = githubMember('octo');
    expect(await whoIs(req('t1'), { github: 'someone-else' })).toEqual({ tier: 'member', userId: 'uid-octo', github: 'octo' });
  });

  it('accepts a GitHub identity listed only in identities', async () => {
    db.current.tokens.t1 = { id: 'u9', app_metadata: { provider: 'email' }, user_metadata: {}, identities: [{ provider: 'github', identity_data: { user_name: 'octo' } }] };
    expect(await whoIs(req('t1'), {})).toMatchObject({ tier: 'member', userId: 'u9', github: 'octo' });
  });

  it('falls back to preferred_username in the identity data', async () => {
    db.current.tokens.t1 = { id: 'u8', app_metadata: { provider: 'github' }, user_metadata: {}, identities: [{ provider: 'github', identity_data: { preferred_username: 'pref' } }] };
    expect(await whoIs(req('t1'), {})).toMatchObject({ tier: 'member', github: 'pref' });
  });

  it('ignores a spoofed user_metadata.user_name: the login comes from the GitHub identity', async () => {
    db.current.tokens.t1 = { ...githubMember('real-login'), user_metadata: { user_name: 'victim' } };
    expect(await whoIs(req('t1'), {})).toMatchObject({ tier: 'member', github: 'real-login' });
  });

  it('does not make a member of an anonymous Supabase user with no identities', async () => {
    db.current.tokens.t1 = { id: 'anon1', app_metadata: { provider: 'github' }, user_metadata: { user_name: 'victim' }, identities: [] };
    expect(await whoIs(req('t1'), {})).toEqual({ tier: 'guest' });
    db.current.tokens.t2 = { id: 'anon2', is_anonymous: true, user_metadata: { user_name: 'victim' } };
    expect(await whoIs(req('t2'), {})).toEqual({ tier: 'guest' });
  });

  it('rejects a user who signed in another way and falls through to guest', async () => {
    db.current.tokens.t1 = { id: 'u2', app_metadata: { provider: 'email' }, user_metadata: {}, identities: [{ provider: 'email' }] };
    expect(await whoIs(req('t1'), {})).toEqual({ tier: 'guest' });
  });

  it('falls through to light on a bad token when the body has a real username', async () => {
    stubGitHub({ '/users/lpsmurf': 200 });
    expect(await whoIs(req('nope'), { github: 'lpsmurf' })).toEqual({ tier: 'light', github: 'lpsmurf' });
  });

  it('falls through when getUser throws', async () => {
    db.current.client.auth.getUser = async () => {
      throw new Error('boom');
    };
    expect(await whoIs(req('t1'), {})).toEqual({ tier: 'guest' });
  });
});

describe('whoIs: light and guest', () => {
  it('accepts a username GitHub knows (a leading @ is stripped)', async () => {
    stubGitHub({ '/users/lpsmurf': 200 });
    expect(await whoIs(req(), { github: '@lpsmurf' })).toEqual({ tier: 'light', github: 'lpsmurf' });
  });

  it('marks an unknown username as a guest that was unknown', async () => {
    stubGitHub({});
    expect(await whoIs(req(), { github: 'ghost-user' })).toEqual({ tier: 'guest', unknown: true });
  });

  it('is a plain guest with no username, a malformed one, or none of the above', async () => {
    expect(await whoIs(req(), {})).toEqual({ tier: 'guest' });
    expect(await whoIs(req(), { github: 'not a user!' })).toEqual({ tier: 'guest' });
    expect(await whoIs(req(), { github: 'a'.repeat(40) })).toEqual({ tier: 'guest' });
    expect(await whoIs(req(), { github: 42 })).toEqual({ tier: 'guest' });
  });

  it('fails closed on a GitHub outage (403/5xx/network) for an uncached name, and logs it', async () => {
    stubGitHub({ '/users/lpsmurf': 503, '/users/other': 403 });
    expect(await whoIs(req(), { github: 'lpsmurf' })).toEqual({ tier: 'busy', why: 'github' });
    expect(console.warn).toHaveBeenCalled();
    expect(await whoIs(req(), { github: 'other' })).toEqual({ tier: 'busy', why: 'github' });
    vi.stubGlobal('fetch', async () => { throw new Error('offline'); });
    expect(await whoIs(req(), { github: 'third' })).toEqual({ tier: 'busy', why: 'github' });
  });

  it('lets a name cached as a hit pass during an outage', async () => {
    stubGitHub({ '/users/lpsmurf': 200 });
    await whoIs(req(), { github: 'lpsmurf' });
    stubGitHub({ '/users/lpsmurf': 503 });
    expect(await whoIs(req(), { github: 'lpsmurf' })).toEqual({ tier: 'light', github: 'lpsmurf' });
  });

  it('checks the lookup allowance (peek) before the GitHub fetch, and consumes it only for a real call', async () => {
    const seen = stubGitHub({ '/users/lpsmurf': 200 });
    const calls: boolean[] = [];
    const gate = { allowLookup: (dry: boolean) => (calls.push(dry), false) };
    expect(await whoIs(req(), { github: 'lpsmurf' }, gate)).toEqual({ tier: 'busy', why: 'limit' });
    expect(calls).toEqual([true]);
    expect(seen).toHaveLength(0);
    const ok = { allowLookup: (dry: boolean) => (calls.push(dry), true) };
    calls.length = 0;
    await whoIs(req(), { github: 'lpsmurf' }, ok);
    expect(calls).toEqual([true, false]);
    calls.length = 0;
    await whoIs(req(), { github: 'lpsmurf' }, gate); // cached now: no allowance needed
    expect(calls).toEqual([]);
  });
});
