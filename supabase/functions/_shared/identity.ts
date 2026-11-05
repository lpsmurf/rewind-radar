import { admin } from './admin.ts';
import { githubUserExists, peekGithubUser } from './github.ts';

/** Who is calling the clerk. `unknown` marks a guest who gave a well-formed username GitHub does not know. */
export type Identity =
  | { tier: 'member'; userId: string; github: string }
  | { tier: 'light'; github: string }
  | { tier: 'guest'; unknown?: true }
  /** Could not check the username right now: over the lookup allowance, or GitHub is unreachable. */
  | { tier: 'busy'; why: 'limit' | 'github' };

/** Per-IP allowance for uncached username lookups: `allowLookup(true)` peeks, `allowLookup(false)` consumes. */
export interface LookupGate { allowLookup(dry: boolean): boolean }

const LOGIN = /^[A-Za-z0-9-]{1,39}$/;

/**
 * A member is a Supabase Auth user signed in with GitHub. The login comes from the GitHub identity, never from
 * user_metadata (users can edit that themselves). Any failure means "not a member".
 */
async function member(req: Request): Promise<Identity | null> {
  const token = /^Bearer\s+(\S+)$/i.exec(req.headers.get('authorization') ?? '')?.[1];
  if (!token) return null;
  try {
    const { data, error } = await admin().auth.getUser(token);
    const u = data?.user;
    if (error || !u) return null;
    const gh = (u.identities ?? []).find((i: { provider?: string }) => i.provider === 'github');
    const d = (gh?.identity_data ?? {}) as Record<string, unknown>;
    const login = String(d.user_name ?? d.preferred_username ?? '').trim();
    if (!gh || !LOGIN.test(login)) return null;
    return { tier: 'member', userId: u.id, github: login };
  } catch (e) {
    console.warn('[identity] token check failed', e);
    return null;
  }
}

export async function whoIs(req: Request, body: Record<string, unknown>, gate: LookupGate = { allowLookup: () => true }): Promise<Identity> {
  const m = await member(req);
  if (m) return m;
  const login = typeof body.github === 'string' ? body.github.trim().replace(/^@/, '') : '';
  if (!LOGIN.test(login)) return { tier: 'guest' };
  const cached = peekGithubUser(login);
  if (cached !== undefined) return cached ? { tier: 'light', github: login } : { tier: 'guest', unknown: true };
  // Only a real GitHub call costs an allowance; check before fetching, consume when we do.
  if (!gate.allowLookup(true)) return { tier: 'busy', why: 'limit' };
  gate.allowLookup(false);
  try {
    return (await githubUserExists(login)) ? { tier: 'light', github: login } : { tier: 'guest', unknown: true };
  } catch (e) {
    // Fail closed: a GitHub outage (403/5xx/network) must not become a free pass. Names cached as hits still pass above.
    console.warn('[identity] GitHub check failed', e);
    return { tier: 'busy', why: 'github' };
  }
}
