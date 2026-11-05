import type { Source } from './types.ts';
import { webSource } from './web.ts';
import { youtubeSource } from './youtube.ts';

/**
 * The sources a scheduled `/sources/run` executes, in order. REGISTER NEW SOURCES HERE and add the file to
 * scripts/sync-edge.sh. 'manual' is not listed: the admin paste box runs it on demand.
 */
export const SOURCES: Source[] = [youtubeSource, webSource];
