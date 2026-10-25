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
    // A long run's worker went from 120 MB to its 2 GB limit within a minute and a half, twenty minutes in (a duo, twice):
    // room to live through such a spike, and the long run logs what each agent was doing when the heap passed 1 GB.
    execArgv: ['--max-old-space-size=4096'],
  },
});
