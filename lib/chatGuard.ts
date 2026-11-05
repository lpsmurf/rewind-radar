import { sanitizeUntrusted } from './ai.ts';

/** Free, instant checks on a chat message, run before any AI moderation. Pure: no network, no database. */
export const CHAT_MAX = 140;

export const CHAT_LINES = {
  gate: 'Connect your GitHub to chat. You can still walk around and watch.',
  empty: 'Say something first.',
  long: `Keep it to ${CHAT_MAX} characters.`,
  letters: 'Use some words, not just numbers or symbols.',
  link: 'Links are limited to github.com and this store.',
  blocked: "That one can't be posted here.",
  moderated: "That one can't be posted here. Keep it friendly.",
  slow: 'Easy, one message every couple of seconds.',
  limit: "You've said a lot. Try again in a while.",
  resting: 'The store chat is resting. Come back a little later.',
  busy: 'The store is too busy to check messages right now. Try again in a moment.',
  gone: 'That message is already gone.',
} as const;

// Small on purpose: slurs and obvious spam. The AI moderator handles everything subtler.
const BLOCKLIST = [
  'nigger', 'nigga', 'faggot', 'retard', 'kike', 'chink', 'spic', 'tranny', 'coon',
  'free money', 'crypto giveaway', 'airdrop', 'telegram', 'whatsapp', 'onlyfans', 'buy followers', 'click here', 'dm me',
];
const BLOCK_RE = new RegExp(`\\b(?:${BLOCKLIST.map((w) => w.replace(/\s+/g, '\\s+')).join('|')})\\b`, 'i');

// Anything shaped like word.word (an ending of 2+ letters, any TLD), a www. or scheme link, or a bare IPv4 is a link.
const LABEL_DOT_LABEL = /[\p{L}\p{N}-]\.\p{L}{2,}(?![\p{L}\p{N}-])/u;
const IPV4 = /\d+\.\d+\.\d+\.\d+/;
// Dots that fold to "." for the link check: ideographic and halfwidth full stops, small full stop, one-dot leader, hyphenation point.
const UNICODE_DOTS = /[\u3002\uFF0E\uFF61\uFE52\u2024\u2027\u0701\u0702]/g;

function allowedUrl(u: URL): boolean {
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
  if (u.username || u.password || u.port) return false;
  const host = u.hostname.toLowerCase().replace(/\.$/, '');
  if (host === 'github.com' || host.endsWith('.github.com')) return true; // github.com and its subdomains (gist.github.com)
  return host === 'lpsmurf.github.io' && (u.pathname === '/rewind-radar' || u.pathname.startsWith('/rewind-radar/'));
}

/** True when every link-looking word points somewhere we allow. Looks at the NFKC-normalised text, so look-alike dots and letters cannot hide a link. */
function linksOk(text: string): boolean {
  for (const raw of text.normalize('NFKC').replace(UNICODE_DOTS, '.').split(' ')) {
    const w = raw.replace(/^[("'<\[]+/, '').replace(/[)"'>\].,!?;:]+$/, '');
    if (!w || !(w.includes('://') || /^www\./i.test(w) || LABEL_DOT_LABEL.test(w) || IPV4.test(w))) continue;
    try {
      if (!allowedUrl(new URL(w.includes('://') ? w : `https://${w}`))) return false;
    } catch {
      return false;
    }
  }
  return true;
}

export function checkMessage(input: string): { ok: boolean; reason?: string; text: string } {
  const text = sanitizeUntrusted(String(input ?? ''), 4000).replace(/\s+/g, ' ').trim();
  const no = (reason: string) => ({ ok: false, reason, text });
  if (!text) return no(CHAT_LINES.empty);
  if (text.length > CHAT_MAX) return no(CHAT_LINES.long);
  if (!/\p{L}/u.test(text)) return no(CHAT_LINES.letters);
  if (!linksOk(text)) return no(CHAT_LINES.link);
  if (BLOCK_RE.test(text)) return no(CHAT_LINES.blocked);
  return { ok: true, text };
}
