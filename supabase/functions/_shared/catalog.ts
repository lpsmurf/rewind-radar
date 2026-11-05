import { admin } from './admin.ts';

export interface CatalogRow { slug: string; title: string; genre: string; blurb: string; kind: string; match?: boolean }

/** Tapes worth showing the clerk: text matches first (match=true), topped up with popular and new ones. */
export async function candidates(q: string, n = 30): Promise<CatalogRow[]> {
  const { data, error } = await admin().rpc('search_tapes', { q, n });
  if (!error) return (data ?? []) as CatalogRow[];
  // search_tapes missing (migration 003 not applied yet): fall back to the live catalog.
  const live = await admin().from('tapes').select('slug,title,genre,blurb,kind').eq('archived', false).limit(400);
  return ((live.data ?? []) as CatalogRow[]).map((r) => ({ ...r, match: false }));
}
