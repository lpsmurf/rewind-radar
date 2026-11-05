// Pure helpers for visitor chat. No React, no DOM: the hook, the canvas and the tests share them.

/** A chat row as the API and Realtime return it. */
export interface ChatMsg { id: number; at: string; sender_key: string; login: string; tier: string; body: string }
/** `seen` is the local time (ms) it reached this browser, or 0 for history loaded at page start (so it never pops a bubble). */
export type ChatEntry = ChatMsg & { seen: number };

export const CHAT_KEEP = 50;
export const BUBBLE_MS = 6000;

/** Add messages (deduped by id, the first arrival wins), oldest first, newest 50 kept. Returns a new list. */
export function mergeChat(list: ChatEntry[], incoming: ChatMsg[], now: number): ChatEntry[] {
  const byId = new Map(list.map((m) => [m.id, m]));
  for (const m of incoming) if (!byId.has(m.id)) byId.set(m.id, { ...m, seen: now });
  return [...byId.values()].sort((a, b) => a.id - b.id).slice(-CHAT_KEEP);
}

export function removeChat(list: ChatEntry[], id: number): ChatEntry[] {
  return list.some((m) => m.id === id) ? list.filter((m) => m.id !== id) : list;
}

/** The message to draw above a character: that sender's latest, if it arrived less than BUBBLE_MS ago. */
export function activeBubble(list: ChatEntry[], senderKey: string, now: number, ttl = BUBBLE_MS): ChatEntry | undefined {
  let last: ChatEntry | undefined;
  for (const m of list) if (m.sender_key === senderKey && (!last || m.id > last.id)) last = m;
  return last && last.seen > 0 && now - last.seen < ttl ? last : undefined;
}

/** Break text into lines of at most `width` characters (long words are split); past `maxLines` the last line ends in "..". */
export function wrapBubble(text: string, width: number, maxLines = 4): string[] {
  const lines: string[] = [];
  let cur = '';
  for (let word of text.split(/\s+/).filter(Boolean)) {
    while (word.length > width) {
      if (cur) { lines.push(cur); cur = ''; }
      lines.push(word.slice(0, width));
      word = word.slice(width);
    }
    if (!cur) cur = word;
    else if (cur.length + 1 + word.length <= width) cur += ' ' + word;
    else { lines.push(cur); cur = word; }
  }
  if (cur) lines.push(cur);
  if (lines.length <= maxLines) return lines;
  const out = lines.slice(0, maxLines);
  out[maxLines - 1] = out[maxLines - 1].slice(0, width - 2).trimEnd() + '..';
  return out;
}
