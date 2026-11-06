import { env } from '../env.ts';
import { parseRepoRef } from '../github.ts';

/**
 * Channel watcher: for each channel in source_config 'watch', find uploads from the last 14 days we have not processed, read the
 * comments the channel itself wrote (creators list their repos there) plus the description, and stock every GitHub repo linked.
 *
 * Quota (YouTube Data API v3, 10,000 units a day, every call below is 1 unit): channels.list once per channel ever (handle
 * resolution is cached), playlistItems.list once per channel per run, commentThreads.list once per new video. A run over one channel
 * with one new video is 2 units (3 the first time); a 3-hourly schedule is about 8 to 24 units a day.
 */
const API = 'https://www.googleapis.com/youtube/v3';
const WINDOW_MS = 14 * 86_400_000;
const FRESH_MS = 48 * 3_600_000;
const SEEN_MAX = 300;
const RUN_CAP = 25; // repos stocked per run
const MAX_CHANNELS = 10;

export interface WatchChannel {
  handle: string;
  channel_id?: string;
  uploads?: string;
}
export interface WatchConfig {
  channels: WatchChannel[];
  seen: string[];
}
export interface StockResult {
  status: 'added' | 'restored' | 'duplicate' | 'not_found' | 'error';
  slug?: string;
  cost_usd?: number;
}
export interface WatchCtx {
  config: (key: string) => Promise<unknown>;
  saveConfig: (key: string, value: unknown) => Promise<void>;
  /** False once today's AI budget is spent. */
  budget: () => Promise<boolean>;
  /** Put one repo (owner/repo) on the shelves, crediting a video. Duplicates cost nothing. */
  stock: (repo: string, credit: { url: string; title: string }) => Promise<StockResult>;
  logRun: (row: { found: number; queued: number; cost_usd: number; error?: string }) => Promise<void>;
  now: Date;
}
export interface WatchSummary {
  channels: number;
  videos_checked: number;
  repos_found: number;
  added: number;
  restored: number;
  duplicates: number;
  errors: number;
  not_found: number;
  cost_usd: number;
  skipped?: string;
  messages?: string[];
}

class YouTubeError extends Error {
  constructor(message: string, public status: number, public reason?: string) {
    super(message);
  }
}

async function api(path: string, params: Record<string, string>): Promise<any> {
  const res = await fetch(`${API}/${path}?${new URLSearchParams(params)}`);
  if (!res.ok) {
    const j: any = await res.json().catch(() => undefined);
    const detail = j?.error?.message;
    throw new YouTubeError(`YouTube ${path} responded ${res.status}${detail ? `: ${detail}` : ''}`, res.status, j?.error?.errors?.[0]?.reason);
  }
  return res.json();
}

/** Every GitHub repo linked in `text`, as owner/repo, once each. Issue and pull links, user pages and gists are not recommendations. */
export function watchRepoLinks(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of text.matchAll(/(?<![\w.-])(?:https?:\/\/)?(?:www\.)?github\.com\/[^\s)\]>"'<,;]+/gi)) {
    if (/github\.com\/[^/]+\/[^/]+\/(?:issues|pull|pulls|discussions)(?:\/|$)/i.test(m[0])) continue;
    const ref = parseRepoRef(m[0]);
    if (!ref || seen.has(ref.full.toLowerCase())) continue;
    seen.add(ref.full.toLowerCase());
    out.push(ref.full);
  }
  return out;
}

const text = (c: any): string => String(c?.snippet?.textOriginal ?? c?.snippet?.textDisplay ?? '');

/** The text of every comment (top-level and reply) written by the channel itself. */
async function ownerComments(videoId: string, channelId: string, key: string): Promise<string> {
  let r: any;
  try {
    r = await api('commentThreads', { part: 'snippet,replies', videoId, maxResults: '100', order: 'relevance', key });
  } catch (e) {
    if (e instanceof YouTubeError && e.reason === 'commentsDisabled') return '';
    throw e;
  }
  const out: string[] = [];
  for (const t of r.items ?? []) {
    const top = t?.snippet?.topLevelComment;
    if (top?.snippet?.authorChannelId?.value === channelId) out.push(text(top));
    for (const c of t?.replies?.comments ?? []) if (c?.snippet?.authorChannelId?.value === channelId) out.push(text(c));
  }
  return out.join('\n');
}

const asConfig = (v: unknown): WatchConfig => {
  const o = v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
  const channels = (Array.isArray(o.channels) ? o.channels : [])
    .filter((c: any) => c && typeof c.handle === 'string' && c.handle)
    .slice(0, MAX_CHANNELS)
    .map((c: any): WatchChannel => ({ handle: c.handle, ...(typeof c.channel_id === 'string' ? { channel_id: c.channel_id } : {}), ...(typeof c.uploads === 'string' ? { uploads: c.uploads } : {}) }));
  return { channels, seen: (Array.isArray(o.seen) ? o.seen : []).filter((s): s is string => typeof s === 'string') };
};

export async function watchChannels(ctx: WatchCtx): Promise<WatchSummary> {
  const sum: WatchSummary = { channels: 0, videos_checked: 0, repos_found: 0, added: 0, restored: 0, duplicates: 0, errors: 0, not_found: 0, cost_usd: 0 };
  const key = env('YOUTUBE_API_KEY');
  if (!key) return { ...sum, skipped: 'YOUTUBE_API_KEY is not set' };
  const cfg = asConfig(await ctx.config('watch'));
  sum.channels = cfg.channels.length;
  if (!cfg.channels.length) return sum;

  const messages: string[] = [];
  const done: string[] = [];
  let stocked = 0;
  let halted = false; // budget spent or cap reached: no more videos this run
  try {
    for (const ch of cfg.channels) {
      if (halted) break;
      try {
        if (!ch.channel_id || !ch.uploads) {
          const r = await api('channels', { part: 'id,contentDetails', forHandle: ch.handle, key });
          const item = r.items?.[0];
          const uploads = item?.contentDetails?.relatedPlaylists?.uploads;
          if (typeof item?.id !== 'string' || typeof uploads !== 'string') throw new Error(`no YouTube channel for ${ch.handle}`);
          ch.channel_id = item.id;
          ch.uploads = uploads;
        }
        const list = await api('playlistItems', { part: 'contentDetails,snippet', playlistId: ch.uploads!, maxResults: '5', key });
        for (const it of list.items ?? []) {
          if (halted) break;
          const id = it?.contentDetails?.videoId ?? it?.snippet?.resourceId?.videoId;
          const published = Date.parse(it?.contentDetails?.videoPublishedAt ?? it?.snippet?.publishedAt ?? '');
          if (typeof id !== 'string' || !Number.isFinite(published)) continue;
          const age = ctx.now.getTime() - published;
          if (age > WINDOW_MS || cfg.seen.includes(id) || done.includes(id)) continue;
          if (!(await ctx.budget())) {
            halted = true;
            sum.skipped = 'AI budget spent, will retry';
            break;
          }
          sum.videos_checked++;
          const title = String(it.snippet?.title ?? '');
          const channelTitle = String(it.snippet?.videoOwnerChannelTitle ?? it.snippet?.channelTitle ?? ch.handle);
          const commentText = await ownerComments(id, ch.channel_id!, key);
          const comments = watchRepoLinks(commentText);
          const repos = watchRepoLinks(`${commentText}\n${String(it.snippet?.description ?? '')}`);
          sum.repos_found += repos.length;
          const credit = { url: `https://www.youtube.com/watch?v=${id}`, title: `${title} · ${channelTitle}`.slice(0, 200) };
          let complete = true;
          for (const repo of repos) {
            if (stocked >= RUN_CAP || !(await ctx.budget())) {
              halted = true;
              complete = false;
              if (stocked < RUN_CAP) sum.skipped = 'AI budget spent, will retry';
              break;
            }
            stocked++;
            const r = await ctx.stock(repo, credit);
            sum.cost_usd += r.cost_usd ?? 0;
            if (r.status === 'added') sum.added++;
            else if (r.status === 'restored') sum.restored++;
            else if (r.status === 'duplicate') sum.duplicates++;
            else if (r.status === 'not_found') sum.not_found++;
            else {
              sum.errors++;
              complete = false;
              messages.push(`${repo}: could not be stocked`);
            }
          }
          // Creators often pin the list hours after uploading: a fresh video with no owner link yet is retried next run.
          if (complete && (comments.length > 0 || age > FRESH_MS)) done.push(id);
        }
      } catch (e) {
        sum.errors++;
        messages.push(`${ch.handle}: ${e instanceof Error ? e.message : e}`);
      }
    }
  } finally {
    const seen = [...cfg.seen, ...done].slice(-SEEN_MAX);
    try {
      await ctx.saveConfig('watch', { channels: cfg.channels, seen });
    } catch (e) {
      messages.push(`could not save the watch config: ${e instanceof Error ? e.message : e}`);
      sum.errors++;
    }
  }
  if (messages.length) sum.messages = messages;
  try {
    await ctx.logRun({ found: sum.repos_found, queued: sum.added + sum.restored, cost_usd: sum.cost_usd, error: messages.length ? messages.join('; ').slice(0, 500) : undefined });
  } catch (e) {
    console.warn('[watch] could not log the run', e);
  }
  return sum;
}
