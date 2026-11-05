import { describe, expect, it } from 'vitest';
import { canSignIn, clerkHeaders, gateReply, gateState, memberOf } from '../src/lib/clerkGate.ts';

const session = { access_token: 'tok', user: { user_metadata: { user_name: 'octo' } } };

describe('memberOf', () => {
  it('reads the token and GitHub login from a session', () => {
    expect(memberOf(session)).toEqual({ token: 'tok', login: 'octo' });
  });
  it('is null when signed out or the login is missing', () => {
    expect(memberOf(null)).toBeNull();
    expect(memberOf({ access_token: 'tok', user: { user_metadata: {} } })).toBeNull();
    expect(memberOf({ user: { user_metadata: { user_name: 'octo' } } })).toBeNull();
  });
});

describe('gateState', () => {
  it('shows the gate only with no username and no session', () => {
    expect(gateState(null, null)).toBe('gate');
    expect(gateState('octo', null)).toBe('open');
    expect(gateState(null, { token: 't', login: 'octo' })).toBe('open');
  });
});

describe('clerkHeaders', () => {
  it('adds a Bearer token only for members', () => {
    expect(clerkHeaders(null)).toEqual({ 'content-type': 'application/json' });
    expect(clerkHeaders({ token: 'tok', login: 'octo' })).toEqual({ 'content-type': 'application/json', authorization: 'Bearer tok' });
  });
});

describe('canSignIn', () => {
  it('needs the flag set to "1" and a Supabase client', () => {
    expect(canSignIn('1', true)).toBe(true);
    expect(canSignIn('1', false)).toBe(false);
    expect(canSignIn('', true)).toBe(false);
    expect(canSignIn(undefined, true)).toBe(false);
    expect(canSignIn('true', true)).toBe(false);
  });
});

describe('gateReply', () => {
  it('turns a GitHub gate 401 into the line, and forgets a rejected saved username', () => {
    expect(gateReply(401, { error: 'unknown', gate: 'github' }, true)).toEqual({ line: 'unknown', forget: true });
    expect(gateReply(401, { error: 'hold on', gate: 'github' }, false)).toEqual({ line: 'hold on', forget: false });
  });
  it('ignores other responses', () => {
    expect(gateReply(429, { error: 'x' }, true)).toBeNull();
    expect(gateReply(401, { error: 'x' }, true)).toBeNull();
    expect(gateReply(200, { gate: 'github' }, true)).toBeNull();
  });
});
