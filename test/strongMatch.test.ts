import { describe, expect, it } from 'vitest';
import { strongMatch } from '../lib/catalog.ts';

const row = (title: string, blurb = '', match = true) => ({ title, blurb, genre: 'Dev Workflow', match });

describe('strongMatch', () => {
  it('needs half the keywords (at least one) on word stems', () => {
    const terms = ['rust', 'terminal', 'user', 'interfaces'];
    expect(strongMatch(row('User Research', 'interview users'), terms)).toBe(false);
    expect(strongMatch(row('Ratatui', 'Rust crate for terminal user interfaces'), terms)).toBe(true);
    expect(strongMatch(row('TUI kit', 'build a terminal interface'), terms)).toBe(true); // "interfaces" ~ "interface"
  });
  it('one keyword is enough for a one- or two-word question', () => {
    expect(strongMatch(row('Rag 0', 'rag'), ['rag', 'pipelines'])).toBe(true);
    expect(strongMatch(row('Diagram Design', 'diagrams as SVG'), ['diagrams'])).toBe(true);
  });
  it('is never strong without a text match or keywords', () => {
    expect(strongMatch(row('Ratatui', 'rust terminal', false), ['rust'])).toBe(false);
    expect(strongMatch(row('Ratatui', 'rust terminal'), [])).toBe(false);
  });
});
