import { beforeEach, describe, expect, it } from 'vitest';
import { requestExecutionGrant } from '../src/agents/privilege.js';
import { setExecutor, type BetExecutor, type VerificationResult } from '../src/chain/executor.js';
import { newTraceContext } from '../src/observability/tracing.js';
import { getStore } from '../src/repositories/index.js';
import { confirmSuggestion, placeConfirmedBet, quoteBet } from '../src/services/betting.js';
import { reconcilePendingExecutions } from '../src/services/reconciler.js';
import { resetWorld, TEST_USER } from './helpers.js';

const MARKET = 'mkt_epl_ars_che_1x2';

/** Broadcasts, then throws on verify — the exact way a bet gets stranded. */
class VerifyThrowsExecutor implements BetExecutor {
  readonly mode = 'stub' as const;
  constructor(private readonly onRetry: () => VerificationResult | null = () => null) {}
  private broadcast_count = 0;

  async broadcast() {
    this.broadcast_count += 1;
    return { txHash: '0xstranded', elapsedMs: 1 };
  }

  async verify(): Promise<VerificationResult> {
    const retry = this.onRetry();
    if (retry) return retry;
    throw new Error('RPC timeout while waiting for receipt');
  }
}

async function strandABet(executor: BetExecutor): Promise<string> {
  setExecutor(executor);
  const quote = await quoteBet({
    userId: TEST_USER,
    marketId: MARKET,
    selectionId: 'home',
    stake: 20,
    channel: 'web',
  });
  await confirmSuggestion({ userId: TEST_USER, suggestionOrCode: quote.suggestionId, channel: 'web' });
  const outcome = await placeConfirmedBet(requestExecutionGrant('bet_placement'), {
    userId: TEST_USER,
    suggestionOrCode: quote.suggestionId,
    channel: 'web',
    ctx: newTraceContext({ userId: TEST_USER, channel: 'web' }),
  });
  expect(outcome.status).toBe('pending');
  return outcome.executionId;
}

describe('pending-execution reconciler', () => {
  beforeEach(async () => {
    await resetWorld();
  });

  it('confirms a stranded bet once the chain answers', async () => {
    let resolved = false;
    const executionId = await strandABet(
      new VerifyThrowsExecutor(() =>
        resolved
          ? {
              status: 'confirmed',
              txHash: '0xstranded',
              blockNumber: 42,
              onChainIntentHash: null,
              betId: '0xbet',
              reason: null,
            }
          : null,
      ),
    );

    // The chain becomes readable, and the sweep picks the bet up.
    resolved = true;
    const result = await reconcilePendingExecutions({ minAgeMs: 0 });

    expect(result.confirmed).toBe(1);
    const stored = await getStore().getExecution(executionId);
    expect(stored?.txStatus).toBe('confirmed');
    expect(stored?.blockNumber).toBe(42);
    expect(stored?.reportedToUserAt).not.toBeNull();
  });

  it('fails a stranded bet whose transaction actually reverted', async () => {
    let resolved = false;
    const executionId = await strandABet(
      new VerifyThrowsExecutor(() =>
        resolved
          ? {
              status: 'failed',
              txHash: '0xstranded',
              blockNumber: 9,
              onChainIntentHash: null,
              betId: null,
              reason: 'reverted on-chain',
            }
          : null,
      ),
    );

    resolved = true;
    const result = await reconcilePendingExecutions({ minAgeMs: 0 });

    expect(result.failed).toBe(1);
    const stored = await getStore().getExecution(executionId);
    expect(stored?.txStatus).toBe('failed');
    expect(stored?.failureReason).toBe('reverted on-chain');
    // The critical property: a failed reconciliation must never report success.
    expect(stored?.reportedToUserAt).toBeNull();
  });

  it('leaves a bet pending when the chain is still unreachable', async () => {
    const executionId = await strandABet(new VerifyThrowsExecutor());

    const result = await reconcilePendingExecutions({ minAgeMs: 0 });

    expect(result.stillPending).toBe(1);
    expect(result.confirmed).toBe(0);
    const stored = await getStore().getExecution(executionId);
    expect(stored?.txStatus).toBe('pending');
    expect(stored?.reportedToUserAt).toBeNull();
  });

  it('skips executions that are too young to have settled', async () => {
    await strandABet(new VerifyThrowsExecutor());
    // Default minimum age is 30s; the bet was created milliseconds ago.
    const result = await reconcilePendingExecutions();
    expect(result.scanned).toBe(0);
  });

  it('records the reconciliation in the audit trail', async () => {
    let resolved = false;
    const executionId = await strandABet(
      new VerifyThrowsExecutor(() =>
        resolved
          ? {
              status: 'confirmed',
              txHash: '0xstranded',
              blockNumber: 7,
              onChainIntentHash: null,
              betId: '0xbet',
              reason: null,
            }
          : null,
      ),
    );
    resolved = true;
    await reconcilePendingExecutions({ minAgeMs: 0 });

    const events = await getStore().listAudit({ executionId, limit: 50 });
    const confirmedEvent = events.find((e) => e.kind === 'execution_confirmed');
    expect(confirmedEvent?.detail.reconciled).toBe(true);
  });

  it('is a no-op when nothing is pending', async () => {
    const result = await reconcilePendingExecutions({ minAgeMs: 0 });
    expect(result).toMatchObject({ scanned: 0, confirmed: 0, failed: 0, stillPending: 0 });
  });
});
