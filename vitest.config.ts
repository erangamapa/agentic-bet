import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    env: {
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      EXECUTION_MODE: 'stub',
      ANTHROPIC_API_KEY: 'test-key-not-used',
    },
    // The privilege registry and store are process-global singletons; running
    // files in one thread keeps their reset semantics honest.
    pool: 'threads',
    maxWorkers: 1,
    fileParallelism: false,
  },
});
