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
    db.current.tokens.t1 = { id: 'u9', app_metadata: { provider: 'email' }, user_metadata: { user_name: 'octo' }, identities: [{ provider: 'github' }] };
    expect(await whoIs(req('t1'), {})).toMatchObject({ tier: 'member', userId: 'u9', github: 'octo' });
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

  it('lets the visitor through as light when GitHub is down (403/5xx), and logs it', async () => {
    stubGitHub({ '/users/lpsmurf': 503 });
    expect(await whoIs(req(), { github: 'lpsmurf' })).toEqual({ tier: 'light', github: 'lpsmurf' });
    expect(console.warn).toHaveBeenCalled();
    stubGitHub({ '/users/other': 403 });
    expect(await whoIs(req(), { github: 'other' })).toEqual({ tier: 'light', github: 'other' });
  });
});
