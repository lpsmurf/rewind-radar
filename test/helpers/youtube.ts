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
