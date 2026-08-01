import { env, hasDatabase, reconcilerMode } from '../config/env.js';
import { logger } from '../observability/logger.js';
import { initTracing } from '../observability/tracing.js';
import { ensureSeedData } from '../db/seed.js';
import { describeToolCatalog } from '../agents/tool-catalog.js';
import { startReconciler } from '../services/reconciler.js';
import { buildApp } from './app.js';

async function main(): Promise<void> {
  initTracing();

  // Demo markets and social content. Idempotent, and a no-op if data exists.
  await ensureSeedData();

  // Boot-time privilege assertion: a mis-wired tool crashes startup rather than
  // surfacing mid-conversation with a user's money involved.
  const catalog = describeToolCatalog();
  logger.info(
    {
      component: 'privilege',
      tools: catalog.map((t) => `${t.name}:${t.clearance}`),
      executeTools: catalog.filter((t) => t.clearance === 'execute').map((t) => t.name),
    },
    'Tool privilege catalog verified',
  );

  // On a platform that throttles CPU between requests an in-process timer does
  // not reliably fire, so production drives the sweep from a Cloud Run Job.
  const stopReconciler = reconcilerMode === 'inline' ? startReconciler() : noReconciler();

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
    stopReconciler();
    await app.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

function noReconciler(): () => void {
  logger.info(
    { component: 'reconciler', mode: 'external' },
    'In-process reconciler disabled — expecting an external scheduler to run the reconcile job',
  );
  return () => undefined;
}

main().catch((err) => {
  logger.fatal({ err }, 'Failed to start server');
  process.exit(1);
});
