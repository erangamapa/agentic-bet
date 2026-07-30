import { beforeEach, describe, expect, it } from 'vitest';
import { requestExecutionGrant } from '../src/agents/privilege.js';
import { setExecutor, type BetExecutor, type VerificationResult } from '../src/chain/executor.js';
import { newTraceContext } from '../src/observability/tracing.js';
import { estimateSchemaTokens } from '../src/observability/token-usage.js';
import { getStore } from '../src/repositories/index.js';
import { confirmSuggestion, placeConfirmedBet, quoteBet } from '../src/services/betting.js';
import { newId } from '../src/domain/types.js';
import { resetWorld, TEST_USER } from './helpers.js';

const MARKET = 'mkt_nba_bos_den_ml';

class NeverConfirmsExecutor implements BetExecutor {
  readonly mode = 'stub' as const;
  async broadcast() {
    return { txHash: '0xfeed', elapsedMs: 1 };
  }
  async verify(): Promise<VerificationResult> {
    return {
      status: 'failed',
      txHash: '0xfeed',
      blockNumber: null,
      onChainIntentHash: null,
      betId: null,
      reason: 'reverted',
    };
  }
}

async function placeOnce(stake = 20) {
  const quote = await quoteBet({
    userId: TEST_USER,
    marketId: MARKET,
    selectionId: 'home',
    stake,
    channel: 'web',
  });
  await confirmSuggestion({ userId: TEST_USER, suggestionOrCode: quote.suggestionId, channel: 'web' });
  return placeConfirmedBet(requestExecutionGrant('bet_placement'), {
    userId: TEST_USER,
    suggestionOrCode: quote.suggestionId,
    channel: 'web',
    ctx: newTraceContext({ userId: TEST_USER, channel: 'web' }),
  });
}

describe('audit trail', () => {
  beforeEach(async () => {
    await resetWorld();
  });

  it('records the full chain for a successful bet, in order', async () => {
    const outcome = await placeOnce();
    const events = await getStore().listAudit({ userId: TEST_USER, limit: 100 });
    const kinds = events.map((e) => e.kind).reverse(); // listAudit is newest-first

    expect(kinds).toEqual(
      expect.arrayContaining([
        'suggestion_created',
        'confirmation_created',
        'execution_requested',
        'confirmation_consumed',
        'execution_broadcast',
        'execution_confirmed',
        'success_reported',
      ]),
    );
    // Success must never be reported before the transaction confirms.
    expect(kinds.indexOf('execution_confirmed')).toBeLessThan(kinds.indexOf('success_reported'));
    // And confirmation must precede execution.
    expect(kinds.indexOf('confirmation_created')).toBeLessThan(kinds.indexOf('execution_requested'));

    const byExecution = await getStore().listAudit({ executionId: outcome.executionId });
    expect(byExecution.length).toBeGreaterThan(0);
  });

  it('never emits success_reported for a bet that did not confirm', async () => {
    setExecutor(new NeverConfirmsExecutor());
    await placeOnce();
    const events = await getStore().listAudit({ userId: TEST_USER, limit: 100 });
    expect(events.map((e) => e.kind)).not.toContain('success_reported');
    expect(events.map((e) => e.kind)).toContain('execution_failed');
  });

  it('records a refusal when the user never confirmed', async () => {
    const quote = await quoteBet({
      userId: TEST_USER,
      marketId: MARKET,
      selectionId: 'home',
      stake: 20,
      channel: 'web',
    });
    await placeConfirmedBet(requestExecutionGrant('bet_placement'), {
      userId: TEST_USER,
      suggestionOrCode: quote.suggestionId,
      channel: 'web',
      ctx: newTraceContext({ userId: TEST_USER, channel: 'web' }),
    }).catch(() => undefined);

    const events = await getStore().listAudit({ userId: TEST_USER, limit: 50 });
    const rejection = events.find((e) => e.kind === 'execution_rejected');
    expect(rejection?.detail.reason).toBe('No valid user confirmation');
  });

  it('makes a dispute answerable: no confirmation event means no confirmation happened', async () => {
    await placeOnce();
    const events = await getStore().listAudit({ userId: TEST_USER, limit: 100 });
    const confirmations = events.filter((e) => e.kind === 'confirmation_created');

    expect(confirmations).toHaveLength(1);
    expect(confirmations[0]!.channel).toBe('web');
    expect(confirmations[0]!.detail.confirmationId).toBeDefined();
  });

  it('ties every event in a turn to one trace id', async () => {
    const outcome = await placeOnce();
    const events = await getStore().listAudit({ executionId: outcome.executionId, limit: 50 });
    const traceIds = new Set(events.map((e) => e.traceId).filter(Boolean));
    expect(traceIds.size).toBe(1);
  });
});

describe('token accounting', () => {
  beforeEach(async () => {
    await resetWorld();
  });

  it('estimates larger schema overhead for a larger tool set', () => {
    const small = estimateSchemaTokens([{ name: 'a', description: 'x', schema: { type: 'object' } }]);
    const large = estimateSchemaTokens(
      Array.from({ length: 8 }, (_, i) => ({
        name: `tool_${i}`,
        description: 'a much longer description that a monolithic agent would carry on every single call',
        schema: { type: 'object', properties: { a: { type: 'string' }, b: { type: 'number' } } },
      })),
    );
    expect(large).toBeGreaterThan(small * 5);
  });

  it('reports zero overhead for an empty tool set', () => {
    expect(estimateSchemaTokens([])).toBe(0);
  });

  it('aggregates usage per agent role', async () => {
    const store = getStore();
    for (const [role, tokens] of [
      ['analyst', 1200],
      ['analyst', 800],
      ['bet_placement', 400],
    ] as const) {
      await store.recordTokenUsage({
        id: newId('tok'),
        agentRole: role,
        model: 'claude-sonnet-5',
        provider: 'anthropic',
        inputTokens: tokens,
        outputTokens: 100,
        totalTokens: tokens + 100,
        toolSchemaTokens: 300,
        userId: TEST_USER,
        traceId: null,
        createdAt: new Date(),
      });
    }

    const rows = await store.aggregateTokenUsage({ userId: TEST_USER });
    const analyst = rows.find((r) => r.agentRole === 'analyst');
    const placement = rows.find((r) => r.agentRole === 'bet_placement');

    expect(analyst?.calls).toBe(2);
    expect(analyst?.totalTokens).toBe(2200);
    expect(placement?.calls).toBe(1);
    // Sorted most expensive first, which is what the cost dashboard renders.
    expect(rows[0]!.agentRole).toBe('analyst');
  });
});
