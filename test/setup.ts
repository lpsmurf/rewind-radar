import { beforeEach, vi } from 'vitest';

// No test may reach the network: GitHub and Anthropic calls must be stubbed explicitly.
beforeEach(() => {
  vi.stubGlobal('fetch', async (url: unknown) => {
    throw new Error(`unmocked fetch: ${String(url)}`);
  });
});
