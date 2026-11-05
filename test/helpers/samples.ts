/** Shared test data. Kept out of *.test.ts files so importing it never re-registers another file's tests. */
import type { RepoFacts } from '../../lib/github.ts';

export const facts = (o: Partial<RepoFacts> = {}): RepoFacts => ({
  full_name: 'a/b',
  html_url: 'https://github.com/a/b',
  description: 'demo',
  stars: 1200,
  forks: 30,
  license: 'MIT',
  language: 'TypeScript',
  topics: [],
  pushed_at: '2026-11-01T00:00:00Z',
  created_at: '2026-01-01T00:00:00Z',
  archived: false,
  open_issues: 12,
  contents: [],
  readme: '',
  ...o,
});

export const SAMPLE = {
  title: 'Postiz',
  what: 'An open-source social media scheduler.',
  ring: 'trial',
  confidence: 0.7,
  plain: 'Worth a weekend if you post to many networks.',
  benefits: ['self-hostable'],
  risks: ['AGPL'],
  gates: {
    licence: { ok: false, note: 'AGPL-3.0' },
    maintenance: { ok: true, note: 'pushed this week' },
    security: { ok: true, note: 'no red flags' },
    cost: { ok: true, note: 'free to self-host' },
    lockin: { ok: true, note: 'open source' },
  },
  effort: 'M',
  overlaps: [{ slug: 'diagram-design', why: 'pairs for posts' }],
  steps: ['docker compose up -d'],
  evidence: ['40,964 stars'],
  ai_directed_text: true,
};
