import { beforeEach, vi } from 'vitest';
import { clearRepoExistsCache } from '../lib/github.ts';

// No test may reach the network: GitHub and Anthropic calls must be stubbed explicitly.
beforeEach(() => {
  clearRepoExistsCache();
  vi.stubGlobal('fetch', async (url: unknown) => {
    throw new Error(`unmocked fetch: ${String(url)}`);
  });
});
