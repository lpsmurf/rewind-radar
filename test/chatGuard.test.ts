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
    ]) expect(checkMessage(t), t).toMatchObject({ ok: false, reason: CHAT_LINES.link });
  });

  it('does not mistake dotted words for links', () => {
    expect(checkMessage('i love node.js and e.g. python')).toMatchObject({ ok: true });
    expect(checkMessage('version 1.2.3 is out')).toMatchObject({ ok: true });
  });

  it('blocks blocklisted words, case-insensitively and on word boundaries', () => {
    expect(checkMessage('you are a RETARD')).toMatchObject({ ok: false, reason: CHAT_LINES.blocked });
    expect(checkMessage('free   money inside')).toMatchObject({ ok: false, reason: CHAT_LINES.blocked });
    expect(checkMessage('Join my Telegram')).toMatchObject({ ok: false, reason: CHAT_LINES.blocked });
    // not inside a longer word
    expect(checkMessage('the Scunthorpe classic, retarded growth rate no, "retardant" fine')).toMatchObject({ ok: true });
  });
});
