import { describe, expect, it } from 'vitest';
import { isTypingTarget, itemKey, itemStars, itemTitle, neighbourWindow, shortTitle, stepIndex, positionLabel, type BrowseItem } from '../src/ui/releasesNav.ts';
import { tapeFixture } from './helpers/tapes.ts';

describe('stepIndex (wraps around)', () => {
  it('moves by one and wraps at both ends', () => {
    expect(stepIndex(0, 5, 1)).toBe(1);
    expect(stepIndex(4, 5, 1)).toBe(0);
    expect(stepIndex(0, 5, -1)).toBe(4);
    expect(stepIndex(2, 5, -1)).toBe(1);
  });
  it('handles empty and single lists and big steps', () => {
    expect(stepIndex(0, 0, 1)).toBe(0);
    expect(stepIndex(0, 1, -1)).toBe(0);
    expect(stepIndex(1, 5, -7)).toBe(4);
  });
});

describe('neighbourWindow', () => {
  it('takes `per` neighbours each side, left far-to-near, right near-to-far', () => {
    expect(neighbourWindow(20, 5, 3)).toEqual({ left: [2, 3, 4], right: [6, 7, 8] });
  });
  it('wraps around the ends', () => {
    expect(neighbourWindow(20, 0, 2)).toEqual({ left: [18, 19], right: [1, 2] });
    expect(neighbourWindow(20, 19, 2)).toEqual({ left: [17, 18], right: [0, 1] });
  });
  it('never shows the same release twice in a short list, and never the selected one', () => {
    for (let n = 0; n <= 8; n++) for (let i = 0; i < Math.max(n, 1); i++) {
      const w = neighbourWindow(n, i, 3);
      const all = [...w.left, ...w.right];
      expect(new Set(all).size).toBe(all.length);
      expect(all).not.toContain(i);
      expect(all.length).toBe(Math.min(n - 1, 6) < 0 ? 0 : Math.min(Math.max(n - 1, 0), 6));
    }
    expect(neighbourWindow(3, 0, 3)).toEqual({ left: [2], right: [1] });
    expect(neighbourWindow(2, 0, 3)).toEqual({ left: [], right: [1] }); // the one neighbour is on the right: never the same tape both sides
    expect(neighbourWindow(2, 1, 3)).toEqual({ left: [], right: [0] });
    expect(neighbourWindow(4, 0, 3)).toEqual({ left: [3], right: [1, 2] });
    expect(neighbourWindow(1, 0, 3)).toEqual({ left: [], right: [] });
  });
});

describe('positionLabel', () => {
  it('is one-based', () => {
    expect(positionLabel(2, 20)).toBe('3 / 20');
    expect(positionLabel(0, 0)).toBe('0 / 0');
  });
});

describe('browse items: a store tape or a light GitHub repo', () => {
  const tape = tapeFixture({ id: 'a', kind: 'repo', title: 'acme/widget-kit', stars: 12400 });
  const gh: BrowseItem = { kind: 'github', full_name: 'foo/bar-baz', html_url: 'https://github.com/foo/bar-baz', description: null, stars: 999, language: 'Go', license: 'MIT', why: 'fits you' };
  it('keys, titles and stars come from either shape', () => {
    expect(itemKey(tape)).toBe('a');
    expect(itemKey(gh)).toBe('gh:foo/bar-baz');
    expect(itemTitle(tape)).toBe('acme/widget-kit');
    expect(itemTitle(gh)).toBe('foo/bar-baz');
    expect(itemStars(tape)).toBe(12400);
    expect(itemStars(gh)).toBe(999);
    expect(itemStars(tapeFixture({ kind: 'skill', stars: 50 }))).toBeNull();
  });
  it('shortTitle drops the owner and truncates with a dot', () => {
    expect(shortTitle(tape, 20)).toBe('widget-kit');
    expect(shortTitle(gh, 5)).toBe('bar-.');
  });
});

describe('isTypingTarget (the browser keys must not eat typing)', () => {
  const el = (typing: boolean) => ({ closest: (sel: string) => (typing && sel.includes('input') ? {} : null) }) as unknown as EventTarget;
  it('is true inside a field and false elsewhere', () => {
    expect(isTypingTarget(el(true))).toBe(true);
    expect(isTypingTarget(el(false))).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
    expect(isTypingTarget({} as EventTarget)).toBe(false);
  });
});
