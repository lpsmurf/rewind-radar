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
  busy: 'The store is too busy to check messages right now. Try again in a moment.',
  gone: 'That message is already gone.',
} as const;

// Small on purpose: slurs and obvious spam. The AI moderator handles everything subtler.
const BLOCKLIST = [
  'nigger', 'nigga', 'faggot', 'retard', 'kike', 'chink', 'spic', 'tranny', 'coon',
  'free money', 'crypto giveaway', 'airdrop', 'telegram', 'whatsapp', 'onlyfans', 'buy followers', 'click here', 'dm me',
];
const BLOCK_RE = new RegExp(`\\b(?:${BLOCKLIST.map((w) => w.replace(/\s+/g, '\\s+')).join('|')})\\b`, 'i');

const TLDS = 'com|net|org|io|dev|app|xyz|info|biz|co|me|ly|gg|tv|cc|ru|cn|tk|top|site|online|shop|club|link|click|live|ai|gl|to|sh|us|uk|de|fr|eu';
const BARE_DOMAIN = new RegExp(`[a-z0-9-]\\.(?:${TLDS})(?![a-z0-9])`, 'i');

function allowedUrl(u: URL): boolean {
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
  if (u.username || u.password || u.port) return false;
  const host = u.hostname.toLowerCase();
  if (host === 'github.com' || host === 'www.github.com') return true;
  return host === 'lpsmurf.github.io' && (u.pathname === '/rewind-radar' || u.pathname.startsWith('/rewind-radar/'));
}

/** True when every link-looking word points somewhere we allow. */
function linksOk(text: string): boolean {
  for (const raw of text.split(' ')) {
    const w = raw.replace(/^[("'<\[]+/, '').replace(/[)"'>\].,!?;:]+$/, '');
    if (!w || !(w.includes('://') || /^www\./i.test(w) || BARE_DOMAIN.test(w))) continue;
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
