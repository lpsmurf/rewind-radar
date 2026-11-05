import { describe, expect, it } from 'vitest';
import { checkMessage, CHAT_LINES, CHAT_MAX } from '../lib/chatGuard.ts';

describe('checkMessage', () => {
  it('accepts ordinary banter and returns the cleaned text', () => {
    expect(checkMessage('hello  there,\n\n friend!  ')).toEqual({ ok: true, text: 'hello there, friend!' });
  });

  it('rejects empty and whitespace-only text', () => {
    expect(checkMessage('')).toMatchObject({ ok: false, reason: CHAT_LINES.empty });
    expect(checkMessage('   \n\t ')).toMatchObject({ ok: false, reason: CHAT_LINES.empty });
  });

  it('enforces 140 characters after cleaning', () => {
    expect(checkMessage('a'.repeat(CHAT_MAX)).ok).toBe(true);
    expect(checkMessage('a'.repeat(CHAT_MAX + 1))).toMatchObject({ ok: false, reason: CHAT_LINES.long });
    // collapsing whitespace happens first, so padding does not count
    expect(checkMessage('hi' + ' '.repeat(300) + 'there').ok).toBe(true);
  });

  it('requires letters', () => {
    expect(checkMessage('12345 !!! ???')).toMatchObject({ ok: false, reason: CHAT_LINES.letters });
    expect(checkMessage('ça va 42')).toMatchObject({ ok: true });
  });

  it('strips invisible and bidi characters', () => {
    expect(checkMessage('he​llo‮ wor﻿ld')).toEqual({ ok: true, text: 'hello world' });
    expect(checkMessage('​‌‮')).toMatchObject({ ok: false, reason: CHAT_LINES.empty });
  });

  it('allows links to github.com and the store only', () => {
    for (const t of [
      'see https://github.com/lpsmurf/rewind-radar',
      'try github.com/anthropics/claude-code!',
      'here (https://www.github.com/a/b).',
      'store: https://lpsmurf.github.io/rewind-radar/',
      'lpsmurf.github.io/rewind-radar',
      'https://github.com/a/b',
      'a gist: https://gist.github.com/someone/123',
    ]) expect(checkMessage(t), t).toMatchObject({ ok: true });
  });

  it('rejects every other link', () => {
    for (const t of [
      'https://evil.example/x',
      'go to bit.ly/abc',
      'www.shady.com',
      'http://github.com.evil.io/a',
      'https://github.com@evil.io/a',
      'https://lpsmurf.github.io/other-project',
      'https://notgithub.com/a',
      'ftp://github.com/a',
      'javascript://github.com/%0aalert(1)',
      'visit EXAMPLE.COM now',
      'evil。com', 'evil．com', 'evil｡com', 'evil\u2024com', // unicode dots
      'x.zip', 'foo.cloud', 'drop.xyz/free', 'a.b.sh', 'at 1.2.3.4 now',
      'github.com.evil.com', 'github.com@evil.com', 'https://github.com@evil.com/x',
      'https://ｅvil.com', // fullwidth letters fold to ascii
    ]) expect(checkMessage(t), t).toMatchObject({ ok: false, reason: CHAT_LINES.link });
  });

  it('does not mistake numbers and one-letter dots for links', () => {
    expect(checkMessage('version 1.2.3 is out, e.g. today')).toMatchObject({ ok: true });
    expect(checkMessage('price is 3.50 or so')).toMatchObject({ ok: true });
  });

  // Flipped on purpose: "i love node.js" used to pass. Any label.label with a 2+ letter ending now counts as a link,
  // because a TLD list can never keep up (.zip, .cloud, .sh, .ai ...). The cost is that bare file names like node.js are refused.
  it('treats any word.word as a link, whatever its ending', () => {
    expect(checkMessage('i love node.js')).toMatchObject({ ok: false, reason: CHAT_LINES.link });
    expect(checkMessage('hello.world')).toMatchObject({ ok: false, reason: CHAT_LINES.link });
  });

  it('blocks blocklisted words, case-insensitively and on word boundaries', () => {
    expect(checkMessage('you are a RETARD')).toMatchObject({ ok: false, reason: CHAT_LINES.blocked });
    expect(checkMessage('free   money inside')).toMatchObject({ ok: false, reason: CHAT_LINES.blocked });
    expect(checkMessage('Join my Telegram')).toMatchObject({ ok: false, reason: CHAT_LINES.blocked });
    // not inside a longer word
    expect(checkMessage('the Scunthorpe classic, retarded growth rate no, "retardant" fine')).toMatchObject({ ok: true });
  });
});
