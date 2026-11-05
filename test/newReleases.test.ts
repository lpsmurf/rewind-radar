import { describe, expect, it } from 'vitest';
import { aisleOf, latestWeek } from '../src/types.ts';

const t = (kind: string, week?: string | null, genre = 'Design') => ({ kind, genre, week }) as any;

describe('latestWeek', () => {
  it('is the newest week among repo tapes only', () => {
    expect(latestWeek([t('repo', '2026-10-26'), t('repo', '2026-11-02'), t('skill', '2026-12-07'), t('community', '2026-12-14')])).toBe('2026-11-02');
  });
  it('is null when no repo tape has a week', () => {
    expect(latestWeek([])).toBeNull();
    expect(latestWeek([t('repo', null), t('repo'), t('skill', '2026-11-02')])).toBeNull();
  });
});

describe('aisleOf with the current New Releases week', () => {
  it('keeps repo tapes of the latest week on the New Releases shelf', () => {
    expect(aisleOf(t('repo', '2026-11-02'), '2026-11-02')).toBe('new');
  });
  it('sends older repo tapes to their genre aisle, so they stay browsable but leave the shelf', () => {
    expect(aisleOf(t('repo', '2026-10-26', 'Dev Workflow'), '2026-11-02')).toBe('Dev Workflow');
  });
  it('treats a repo tape with no week as current, and behaves as before without a week argument', () => {
    expect(aisleOf(t('repo', null), '2026-11-02')).toBe('new');
    expect(aisleOf(t('repo', '2020-01-06'))).toBe('new');
    expect(aisleOf(t('community', '2020-01-06'), '2026-11-02')).toBe('community');
    expect(aisleOf(t('skill', '2020-01-06', 'Media'), '2026-11-02')).toBe('Media');
  });
});
