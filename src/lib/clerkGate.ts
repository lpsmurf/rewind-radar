/** Pure helpers for the clerk's GitHub gate (no browser or Supabase imports, so they unit-test in Node). */

export interface Member { token: string; login: string }

/** The bits of a Supabase session we use. */
interface SessionLike { access_token?: string; user?: { user_metadata?: Record<string, unknown> } | null }

/** A signed-in member from a Supabase session; null when signed out or the GitHub login is missing. */
export function memberOf(session: SessionLike | null | undefined): Member | null {
  const token = session?.access_token;
  const login = session?.user?.user_metadata?.user_name;
  return token && typeof login === 'string' && login ? { token, login } : null;
}

/** 'gate' = show the GitHub gate instead of the question box. */
export function gateState(github: string | null, member: Member | null): 'open' | 'gate' {
  return github || member ? 'open' : 'gate';
}

/** Headers for a clerk call: the Bearer token goes along only when signed in. */
export function clerkHeaders(member: Member | null): Record<string, string> {
  return { 'content-type': 'application/json', ...(member ? { authorization: `Bearer ${member.token}` } : {}) };
}

/** The sign-in button needs the VITE_GITHUB_SIGNIN flag and a Supabase client. */
export function canSignIn(flag: string | undefined, hasSupabase: boolean): boolean {
  return flag === '1' && hasSupabase;
}

/** A 401 from the clerk that asks for GitHub: its line to show, and whether the saved username was rejected. */
export function gateReply(status: number, j: { error?: string; gate?: string }, hadUsername: boolean): { line: string; forget: boolean } | null {
  if (status !== 401 || j.gate !== 'github') return null;
  return { line: j.error || 'Give me your GitHub username to talk to the clerk.', forget: hadUsername };
}
