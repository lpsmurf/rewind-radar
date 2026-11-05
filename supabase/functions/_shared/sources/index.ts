import type { Source } from './types.ts';

/**
 * The sources a scheduled `/sources/run` executes, in order. REGISTER NEW SOURCES HERE:
 *   import { youtubeSource } from './youtube.ts';  ...  export const SOURCES: Source[] = [youtubeSource, webSource];
 * (and add the file to scripts/sync-edge.sh). 'manual' is not listed: the admin paste box runs it on demand.
 */
export const SOURCES: Source[] = [];
