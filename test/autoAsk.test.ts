import { describe, expect, it } from 'vitest';
import { autoAskAction } from '../src/ui/autoAsk.ts';

describe('autoAskAction (a question handed to the drawer is sent once)', () => {
  it('sends a new question when the clerk is free', () => {
    expect(autoAskAction({ q: 'https://github.com/o/r', n: 1 }, 0, false)).toBe('send');
  });
  it('waits while the clerk is busy, without consuming it', () => {
    expect(autoAskAction({ q: 'x', n: 1 }, 0, true)).toBe('wait');
  });
  it('skips one already sent, or none', () => {
    expect(autoAskAction({ q: 'x', n: 1 }, 1, false)).toBe('skip');
    expect(autoAskAction(null, 0, false)).toBe('skip');
  });
  it('sends a repeat of the same URL when it has a new number', () => {
    expect(autoAskAction({ q: 'x', n: 2 }, 1, false)).toBe('send');
  });
});
