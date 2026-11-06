import { DATA_RULE, HAIKU, sanitizeUntrusted, tool } from '../ai.ts';
import { env } from '../env.ts';
import { parseRepoRef } from '../github.ts';
import { parseChannelInput } from './config.ts';
import type { Candidate, Source, SourceCtx } from './types.ts';

/**
 * YouTube Data API v3 (env YOUTUBE_API_KEY). Finds videos from the last 7 days for the configured queries and channels,
 * takes GitHub links from their text in code, and asks Haiku only about promising videos with no link.
 *
 * Quota (default 10,000 units a day): search.list costs 100 units, videos.list 1 unit. At most 5 queries + 10 channels
 * = 15 searches = 1,500 units, plus at most 3 videos.list calls (50 ids each) = 3 units, plus one channels.list (1 unit) for
 * each @handle among the channels (at most 10 units, resolved once per run). About 1,500 a run, so a weekly run uses 15% of
 * one day's quota.
 */
const MAX_QUERIES = 5;
const MAX_CHANNELS = 10;
const MAX_CANDIDATES = 50;
const BATCH = 20; // videos per Haiku call
const MAX_BATCHES = 3; // Haiku calls per run
const API = 'https://www.googleapis.com/youtube/v3';

interface Video {
  id: string;
  title: string;
  description: string;
  channel: string;
}

let warned = false;

const strings = (v: unknown, max: number): string[] =>
  Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string' && s.trim() !== '').map((s) => s.trim()).slice(0, max) : [];

async function api(path: string, params: Record<string, string>): Promise<any> {
  const res = await fetch(`${API}/${path}?${new URLSearchParams(params)}`);
  if (!res.ok) {
    const detail = await res.json().then((j: any) => j?.error?.message, () => undefined);
    throw new Error(`YouTube ${path} responded ${res.status}${detail ? `: ${detail}` : ''}`);
  }
  return res.json();
}

/** The channel id of each configured entry (a UC id as is, an @handle looked up with channels.list?forHandle, once per run). One that does not resolve is skipped with a log. */
async function channelIds(entries: string[], key: string): Promise<string[]> {
  const byHandle = new Map<string, string | null>();
  const out: string[] = [];
  for (const e of entries) {
    const p = parseChannelInput(e);
    if (!p) {
      console.warn(`[sources] youtube: skipping channel ${e}: not a channel link, @handle or channel ID`);
    } else if ('channel_id' in p) {
      out.push(p.channel_id);
    } else {
      const h = p.handle.toLowerCase();
      if (!byHandle.has(h)) {
        const r = await api('channels', { part: 'id', forHandle: p.handle, key });
        const id = r.items?.[0]?.id;
        byHandle.set(h, typeof id === 'string' ? id : null);
        if (typeof id !== 'string') console.warn(`[sources] youtube: skipping channel ${p.handle}: no YouTube channel found`);
      }
      const id = byHandle.get(h);
      if (id) out.push(id);
    }
  }
  return [...new Set(out)];
}

/** Every GitHub repo linked in `text`, as owner/repo. */
function repoLinks(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/(?:https?:\/\/)?(?:www\.)?github\.com\/[^\s)\]>"'<]+/gi)) {
    const ref = parseRepoRef(m[0]);
    if (ref) out.push(ref.full);
  }
  return out;
}

const PROMISING = /\b(skills?|repos?|repositor(?:y|ies)|github|mcp|plugins?|open[- ]?source)\b/i;
const OWNER_REPO = /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/;

async function askHaiku(batch: Video[], ctx: SourceCtx): Promise<{ video_id: string; repo: string; why: string }[]> {
  const list = batch
    .map((v) => `video_id: ${v.id}\ntitle: ${sanitizeUntrusted(v.title, 150)}\ndescription: ${sanitizeUntrusted(v.description, 600)}`)
    .join('\n---\n');
  const out = await tool<{ items?: unknown }>({
    model: HAIKU,
    name: 'name_repos',
    maxTokens: 1200,
    onUsage: ctx.onUsage,
    system: `You read YouTube video titles and descriptions about Claude Code and AI coding agents. ${DATA_RULE}
For each video, name any GitHub repository or Claude Code skill the text explicitly mentions, as owner/repo. Only report one when the text names both the owner and the repo; never guess or invent one. Videos that name nothing get no item.`,
    user: `<data>\n${list}\n</data>`,
    schema: {
      type: 'object',
      properties: {
        items: {
          type: 'array',
          items: {
            type: 'object',
            properties: { video_id: { type: 'string' }, repo: { type: 'string', description: 'owner/repo' }, why: { type: 'string', description: 'one short line' } },
            required: ['video_id', 'repo', 'why'],
          },
        },
      },
      required: ['items'],
    },
  });
  const ids = new Set(batch.map((v) => v.id));
  const items = Array.isArray(out.items) ? out.items : [];
  return items.flatMap((i: any) =>
    i && ids.has(i.video_id) && typeof i.repo === 'string' && OWNER_REPO.test(i.repo.trim())
      ? [{ video_id: i.video_id as string, repo: i.repo.trim(), why: typeof i.why === 'string' ? i.why : '' }]
      : [],
  );
}

export const youtubeSource: Source = {
  name: 'youtube',
  async run(ctx) {
    const key = env('YOUTUBE_API_KEY');
    if (!key) {
      if (!warned) console.warn('[sources] youtube: YOUTUBE_API_KEY is not set, skipping');
      warned = true;
      return [];
    }
    const cfg = (await ctx.config('youtube')) as { queries?: unknown; channels?: unknown } | null;
    const queries = strings(cfg?.queries, MAX_QUERIES);
    const channels = await channelIds(strings(cfg?.channels, MAX_CHANNELS), key);
    const searches = [...queries.map((q) => ({ q })), ...channels.map((channelId) => ({ channelId }))];
    if (!searches.length) return [];

    const publishedAfter = new Date(ctx.now.getTime() - 7 * 86_400_000).toISOString();
    const ids = new Set<string>();
    for (const s of searches) {
      const r = await api('search', { part: 'snippet', type: 'video', order: 'date', maxResults: '10', publishedAfter, key, ...s });
      for (const it of r.items ?? []) if (typeof it?.id?.videoId === 'string') ids.add(it.id.videoId);
    }

    const videos: Video[] = [];
    const all = [...ids];
    for (let i = 0; i < all.length; i += 50) {
      const r = await api('videos', { part: 'snippet', id: all.slice(i, i + 50).join(','), key });
      for (const it of r.items ?? []) {
        const sn = it?.snippet;
        if (typeof it?.id === 'string' && sn) videos.push({ id: it.id, title: String(sn.title ?? ''), description: String(sn.description ?? ''), channel: String(sn.channelTitle ?? '') });
      }
    }

    const out: Candidate[] = [];
    const seen = new Set<string>();
    const add = (v: Video, repo: string, why?: string) => {
      const k = `${repo.toLowerCase()} ${v.id}`;
      if (seen.has(k)) return;
      seen.add(k);
      out.push({ repo, kind: 'repo', why, credit_url: `https://www.youtube.com/watch?v=${v.id}`, credit_title: v.title, credit_author: v.channel });
    };

    const unlinked: Video[] = [];
    for (const v of videos) {
      const links = repoLinks(`${v.title}\n${v.description}`);
      for (const repo of links) add(v, repo);
      if (!links.length && v.description.length >= 30 && PROMISING.test(`${v.title} ${v.description}`)) unlinked.push(v);
    }

    // The pipeline verifies every repo on GitHub, so a name Haiku gets wrong is dropped there.
    for (let i = 0, n = 0; i < unlinked.length && n < MAX_BATCHES; i += BATCH, n++) {
      if (!(await ctx.budget())) break;
      const batch = unlinked.slice(i, i + BATCH);
      const byId = new Map(batch.map((v) => [v.id, v]));
      for (const m of await askHaiku(batch, ctx)) add(byId.get(m.video_id)!, m.repo, m.why);
    }
    return out.slice(0, MAX_CANDIDATES);
  },
};
