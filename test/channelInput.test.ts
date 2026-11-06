import { describe, expect, it } from 'vitest';
import { parseChannelInput } from '../lib/sources/config.ts';

const UC = 'UC' + 'a'.repeat(22);

describe('parseChannelInput', () => {
  it('reads @handle and a bare handle', () => {
    expect(parseChannelInput('@TheNextNewThingAI')).toEqual({ handle: '@TheNextNewThingAI' });
    expect(parseChannelInput('  @a.b-c_d  ')).toEqual({ handle: '@a.b-c_d' });
    expect(parseChannelInput('TheNextNewThingAI')).toEqual({ handle: '@TheNextNewThingAI' });
    expect(parseChannelInput('abc')).toEqual({ handle: '@abc' });
  });
  it('reads handle URLs in every common shape', () => {
    for (const u of [
      'https://www.youtube.com/@TheNextNewThingAI',
      'http://youtube.com/@TheNextNewThingAI',
      'youtube.com/@TheNextNewThingAI/videos',
      'www.youtube.com/@TheNextNewThingAI/',
      'm.youtube.com/@TheNextNewThingAI',
      'https://m.youtube.com/@TheNextNewThingAI?si=abc123',
      'https://www.youtube.com/@TheNextNewThingAI/videos?view=0&sort=dd#x',
      'HTTPS://WWW.YOUTUBE.COM/@TheNextNewThingAI',
      'https://www.youtube.com/%40TheNextNewThingAI',
    ]) expect(parseChannelInput(u), u).toEqual({ handle: '@TheNextNewThingAI' });
  });
  it('reads a channel id, bare or in a /channel/ URL', () => {
    expect(parseChannelInput(UC)).toEqual({ channel_id: UC });
    expect(parseChannelInput('UC_-' + 'a'.repeat(20))).toEqual({ channel_id: 'UC_-' + 'a'.repeat(20) });
    expect(parseChannelInput(`https://www.youtube.com/channel/${UC}`)).toEqual({ channel_id: UC });
    expect(parseChannelInput(`youtube.com/channel/${UC}/videos?x=1`)).toEqual({ channel_id: UC });
    expect(parseChannelInput(`https://m.youtube.com/channel/${UC}`)).toEqual({ channel_id: UC });
  });
  it('rejects everything else', () => {
    for (const bad of [
      '',
      '   ',
      'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      'https://youtu.be/dQw4w9WgXcQ',
      'https://www.youtube.com/c/SomeName',
      'https://www.youtube.com/user/SomeName',
      'https://www.youtube.com/playlist?list=PL123',
      'https://www.youtube.com/',
      'https://www.youtube.com/channel/UCshort',
      'https://example.com/@handle',
      'https://notyoutube.com/@handle',
      'youtube.com',
      'random text here',
      '@ab',
      'ab',
      '@' + 'a'.repeat(31),
      'a'.repeat(31),
      '@a/b',
      '@has space',
      `${UC}x`.repeat(2),
    ]) expect(parseChannelInput(bad), bad).toBeNull();
  });
  it('rejects non-strings', () => {
    expect(parseChannelInput(5 as any)).toBeNull();
    expect(parseChannelInput(null as any)).toBeNull();
  });
});
