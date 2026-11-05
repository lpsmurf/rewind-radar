import { DATA_RULE, HAIKU, sanitizeUntrusted, tool, webSearch } from '../ai.ts';
import { parseRepoRef } from '../github.ts';
import type { Candidate, Source } from './types.ts';

/**
 * Posts and articles found with Sonnet 5.5's web_search server tool, once per run. This is how X posts are found too:
 * the X API is paid and scraping X breaks its terms, so they only show up if web search returns them.
 * Sonnet writes a plain list; a cheap Haiku call turns it into structured items (a forced tool, which Sonnet 5.5 rejects).
 * Repos are never trusted: the pipeline verifies each one on GitHub.
 */
const MAX_USES = 5;
const norm = (u: string) => u.trim().replace(/#.*$/, '').replace(/\/+$/, '');

export const webSource: Source = {
  name: 'web',
  async run(ctx) {
    const cfg = (await ctx.config('web')) as { query?: unknown } | null;
    const query = typeof cfg?.query === 'string' ? cfg.query.trim() : '';
    if (!query) return [];
    if (!(await ctx.budget())) return [];

    const { text, results } = await webSearch({
      maxUses: MAX_USES,
      effort: 'low',
      onUsage: ctx.onUsage,
      system: `You research what the Claude Code community recommends. ${DATA_RULE}`,
      user: `Search the web for this week's posts and articles recommending Claude Code skills or GitHub repos. Topic: ${query}
Answer with one line per repo, in the form: owner/repo | URL of the post or article where it was recommended | one-line why. Only list repos a post or article actually names.`,
    });
    if (!text || !(await ctx.budget())) return [];

    const out = await tool<{ items?: unknown }>({
      model: HAIKU,
      name: 'list_repos',
      maxTokens: 1500,
      onUsage: ctx.onUsage,
      system: `You turn a research note into structured data. ${DATA_RULE}
List each GitHub repo or Claude Code skill the note recommends as owner/repo, the URL of the post or article that recommended it (copied exactly from the note), and a one-line why. Never invent a repo or a URL.`,
      user: `<data>\n${sanitizeUntrusted(text, 8000)}\n</data>`,
      schema: {
        type: 'object',
        properties: {
          items: {
            type: 'array',
            items: {
              type: 'object',
              properties: { repo: { type: 'string' }, url: { type: 'string' }, why: { type: 'string' } },
              required: ['repo', 'url', 'why'],
            },
          },
        },
        required: ['items'],
      },
    });

    const byUrl = new Map(results.map((r) => [norm(r.url), r]));
    const cands: Candidate[] = [];
    for (const i of Array.isArray(out.items) ? (out.items as any[]) : []) {
      const ref = i && typeof i.repo === 'string' ? parseRepoRef(i.repo) : null;
      if (!ref) continue;
      const c: Candidate = { repo: ref.full, kind: 'repo' };
      if (typeof i.why === 'string' && i.why) c.why = i.why;
      // A URL the search never returned is the model's word only: keep the repo, drop the credit.
      const hit = typeof i.url === 'string' ? byUrl.get(norm(i.url)) : undefined;
      if (hit) {
        c.credit_url = hit.url;
        c.credit_title = hit.title;
      }
      cands.push(c);
    }
    return cands;
  },
};
