import { env, hasDatabase } from '../config/env.js';
import { logger } from '../observability/logger.js';
import { initTracing } from '../observability/tracing.js';
import { ensureSeedData } from '../db/seed.js';
import { buildApp } from './app.js';

async function main(): Promise<void> {
  initTracing();

  // Demo markets and social content. Idempotent, and a no-op if data exists.
  await ensureSeedData();

  const app = await buildApp();

  await app.listen({ port: env.PORT, host: '0.0.0.0' });
  logger.info(
    {
      component: 'server',
      port: env.PORT,
      executionMode: env.EXECUTION_MODE,
      store: hasDatabase ? 'neon' : 'memory',
    },
    `agentic-bet listening on http://localhost:${env.PORT}`,
  );

  const shutdown = async (signal: string) => {
    logger.info({ component: 'server', signal }, 'Shutting down');
    await app.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  logger.fatal({ err }, 'Failed to start server');
  process.exit(1);
});
