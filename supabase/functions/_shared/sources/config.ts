/** The source_config rows the admin panel may edit, and their shape. Everything else is refused. */
export const CONFIG_KEYS = ['youtube', 'web'] as const;
export type ConfigKey = (typeof CONFIG_KEYS)[number];
export const isConfigKey = (k: string): k is ConfigKey => (CONFIG_KEYS as readonly string[]).includes(k);

const CHANNEL = /^UC[\w-]{22}$/;

function list(v: unknown, max: number, what: string, ok: (s: string) => boolean, rule: string): string[] | string {
  if (!Array.isArray(v)) return `${what} must be a list`;
  if (v.length > max) return `At most ${max} ${what}`;
  const out: string[] = [];
  for (const x of v) {
    const s = typeof x === 'string' ? x.trim() : '';
    if (!s || !ok(s)) return `Each of ${what} must be ${rule}`;
    out.push(s);
  }
  return out;
}

/** Check a config value for `key` and return it cleaned (trimmed), or an error message for the admin. */
export function parseSourceConfig(key: ConfigKey, v: unknown): { value: Record<string, unknown> } | { error: string } {
  const o = v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  if (!o) return { error: 'Send a JSON object' };
  if (key === 'web') {
    const q = typeof o.query === 'string' ? o.query.trim() : '';
    if (!q || q.length > 300) return { error: 'query must be 1 to 300 characters' };
    return { value: { query: q } };
  }
  const queries = list(o.queries, 5, 'queries', (s) => s.length <= 100, 'text up to 100 characters');
  if (typeof queries === 'string') return { error: queries };
  const channels = list(o.channels, 10, 'channels', (s) => CHANNEL.test(s), 'a YouTube channel id (UC plus 22 characters)');
  if (typeof channels === 'string') return { error: channels };
  if (!queries.length && !channels.length) return { error: 'Add at least one query or channel' };
  return { value: { queries, channels } };
}
