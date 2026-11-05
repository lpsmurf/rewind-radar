import { admin } from './admin.ts';
import { githubUserExists, GitHubError } from './github.ts';

/** Who is calling the clerk. `unknown` marks a guest who gave a well-formed username GitHub does not know. */
export type Identity =
  | { tier: 'member'; userId: string; github: string }
  | { tier: 'light'; github: string }
  | { tier: 'guest'; unknown?: true };

const LOGIN = /^[A-Za-z0-9-]{1,39}$/;

/** A member is a Supabase Auth user signed in with GitHub. Any failure means "not a member". */
async function member(req: Request): Promise<Identity | null> {
  const token = /^Bearer\s+(\S+)$/i.exec(req.headers.get('authorization') ?? '')?.[1];
  if (!token) return null;
  try {
    const { data, error } = await admin().auth.getUser(token);
    const u = data?.user;
    if (error || !u) return null;
    const viaGithub = u.app_metadata?.provider === 'github' || (u.identities ?? []).some((i: { provider?: string }) => i.provider === 'github');
    const login = String(u.user_metadata?.user_name ?? '').trim();
    if (!viaGithub || !LOGIN.test(login)) return null;
    return { tier: 'member', userId: u.id, github: login };
  } catch (e) {
    console.warn('[identity] token check failed', e);
    return null;
  }
}

export async function whoIs(req: Request, body: Record<string, unknown>): Promise<Identity> {
  const m = await member(req);
  if (m) return m;
  const login = typeof body.github === 'string' ? body.github.trim().replace(/^@/, '') : '';
  if (!LOGIN.test(login)) return { tier: 'guest' };
  try {
    return (await githubUserExists(login)) ? { tier: 'light', github: login } : { tier: 'guest', unknown: true };
  } catch (e) {
    // Only a GitHub outage (403/5xx) or a network failure lets people through; the IP limits still apply.
    console.warn('[identity] GitHub check failed, letting the visitor through as light', e instanceof GitHubError ? e.status : e);
    return { tier: 'light', github: login };
  }
}
