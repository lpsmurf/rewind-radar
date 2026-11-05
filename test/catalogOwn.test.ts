import { describe, expect, it } from 'vitest';
import { dropOwn, ownSlugs } from '../lib/catalog.ts';

describe('ownSlugs / dropOwn (a visitor is never recommended their own repos)', () => {
  const facets = { owner: 'LpSmurf', repos: [{ name: 'Rewind-Radar', language: null, topics: [] }, { name: 'x', language: null, topics: [] }] };
  it('covers the stocked (gh-) and community (c-) slugs of every repo, lowercased', () => {
    expect([...ownSlugs(facets)].sort()).toEqual(['c-lpsmurf-rewind-radar', 'c-lpsmurf-x', 'gh-lpsmurf-rewind-radar', 'gh-lpsmurf-x']);
  });
  it('drops matching rows and keeps the rest, including look-alike owners', () => {
    const rows = [{ slug: 'gh-lpsmurf-x' }, { slug: 'c-lpsmurf-rewind-radar' }, { slug: 'gh-lpsmurf-x-other-y' }, { slug: 'gh-acme-new' }, { slug: 'some-skill' }];
    expect(dropOwn(rows, ownSlugs(facets)).map((r) => r.slug)).toEqual(['gh-lpsmurf-x-other-y', 'gh-acme-new', 'some-skill']);
  });
});
