import { vi } from 'vitest';

export interface Vid {
  id: string;
  title?: string;
  description?: string;
  channel?: string;
}

/**
 * Stub fetch for the YouTube Data API. `search(params)` returns the video ids one search.list call finds
 * (params = its query string as an object); `videos` is every video videos.list can describe. `fail` makes every call answer that status.
 */
export function stubYouTube(o: { search?: (p: Record<string, string>) => string[]; videos?: Vid[]; fail?: number }) {
  const calls: { kind: 'search' | 'videos'; params: Record<string, string> }[] = [];
  vi.stubGlobal('fetch', async (input: unknown) => {
    const u = new URL(String(input));
    const params = Object.fromEntries(u.searchParams);
    if (o.fail) return new Response(JSON.stringify({ error: { message: 'quotaExceeded' } }), { status: o.fail });
    if (u.pathname.endsWith('/search')) {
      calls.push({ kind: 'search', params });
      return new Response(JSON.stringify({ items: (o.search?.(params) ?? []).map((id) => ({ id: { videoId: id } })) }));
    }
    if (u.pathname.endsWith('/videos')) {
      calls.push({ kind: 'videos', params });
      const want = new Set(params.id.split(','));
      const items = (o.videos ?? [])
        .filter((v) => want.has(v.id))
        .map((v) => ({ id: v.id, snippet: { title: v.title ?? `Video ${v.id}`, description: v.description ?? '', channelTitle: v.channel ?? 'Chan' } }));
      return new Response(JSON.stringify({ items }));
    }
    throw new Error(`unmocked fetch: ${u}`);
  });
  return calls;
}

export interface WatchVideo {
  id: string;
  title?: string;
  description?: string;
  publishedAt: string;
  channel?: string;
}
export interface WatchThread {
  author: string;
  text: string;
  replies?: { author: string; text: string }[];
}

/**
 * Stub fetch for the channel watcher: channels.list (forHandle), playlistItems.list and commentThreads.list.
 * `handles` maps a handle to its channel id; the uploads playlist of channel `UCx` is `UUx`. `uploads` maps a playlist id to its videos,
 * `threads` a video id to its comment threads. playlistItems pages by `maxResults` and `pageToken` (an offset) and sets `nextPageToken`, newest video first as listed. `fail(kind, params)` returns an HTTP status to make that call fail.
 */
export function stubWatchApi(o: {
  handles?: Record<string, string>;
  uploads?: Record<string, WatchVideo[]>;
  threads?: Record<string, WatchThread[]>;
  fail?: (kind: string, params: Record<string, string>) => number | [number, string] | undefined;
}) {
  const calls: { kind: 'channels' | 'playlistItems' | 'commentThreads'; params: Record<string, string> }[] = [];
  const comment = (author: string, text: string) => ({ snippet: { authorChannelId: { value: author }, textOriginal: text, textDisplay: text } });
  vi.stubGlobal('fetch', async (input: unknown) => {
    const u = new URL(String(input));
    const params = Object.fromEntries(u.searchParams);
    const kind = u.pathname.split('/').pop() as 'channels' | 'playlistItems' | 'commentThreads';
    if (!['channels', 'playlistItems', 'commentThreads'].includes(kind)) throw new Error(`unmocked fetch: ${u}`);
    calls.push({ kind, params });
    const status = o.fail?.(kind, params);
    if (status) {
      const [code, reason] = Array.isArray(status) ? status : [status, 'backendError'];
      return new Response(JSON.stringify({ error: { message: 'boom', errors: [{ reason }] } }), { status: code });
    }
    if (kind === 'channels') {
      const id = o.handles?.[params.forHandle];
      return new Response(JSON.stringify({ items: id ? [{ id, contentDetails: { relatedPlaylists: { uploads: 'UU' + id.slice(2) } } }] : [] }));
    }
    if (kind === 'playlistItems') {
      const all = o.uploads?.[params.playlistId] ?? [];
      const size = Number(params.maxResults) || all.length;
      const from = Number(params.pageToken) || 0;
      const items = all.slice(from, from + size).map((v) => ({
        snippet: {
          title: v.title ?? `Video ${v.id}`,
          description: v.description ?? '',
          publishedAt: v.publishedAt,
          channelTitle: v.channel ?? 'The Channel',
          resourceId: { videoId: v.id },
        },
        contentDetails: { videoId: v.id, videoPublishedAt: v.publishedAt },
      }));
      return new Response(JSON.stringify({ items, ...(from + size < all.length ? { nextPageToken: String(from + size) } : {}) }));
    }
    const items = (o.threads?.[params.videoId] ?? []).map((t) => ({
      snippet: { topLevelComment: comment(t.author, t.text) },
      replies: t.replies ? { comments: t.replies.map((r) => comment(r.author, r.text)) } : undefined,
    }));
    return new Response(JSON.stringify({ items }));
  });
  return calls;
}
