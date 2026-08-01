/**
 * One reconciliation sweep, then exit. Entry point for the Cloud Run Job that
 * Cloud Scheduler triggers.
 *
 * Why a job rather than an endpoint on the API service: Cloud Run throttles CPU
 * to near-zero between requests, so the in-process timer used locally does not
 * reliably fire in production — and a stranded bet that is never reconciled is
 * a user whose money is in limbo. A job gets full CPU, its own timeout and
 * retry policy, and its authentication is handled entirely by IAM, so no token
 * verification code sits in the request path of the money service.
 *
 * Run locally with: npm run reconcile
 */
import { logger } from '../observability/logger.js';
import { initTracing } from '../observability/tracing.js';
import { reconcilePendingExecutions } from '../services/reconciler.js';

const RECONCILE_LIMIT = Number(process.env.RECONCILE_LIMIT ?? 100);
const RECONCILE_MIN_AGE_MS = Number(process.env.RECONCILE_MIN_AGE_MS ?? 30_000);

async function main(): Promise<void> {
  initTracing();

  const started = Date.now();
  const result = await reconcilePendingExecutions({
    limit: RECONCILE_LIMIT,
    minAgeMs: RECONCILE_MIN_AGE_MS,
  });

  logger.info(
    { component: 'reconcile-job', ...result, elapsedMs: Date.now() - started },
    'Reconciliation job finished',
  );

  // A sweep that could not resolve everything is not a failure — those bets are
  // retried next run. Exiting non-zero would make Cloud Run retry immediately
  // and mark healthy executions as failed job runs.
  process.exit(0);
}

main().catch((err) => {
  logger.fatal({ component: 'reconcile-job', err }, 'Reconciliation job failed');
  process.exit(1);
});
