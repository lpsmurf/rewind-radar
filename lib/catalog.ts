import { admin } from './admin.ts';
import type { RepoHit } from './github.ts';

export interface CatalogRow { slug: string; title: string; genre: string; blurb: string; kind: string; match?: boolean }

/** Tapes worth showing the clerk: text matches first (match=true), topped up with popular and new ones. */
export async function candidates(q: string, n = 30): Promise<CatalogRow[]> {
  const { data, error } = await admin().rpc('search_tapes', { q, n });
  if (!error) return (data ?? []) as CatalogRow[];
  // search_tapes missing (migration 003 not applied yet): fall back to the live catalog.
  const live = await admin().from('tapes').select('slug,title,genre,blurb,kind').eq('archived', false).limit(400);
  return ((live.data ?? []) as CatalogRow[]).map((r) => ({ ...r, match: false }));
}

/** The store slug a GitHub repo would have, either as a stocked (gh-) or a community (c-) tape. */
export const tapeSlugs = (full: string) => ['gh', 'c'].map((p) => `${p}-${full.replace('/', '-')}`.toLowerCase());

/** The hits already on a store shelf (live or archived): the store tape wins, so they are not offered again. Never throws. */
export async function inStore(hits: RepoHit[]): Promise<Set<string>> {
  if (!hits.length) return new Set();
  try {
    const { data, error } = await admin().from('tapes').select('slug').in('slug', hits.flatMap((h) => tapeSlugs(h.full_name)));
    if (error) throw error;
    const have = new Set(((Array.isArray(data) ? data : []) as { slug: string }[]).map((r) => r.slug));
    return new Set(hits.filter((h) => tapeSlugs(h.full_name).some((s) => have.has(s))).map((h) => h.full_name.toLowerCase()));
  } catch (e) {
    console.warn('[catalog] could not check the store for GitHub hits', e);
    return new Set();
  }
}
