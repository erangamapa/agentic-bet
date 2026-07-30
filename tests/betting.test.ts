import { beforeEach, describe, expect, it } from 'vitest';
import { requestExecutionGrant } from '../src/agents/privilege.js';
import {
  setExecutor,
  StubExecutor,
  type BetExecutor,
  type ExecutionRequest,
  type VerificationResult,
} from '../src/chain/executor.js';
import { ConfirmationRequiredError, RiskRuleError } from '../src/domain/errors.js';
import { newTraceContext } from '../src/observability/tracing.js';
import { getStore } from '../src/repositories/index.js';
import {
  confirmSuggestion,
  dismissSuggestion,
  listPendingSuggestions,
  placeConfirmedBet,
  quoteBet,
} from '../src/services/betting.js';
import { resetWorld, TEST_USER } from './helpers.js';

const MARKET = 'mkt_epl_ars_che_1x2';
const SELECTION = 'home';

const ctx = () => newTraceContext({ userId: TEST_USER, channel: 'web' });
const grant = () => requestExecutionGrant('bet_placement');

async function quoteAndConfirm(stake = 20) {
  const quote = await quoteBet({
    userId: TEST_USER,
    marketId: MARKET,
    selectionId: SELECTION,
    stake,
    channel: 'web',
  });
  await confirmSuggestion({ userId: TEST_USER, suggestionOrCode: quote.suggestionId, channel: 'web' });
  return quote;
}

/** Broadcasts fine, never reaches a confirmed receipt. */
class NeverConfirmsExecutor implements BetExecutor {
  readonly mode = 'stub' as const;
  async broadcast() {
    return { txHash: '0xabc', elapsedMs: 1 };
  }
  async verify(_r: ExecutionRequest, txHash: string): Promise<VerificationResult> {
    return { status: 'failed', txHash, blockNumber: null, onChainIntentHash: null, betId: null, reason: 'reverted' };
  }
}

/** Broadcast succeeds; verification throws (RPC unreachable). */
class VerifyThrowsExecutor implements BetExecutor {
  readonly mode = 'stub' as const;
  async broadcast() {
    return { txHash: '0xdef', elapsedMs: 1 };
  }
  async verify(): Promise<VerificationResult> {
    throw new Error('RPC timeout while waiting for receipt');
  }
}

describe('quoting and risk limits', () => {
  beforeEach(async () => {
    await resetWorld();
  });

  it('quotes at the live market price', async () => {
    const quote = await quoteBet({
      userId: TEST_USER,
      marketId: MARKET,
      selectionId: SELECTION,
      stake: 20,
      channel: 'web',
    });
    expect(quote.odds).toBe(1.95);
    expect(quote.potentialReturn).toBe(39);
    expect(quote.confirmCode).toHaveLength(6);
  });

  it('refuses a stake above the per-bet limit', async () => {
    await expect(
      quoteBet({ userId: TEST_USER, marketId: MARKET, selectionId: SELECTION, stake: 10_000, channel: 'web' }),
    ).rejects.toThrow(RiskRuleError);
  });

  it('refuses a stake below the minimum', async () => {
    await expect(
      quoteBet({ userId: TEST_USER, marketId: MARKET, selectionId: SELECTION, stake: 0.01, channel: 'web' }),
    ).rejects.toThrow(RiskRuleError);
  });

  it('refuses a suspended market', async () => {
    await expect(
      quoteBet({ userId: TEST_USER, marketId: 'mkt_atp_final_ws', selectionId: 'home', stake: 10, channel: 'web' }),
    ).rejects.toThrow(/suspended/);
  });

  it('refuses an unknown selection', async () => {
    await expect(
      quoteBet({ userId: TEST_USER, marketId: MARKET, selectionId: 'nonsense', stake: 10, channel: 'web' }),
    ).rejects.toThrow(/does not exist/);
  });

  it('enforces the daily aggregate cap across separate bets', async () => {
    // Default cap is 1000/day with a 250 per-bet ceiling: four bets reach it.
    for (let i = 0; i < 4; i += 1) {
      const quote = await quoteAndConfirm(250);
      const outcome = await placeConfirmedBet(grant(), {
        userId: TEST_USER,
        suggestionOrCode: quote.suggestionId,
        channel: 'web',
        ctx: ctx(),
      });
      expect(outcome.status).toBe('confirmed');
    }
    await expect(
      quoteBet({ userId: TEST_USER, marketId: MARKET, selectionId: SELECTION, stake: 50, channel: 'web' }),
    ).rejects.toThrow(/daily cap/);
  });

  it('honours a per-user limit override', async () => {
    await getStore().upsertUser({
      id: TEST_USER,
      displayName: 'Test User',
      walletAddress: null,
      telegramId: null,
      limitsOverride: { maxStakePerBet: 10 },
    });
    await expect(
      quoteBet({ userId: TEST_USER, marketId: MARKET, selectionId: SELECTION, stake: 50, channel: 'web' }),
    ).rejects.toThrow(/per-bet limit of 10/);
  });
});

describe('confirmation gate', () => {
  beforeEach(async () => {
    await resetWorld();
  });

  it('refuses to execute without a confirmation', async () => {
    const quote = await quoteBet({
      userId: TEST_USER,
      marketId: MARKET,
      selectionId: SELECTION,
      stake: 20,
      channel: 'web',
    });
    await expect(
      placeConfirmedBet(grant(), {
        userId: TEST_USER,
        suggestionOrCode: quote.suggestionId,
        channel: 'web',
        ctx: ctx(),
      }),
    ).rejects.toThrow(ConfirmationRequiredError);
  });

  it('executes once confirmed', async () => {
    const quote = await quoteAndConfirm();
    const outcome = await placeConfirmedBet(grant(), {
      userId: TEST_USER,
      suggestionOrCode: quote.suggestionId,
      channel: 'web',
      ctx: ctx(),
    });
    expect(outcome.status).toBe('confirmed');
    expect(outcome.txHash).toMatch(/^0x/);
    expect(outcome.reportedToUserAt).not.toBeNull();
  });

  it('accepts the short confirmation code as well as the id', async () => {
    const quote = await quoteBet({
      userId: TEST_USER,
      marketId: MARKET,
      selectionId: SELECTION,
      stake: 20,
      channel: 'telegram',
    });
    await confirmSuggestion({ userId: TEST_USER, suggestionOrCode: quote.confirmCode, channel: 'telegram' });
    const outcome = await placeConfirmedBet(grant(), {
      userId: TEST_USER,
      suggestionOrCode: quote.confirmCode,
      channel: 'telegram',
      ctx: newTraceContext({ userId: TEST_USER, channel: 'telegram' }),
    });
    expect(outcome.status).toBe('confirmed');
  });

  it('consumes a confirmation exactly once', async () => {
    const quote = await quoteAndConfirm();
    const first = await placeConfirmedBet(grant(), {
      userId: TEST_USER,
      suggestionOrCode: quote.suggestionId,
      channel: 'web',
      ctx: ctx(),
    });
    expect(first.status).toBe('confirmed');

    await expect(
      placeConfirmedBet(grant(), {
        userId: TEST_USER,
        suggestionOrCode: quote.suggestionId,
        channel: 'web',
        ctx: ctx(),
      }),
    ).rejects.toThrow(ConfirmationRequiredError);
  });

  it('loses the race exactly once when the same bet is submitted concurrently', async () => {
    const quote = await quoteAndConfirm();
    const attempts = await Promise.allSettled(
      Array.from({ length: 4 }, () =>
        placeConfirmedBet(grant(), {
          userId: TEST_USER,
          suggestionOrCode: quote.suggestionId,
          channel: 'web',
          ctx: ctx(),
        }),
      ),
    );
    const succeeded = attempts.filter((a) => a.status === 'fulfilled' && a.value.status === 'confirmed');
    expect(succeeded).toHaveLength(1);
  });

  it('refuses a confirmation for a dismissed suggestion', async () => {
    const quote = await quoteBet({
      userId: TEST_USER,
      marketId: MARKET,
      selectionId: SELECTION,
      stake: 20,
      channel: 'web',
    });
    await dismissSuggestion(TEST_USER, quote.suggestionId);
    await expect(
      confirmSuggestion({ userId: TEST_USER, suggestionOrCode: quote.suggestionId, channel: 'web' }),
    ).rejects.toThrow(/dismissed/);
  });

  it('refuses one user confirming another user\'s suggestion', async () => {
    const store = getStore();
    await store.upsertUser({
      id: 'usr_other',
      displayName: 'Other',
      walletAddress: null,
      telegramId: null,
      limitsOverride: null,
    });
    const quote = await quoteBet({
      userId: TEST_USER,
      marketId: MARKET,
      selectionId: SELECTION,
      stake: 20,
      channel: 'web',
    });
    await expect(
      confirmSuggestion({ userId: 'usr_other', suggestionOrCode: quote.suggestionId, channel: 'web' }),
    ).rejects.toThrow();
  });
});

describe('never report success without a confirmed transaction', () => {
  beforeEach(async () => {
    await resetWorld();
  });

  it('reports failure and leaves reportedToUserAt null when verification fails', async () => {
    setExecutor(new NeverConfirmsExecutor());
    const quote = await quoteAndConfirm();
    const outcome = await placeConfirmedBet(grant(), {
      userId: TEST_USER,
      suggestionOrCode: quote.suggestionId,
      channel: 'web',
      ctx: ctx(),
    });

    expect(outcome.status).toBe('failed');
    expect(outcome.reportedToUserAt).toBeNull();

    const stored = await getStore().getExecution(outcome.executionId);
    expect(stored?.txStatus).toBe('failed');
    expect(stored?.reportedToUserAt).toBeNull();
  });

  it('leaves the bet pending — not confirmed — when verification itself errors', async () => {
    setExecutor(new VerifyThrowsExecutor());
    const quote = await quoteAndConfirm();
    const outcome = await placeConfirmedBet(grant(), {
      userId: TEST_USER,
      suggestionOrCode: quote.suggestionId,
      channel: 'web',
      ctx: ctx(),
    });

    expect(outcome.status).toBe('pending');
    expect(outcome.reportedToUserAt).toBeNull();

    const stored = await getStore().getExecution(outcome.executionId);
    expect(stored?.txStatus).toBe('pending');
    expect(stored?.failureReason).toMatch(/RPC timeout/);
  });

  it('refuses a transaction hash the executor never broadcast', async () => {
    const executor = new StubExecutor();
    const request: ExecutionRequest = {
      executionId: 'exe_fake',
      userId: TEST_USER,
      bettor: '0x0000000000000000000000000000000000000001',
      marketId: MARKET,
      selectionId: SELECTION,
      stake: 10,
      odds: 1.95,
      intentHash: 'a'.repeat(64),
    };
    const verification = await executor.verify(request, '0xhallucinated');
    expect(verification.status).toBe('failed');
    expect(verification.reason).toMatch(/never broadcast/);
  });

  it('marks the suggestion executed only after a confirmed bet', async () => {
    setExecutor(new NeverConfirmsExecutor());
    const failing = await quoteAndConfirm(11);
    await placeConfirmedBet(grant(), {
      userId: TEST_USER,
      suggestionOrCode: failing.suggestionId,
      channel: 'web',
      ctx: ctx(),
    });
    expect((await getStore().getSuggestion(failing.suggestionId))?.status).not.toBe('executed');

    setExecutor(null);
    const succeeding = await quoteAndConfirm(12);
    await placeConfirmedBet(grant(), {
      userId: TEST_USER,
      suggestionOrCode: succeeding.suggestionId,
      channel: 'web',
      ctx: ctx(),
    });
    expect((await getStore().getSuggestion(succeeding.suggestionId))?.status).toBe('executed');
  });
});

describe('odds drift protection', () => {
  beforeEach(async () => {
    await resetWorld();
  });

  it('refuses to place at a materially different price than the user confirmed', async () => {
    const quote = await quoteAndConfirm();

    const store = getStore();
    const market = (await store.getMarket(MARKET))!;
    await store.upsertMarkets([
      {
        ...market,
        selections: market.selections.map((s) => (s.id === SELECTION ? { ...s, odds: 1.4 } : s)),
      },
    ]);

    await expect(
      placeConfirmedBet(grant(), {
        userId: TEST_USER,
        suggestionOrCode: quote.suggestionId,
        channel: 'web',
        ctx: ctx(),
      }),
    ).rejects.toThrow(/Odds moved/);
  });

  it('tolerates a small price move', async () => {
    const quote = await quoteAndConfirm();

    const store = getStore();
    const market = (await store.getMarket(MARKET))!;
    await store.upsertMarkets([
      {
        ...market,
        selections: market.selections.map((s) => (s.id === SELECTION ? { ...s, odds: 1.97 } : s)),
      },
    ]);

    const outcome = await placeConfirmedBet(grant(), {
      userId: TEST_USER,
      suggestionOrCode: quote.suggestionId,
      channel: 'web',
      ctx: ctx(),
    });
    expect(outcome.status).toBe('confirmed');
  });
});

describe('suggestion listing', () => {
  beforeEach(async () => {
    await resetWorld();
  });

  it('lists suggested and confirmed bets awaiting action', async () => {
    await quoteBet({ userId: TEST_USER, marketId: MARKET, selectionId: SELECTION, stake: 10, channel: 'web' });
    const second = await quoteAndConfirm(15);

    const pending = await listPendingSuggestions(TEST_USER);
    expect(pending).toHaveLength(2);
    expect(pending.find((s) => s.id === second.suggestionId)?.status).toBe('confirmed');
  });
});
