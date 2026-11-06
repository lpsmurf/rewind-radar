/** The source_config rows the admin panel may edit, and their shape. Everything else is refused. */
export const CONFIG_KEYS = ['youtube', 'web', 'watch'] as const;
export type ConfigKey = (typeof CONFIG_KEYS)[number];
export const isConfigKey = (k: string): k is ConfigKey => (CONFIG_KEYS as readonly string[]).includes(k);

const CHANNEL = /^UC[\w-]{22}$/;
const HANDLE = /^@[A-Za-z0-9._-]{3,30}$/;
const MAX_WATCH = 10;
const BARE_HANDLE = /^[A-Za-z0-9._-]{3,30}$/;
const YT_URL = /^(?:https?:\/\/)?(?:www\.|m\.)?youtube\.com\/([^?#]*)(?:[?#].*)?$/i;

/** Message for the admin when a channel input is not understood. */
export const CHANNEL_INPUT_HINT = 'Use a channel link, @handle or channel ID';

/**
 * Any common way of naming a YouTube channel: @handle, a bare handle (3 to 30 of A-Za-z0-9._-), a channel URL
 * (youtube.com/@handle[/videos], m.youtube.com, with or without a query) or a UC id (bare or in /channel/UC...).
 * Video, /c/ and /user/ URLs and anything else give null. The handle keeps its case and always starts with @.
 */
export function parseChannelInput(input: string): { handle: string } | { channel_id: string } | null {
  if (typeof input !== 'string') return null;
  const s = input.trim();
  if (CHANNEL.test(s)) return { channel_id: s };
  if (HANDLE.test(s)) return { handle: s };
  const m = YT_URL.exec(s);
  if (m) {
    const [first, second] = m[1].split('/');
    let seg = first;
    try {
      seg = decodeURIComponent(first);
    } catch {
      return null;
    }
    if (HANDLE.test(seg)) return { handle: seg };
    if (seg.toLowerCase() === 'channel' && CHANNEL.test(second ?? '')) return { channel_id: second };
    return null;
  }
  if (BARE_HANDLE.test(s) && !/youtube\.com|youtu\.be/i.test(s)) return { handle: `@${s}` };
  return null;
}

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

/**
 * The watcher's list: only handles come from the admin. Whatever the watcher learned (resolved ids, seen videos) is kept from
 * `current` for handles that stay, so saving the list never makes it re-resolve or re-stock.
 */
function parseWatch(o: Record<string, unknown>, current: unknown): { value: Record<string, unknown> } | { error: string } {
  if (!Array.isArray(o.channels)) return { error: 'channels must be a list' };
  if (o.channels.length > MAX_WATCH) return { error: `At most ${MAX_WATCH} channels` };
  const cur = current && typeof current === 'object' ? (current as Record<string, unknown>) : {};
  const old = (Array.isArray(cur.channels) ? cur.channels : []).filter((c: any) => c && typeof c.handle === 'string') as Record<string, unknown>[];
  const channels: Record<string, unknown>[] = [];
  const have = new Set<string>();
  for (const x of o.channels) {
    const h = (typeof x === 'string' ? x : x && typeof x === 'object' ? (x as Record<string, unknown>).handle : '');
    const handle = typeof h === 'string' ? h.trim() : '';
    if (!HANDLE.test(handle)) return { error: 'Each channel must be a handle like @TheNextNewThingAI' };
    if (have.has(handle.toLowerCase())) continue;
    have.add(handle.toLowerCase());
    const prev = old.find((c) => String(c.handle).toLowerCase() === handle.toLowerCase());
    channels.push({
      handle,
      ...(prev && typeof prev.channel_id === 'string' && typeof prev.uploads === 'string' ? { channel_id: prev.channel_id, uploads: prev.uploads } : {}),
    });
  }
  const seen = (Array.isArray(cur.seen) ? cur.seen : []).filter((s): s is string => typeof s === 'string').slice(-300);
  return { value: { channels, seen } };
}

/** Check a config value for `key` and return it cleaned (trimmed), or an error message for the admin. `current` is the stored value (the watch list keeps what the watcher learned). */
export function parseSourceConfig(key: ConfigKey, v: unknown, current?: unknown): { value: Record<string, unknown> } | { error: string } {
  const o = v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  if (!o) return { error: 'Send a JSON object' };
  if (key === 'watch') return parseWatch(o, current);
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
