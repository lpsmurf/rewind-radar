import { defineConfig } from 'vitest/config';

// Kept apart from vite.config.mts on purpose: that file loads .env.local, and tests must never see real keys.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    setupFiles: ['test/setup.ts'],
    restoreMocks: true,
    unstubGlobals: true,
    unstubEnvs: true,
  },
});
