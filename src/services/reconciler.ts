import { getExecutor } from '../chain/executor.js';
import { derivedWalletAddress } from '../chain/executor.js';
import type { BetExecution } from '../domain/types.js';
import { audit } from '../observability/audit.js';
import { logger } from '../observability/logger.js';
import { getStore } from '../repositories/index.js';

/**
 * Resolves executions stranded in `pending`.
 *
 * A bet reaches this state when the transaction was broadcast but verification
 * could not complete — an RPC timeout, a process restart mid-flight. The
 * placement path deliberately leaves those as `pending` rather than guessing:
 * calling them failed could double-stake a user on retry, and calling them
 * confirmed is the exact bug this system exists to prevent.
 *
 * So the decision is deferred to here, where the chain can be asked again.
 * Until this runs, the user is told the bet is still confirming — never that it
 * was placed.
 */

export interface ReconcileResult {
  scanned: number;
  confirmed: number;
  failed: number;
  stillPending: number;
}

/** Executions younger than this are left alone; the tx may simply still be in flight. */
const MIN_AGE_MS = 30_000;

export async function reconcilePendingExecutions(opts: { limit?: number; minAgeMs?: number } = {}): Promise<ReconcileResult> {
  const store = getStore();
  const executor = getExecutor();
  const minAge = opts.minAgeMs ?? MIN_AGE_MS;
  const cutoff = Date.now() - minAge;

  const pending = await store.listPendingExecutions(opts.limit ?? 50);
  const result: ReconcileResult = { scanned: 0, confirmed: 0, failed: 0, stillPending: 0 };

  for (const execution of pending) {
    if (execution.updatedAt.getTime() > cutoff) continue;
    result.scanned += 1;

    // No hash means the broadcast never returned one, so there is nothing on
    // chain to look for. Fail it so the user can re-confirm cleanly.
    if (!execution.txHash) {
      await markFailed(execution, 'Broadcast produced no transaction hash');
      result.failed += 1;
      continue;
    }

    try {
      const verification = await executor.verify(toRequest(execution), execution.txHash);

      if (verification.status === 'confirmed') {
        const confirmedAt = new Date();
        await store.updateExecution(execution.id, {
          txStatus: 'confirmed',
          blockNumber: verification.blockNumber,
          reportedToUserAt: confirmedAt,
          failureReason: null,
        });
        await store.updateSuggestionStatus(execution.suggestionId ?? '', 'executed').catch(() => undefined);
        await audit({
          kind: 'execution_confirmed',
          userId: execution.userId,
          channel: execution.channel,
          executionId: execution.id,
          suggestionId: execution.suggestionId,
          agentRole: 'bet_placement',
          traceId: execution.traceId,
          detail: {
            reconciled: true,
            txHash: verification.txHash,
            blockNumber: verification.blockNumber,
            betId: verification.betId,
          },
        });
        result.confirmed += 1;
        continue;
      }

      await markFailed(execution, verification.reason ?? 'Transaction did not confirm');
      result.failed += 1;
    } catch (err) {
      // Still unresolvable — leave it pending and try again next sweep.
      const reason = err instanceof Error ? err.message : String(err);
      logger.warn(
        { component: 'reconciler', executionId: execution.id, err: reason },
        'Execution remains unresolved',
      );
      result.stillPending += 1;
    }
  }

  if (result.scanned > 0) {
    logger.info({ component: 'reconciler', ...result }, 'Reconciliation sweep complete');
  }
  return result;
}

/**
 * Background sweep. Returns a stop function.
 *
 * `unref` keeps the timer from holding the process open, so a server shutting
 * down is not delayed by a pending reconciliation tick.
 */
export function startReconciler(intervalMs = 60_000): () => void {
  const timer = setInterval(() => {
    reconcilePendingExecutions().catch((err) => {
      logger.error({ component: 'reconciler', err }, 'Reconciliation sweep failed');
    });
  }, intervalMs);
  timer.unref?.();
  logger.info({ component: 'reconciler', intervalMs }, 'Pending-execution reconciler started');
  return () => clearInterval(timer);
}

async function markFailed(execution: BetExecution, reason: string): Promise<void> {
  await getStore().updateExecution(execution.id, { txStatus: 'failed', failureReason: reason });
  await audit({
    kind: 'execution_failed',
    userId: execution.userId,
    channel: execution.channel,
    executionId: execution.id,
    suggestionId: execution.suggestionId,
    agentRole: 'bet_placement',
    traceId: execution.traceId,
    detail: { reconciled: true, reason, txHash: execution.txHash },
  });
}

function toRequest(execution: BetExecution) {
  return {
    executionId: execution.id,
    userId: execution.userId,
    bettor: derivedWalletAddress(execution.userId),
    marketId: execution.marketId,
    selectionId: execution.selectionId,
    stake: execution.stake,
    odds: execution.odds,
    intentHash: execution.intentHash,
  };
}
