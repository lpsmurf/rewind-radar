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

/** The weekly YouTube channels: any channel form, stored as the UC id when one is given, otherwise as the @handle. Repeats are dropped. */
function youtubeChannels(v: unknown): string[] | string {
  if (!Array.isArray(v)) return 'channels must be a list';
  if (v.length > 10) return 'At most 10 channels';
  const out: string[] = [];
  const have = new Set<string>();
  for (const x of v) {
    const p = typeof x === 'string' ? parseChannelInput(x) : null;
    if (!p) return CHANNEL_INPUT_HINT;
    const c = 'handle' in p ? p.handle : p.channel_id;
    const k = 'handle' in p ? c.toLowerCase() : c;
    if (have.has(k)) continue;
    have.add(k);
    out.push(c);
  }
  return out;
}

/**
 * The watcher's list: the admin sends any channel form (see parseChannelInput); each is stored as `{ handle }` or `{ channel_id }`.
 * Whatever the watcher learned (resolved ids, uploads playlist, seen videos, backfill state) is kept from `current` for entries that stay,
 * so saving the list never makes it re-resolve or re-stock.
 */
function parseWatch(o: Record<string, unknown>, current: unknown): { value: Record<string, unknown> } | { error: string } {
  if (!Array.isArray(o.channels)) return { error: 'channels must be a list' };
  if (o.channels.length > MAX_WATCH) return { error: `At most ${MAX_WATCH} channels` };
  const cur = current && typeof current === 'object' ? (current as Record<string, unknown>) : {};
  const old = (Array.isArray(cur.channels) ? cur.channels : []).filter((c: any) => c && (typeof c.handle === 'string' || typeof c.channel_id === 'string')) as Record<string, unknown>[];
  const keyOf = (c: { handle?: unknown; channel_id?: unknown }) => (typeof c.handle === 'string' ? `h:${c.handle.toLowerCase()}` : `c:${String(c.channel_id)}`);
  const channels: Record<string, unknown>[] = [];
  const have = new Set<string>();
  for (const x of o.channels) {
    const raw = typeof x === 'string' ? x : x && typeof x === 'object' ? ((x as Record<string, unknown>).handle ?? (x as Record<string, unknown>).channel_id) : '';
    const p = typeof raw === 'string' ? parseChannelInput(raw) : null;
    if (!p) return { error: CHANNEL_INPUT_HINT };
    const entry: Record<string, unknown> = 'handle' in p ? { handle: p.handle } : { channel_id: p.channel_id };
    const k = keyOf(entry);
    if (have.has(k)) continue;
    have.add(k);
    const prev = old.find((c) => keyOf(c) === k);
    // The backfill state belongs to the watcher: an unchanged entry keeps it, a new one starts without (and so backfills on its own).
    const state = {
      ...(prev && typeof prev.backfilled_at === 'string' ? { backfilled_at: prev.backfilled_at } : {}),
      ...(prev && typeof prev.backfill_left === 'number' ? { backfill_left: prev.backfill_left } : {}),
    };
    if (prev && typeof prev.uploads === 'string' && (typeof prev.channel_id === 'string')) {
      channels.push({ ...entry, channel_id: prev.channel_id, uploads: prev.uploads, ...state });
    } else channels.push({ ...entry, ...state });
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
  const channels = youtubeChannels(o.channels);
  if (typeof channels === 'string') return { error: channels };
  if (!queries.length && !channels.length) return { error: 'Add at least one query or channel' };
  return { value: { queries, channels } };
}
