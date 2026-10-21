import { defineConfig } from 'vitest/config';

// Live tests need a running Paper server (see tests/live/README.md). They are never part of `pnpm check`.
export default defineConfig({
  test: {
    include: ['tests/live/**/*.test.ts'],
    environment: 'node',
    testTimeout: 300_000,
    hookTimeout: 300_000,
    pool: 'forks',
    fileParallelism: false,
  },
});
