import { describe, expect, it } from 'vitest';
import { activeBubble, deletedId, bubbleLines, BUBBLE_MS, chatName, BUBBLE_COLS, CHAT_KEEP, mergeChat, removeChat, wrapBubble, type ChatEntry, type ChatMsg } from '../src/store/chat.ts';

const msg = (id: number, over: Partial<ChatMsg> = {}): ChatMsg => ({ id, at: '2026-11-05T10:00:00Z', sender_key: 'a~1', login: 'octo', tier: 'light', body: `m${id}`, ...over });
const entry = (id: number, seen = 0, over: Partial<ChatMsg> = {}): ChatEntry => ({ ...msg(id, over), seen });

describe('mergeChat', () => {
  it('adds new messages in id order and stamps when they arrived', () => {
    const out = mergeChat([entry(1)], [msg(3), msg(2)], 500);
    expect(out.map((m) => [m.id, m.seen])).toEqual([[1, 0], [2, 500], [3, 500]]);
  });
  it('dedupes by id and keeps the first arrival time (own post plus realtime echo)', () => {
    const once = mergeChat([], [msg(1)], 100);
    const twice = mergeChat(once, [msg(1)], 900);
    expect(twice).toHaveLength(1);
    expect(twice[0].seen).toBe(100);
  });
  it('keeps only the newest 50', () => {
    const out = mergeChat([], Array.from({ length: 60 }, (_, i) => msg(i + 1)), 0);
    expect(out).toHaveLength(CHAT_KEEP);
    expect(out[0].id).toBe(11);
    expect(out.at(-1)!.id).toBe(60);
  });
  it('does not mutate its input', () => {
    const base = [entry(1)];
    mergeChat(base, [msg(2)], 1);
    expect(base).toHaveLength(1);
  });
});

describe('removeChat', () => {
  it('drops a hidden message and ignores unknown ids', () => {
    const list = [entry(1), entry(2)];
    expect(removeChat(list, 1).map((m) => m.id)).toEqual([2]);
    expect(removeChat(list, 9)).toEqual(list);
  });
});

describe('activeBubble', () => {
  const list = [entry(1, 1000, { sender_key: 'a~1' }), entry(2, 2000, { sender_key: 'b~1' }), entry(3, 3000, { sender_key: 'a~1' })];
  it('returns the sender\'s latest fresh message', () => {
    expect(activeBubble(list, 'a~1', 3500)?.id).toBe(3);
    expect(activeBubble(list, 'b~1', 3500)?.id).toBe(2);
  });
  it('expires after about 6 seconds', () => {
    expect(BUBBLE_MS).toBe(6000);
    expect(activeBubble(list, 'a~1', 3000 + BUBBLE_MS - 1)?.id).toBe(3);
    expect(activeBubble(list, 'a~1', 3000 + BUBBLE_MS)).toBeUndefined();
  });
  it('never bubbles history loaded at page start (seen 0) or other senders', () => {
    expect(activeBubble([entry(1, 0)], 'a~1', 10)).toBeUndefined();
    expect(activeBubble(list, 'zzz', 3500)).toBeUndefined();
  });
  it('a newer message from the same sender replaces the older bubble even if the older is fresh', () => {
    expect(activeBubble([entry(1, 5000), entry(2, 5100)], 'a~1', 5200)?.id).toBe(2);
  });
});

describe('wrapBubble', () => {
  it('wraps on spaces within the width', () => {
    expect(wrapBubble('hello brave new world', 11)).toEqual(['hello brave', 'new world']);
  });
  it('splits a word longer than the width', () => {
    expect(wrapBubble('abcdefghijkl', 5)).toEqual(['abcde', 'fghij', 'kl']);
  });
  it('caps the lines and marks the cut', () => {
    const out = wrapBubble('one two three four five six seven eight', 7, 2);
    expect(out).toHaveLength(2);
    expect(out[1].endsWith('..')).toBe(true);
    expect(out.every((l) => l.length <= 7)).toBe(true);
  });
});

describe('chatName and bubbleLines (a light name must not pass as verified)', () => {
  it('marks members with a check and light visitors as unverified', () => {
    expect(chatName('octo', 'member')).toBe('octo ✓');
    expect(chatName('octo', 'light')).toBe('@octo (unverified)');
    expect(chatName('octo', 'anything-else')).toBe('@octo (unverified)');
  });
  it('puts the name first in the bubble, then the wrapped text, within the width', () => {
    const lines = bubbleLines(entry(1, 1, { login: 'octocat', tier: 'light', body: 'hello there everyone, how are you today' }));
    expect(lines[0]).toBe('@octocat (unverified)');
    expect(lines.slice(1).join(' ')).toContain('hello there');
    expect(lines.length).toBeLessThanOrEqual(4);
    expect(lines.every((l) => l.length <= BUBBLE_COLS)).toBe(true);
  });
  it('shortens a very long name', () => {
    expect(bubbleLines(entry(1, 1, { login: 'a'.repeat(39), tier: 'light' }))[0].length).toBeLessThanOrEqual(BUBBLE_COLS);
  });
});

describe('deletedId (Realtime DELETE events)', () => {
  it('reads the primary key, so the message and its bubble can go', () => {
    expect(deletedId({ old: { id: 7 } })).toBe(7);
    const list = [entry(7, 1000), entry(8, 1000)];
    expect(activeBubble(removeChat(list, deletedId({ old: { id: 7 } })!), 'a~1', 1500)?.id).toBe(8);
  });
  it('ignores anything else', () => {
    for (const p of [null, undefined, {}, { old: {} }, { old: { id: '7' } }, { old: { id: 1.5 } }]) expect(deletedId(p as any)).toBeNull();
  });
});
