/**
 * Exercises the full betting flow against the configured Neon database.
 *
 * The boundary checks in verify-boundary.ts run on the in-memory store; this
 * runs the same critical paths through PostgresStore so the SQL — the atomic
 * confirmation claim, the idempotency index, the audit sequence ordering — is
 * proven against a real Postgres rather than a hand-rolled test double.
 *
 * Run with: npm run verify:db   (requires DATABASE_URL)
 */
import { hasDatabase } from '../config/env.js';
import { requestExecutionGrant } from '../agents/privilege.js';
import { setExecutor, type BetExecutor, type VerificationResult } from '../chain/executor.js';
import { demoContent, demoMarkets } from '../data/fixtures.js';
import { newTraceContext } from '../observability/tracing.js';
import { getStore } from '../repositories/index.js';
import { migrate } from '../db/migrate.js';
import { confirmSuggestion, placeConfirmedBet, quoteBet } from '../services/betting.js';

const USER = 'usr_dbverify';
const MARKET = 'mkt_epl_ars_che_1x2';

const results: { name: string; ok: boolean; note: string }[] = [];

async function check(name: string, run: () => Promise<string>): Promise<void> {
  try {
    results.push({ name, ok: true, note: await run() });
  } catch (err) {
    results.push({ name, ok: false, note: err instanceof Error ? err.message : String(err) });
  }
}

function expect(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

class NeverConfirmsExecutor implements BetExecutor {
  readonly mode = 'stub' as const;
  async broadcast() {
    return { txHash: '0xnotconfirmed', elapsedMs: 1 };
  }
  async verify(): Promise<VerificationResult> {
    return {
      status: 'failed',
      txHash: '0xnotconfirmed',
      blockNumber: null,
      onChainIntentHash: null,
      betId: null,
      reason: 'Simulated revert',
    };
  }
}

async function main(): Promise<void> {
  if (!hasDatabase) {
    process.stderr.write('DATABASE_URL is not set — nothing to verify.\n');
    process.exit(1);
  }

  const store = getStore();
  if (store.kind !== 'postgres') {
    process.stderr.write(`Expected the postgres store, got "${store.kind}".\n`);
    process.exit(1);
  }

  await migrate();
  await store.upsertMarkets(demoMarkets);
  await store.upsertContent(demoContent);
  // A unique user per run keeps the daily-cap checks independent of history.
  const user = `${USER}_${Date.now()}`;
  await store.upsertUser({
    id: user,
    displayName: 'DB Verify',
    walletAddress: null,
    telegramId: null,
    limitsOverride: null,
  });

  await check('postgres store is active', async () => `store.kind = ${store.kind}`);

  await check('quote persists a suggestion row', async () => {
    const quote = await quoteBet({
      userId: user,
      marketId: MARKET,
      selectionId: 'home',
      stake: 25,
      channel: 'web',
    });
    const stored = await store.getSuggestion(quote.suggestionId);
    expect(stored !== null, 'suggestion was not persisted');
    expect(stored!.suggestedStake === 25, 'stake did not round-trip');
    return `suggestion ${quote.suggestionId} @ ${quote.odds}`;
  });

  await check('unconfirmed bet is refused', async () => {
    const quote = await quoteBet({
      userId: user,
      marketId: MARKET,
      selectionId: 'home',
      stake: 10,
      channel: 'web',
    });
    let refused = false;
    try {
      await placeConfirmedBet(requestExecutionGrant('bet_placement'), {
        userId: user,
        suggestionOrCode: quote.suggestionId,
        channel: 'web',
        ctx: newTraceContext({ userId: user, channel: 'web' }),
      });
    } catch {
      refused = true;
    }
    expect(refused, 'an unconfirmed bet executed against Postgres');
    return 'refused, as expected';
  });

  let confirmedExecutionId = '';
  await check('confirmed bet executes and is marked reported', async () => {
    const quote = await quoteBet({
      userId: user,
      marketId: MARKET,
      selectionId: 'home',
      stake: 20,
      channel: 'telegram',
    });
    await confirmSuggestion({ userId: user, suggestionOrCode: quote.confirmCode, channel: 'telegram' });
    const outcome = await placeConfirmedBet(requestExecutionGrant('bet_placement'), {
      userId: user,
      suggestionOrCode: quote.suggestionId,
      channel: 'web',
      ctx: newTraceContext({ userId: user, channel: 'web' }),
    });
    expect(outcome.status === 'confirmed', `expected confirmed, got ${outcome.status}`);
    const stored = await store.getExecution(outcome.executionId);
    expect(stored?.txStatus === 'confirmed', 'row is not confirmed');
    expect(stored?.reportedToUserAt !== null, 'reportedToUserAt was not set');
    confirmedExecutionId = outcome.executionId;
    return `execution ${outcome.executionId}, tx ${outcome.txHash?.slice(0, 14)}…`;
  });

  await check('SQL confirmation claim is atomic under concurrency', async () => {
    const quote = await quoteBet({
      userId: user,
      marketId: MARKET,
      selectionId: 'home',
      stake: 15,
      channel: 'web',
    });
    await confirmSuggestion({ userId: user, suggestionOrCode: quote.suggestionId, channel: 'web' });

    // Four simultaneous placements race on one confirmation row. The
    // `consumed_at IS NULL` predicate in the UPDATE must let exactly one win.
    const attempts = await Promise.allSettled(
      Array.from({ length: 4 }, () =>
        placeConfirmedBet(requestExecutionGrant('bet_placement'), {
          userId: user,
          suggestionOrCode: quote.suggestionId,
          channel: 'web',
          ctx: newTraceContext({ userId: user, channel: 'web' }),
        }),
      ),
    );
    const won = attempts.filter((a) => a.status === 'fulfilled' && a.value.status === 'confirmed');
    expect(won.length === 1, `${won.length} of 4 concurrent placements succeeded, expected exactly 1`);
    return '1 of 4 concurrent placements won the race';
  });

  await check('failed verification never sets reportedToUserAt', async () => {
    setExecutor(new NeverConfirmsExecutor());
    const quote = await quoteBet({
      userId: user,
      marketId: MARKET,
      selectionId: 'home',
      stake: 12,
      channel: 'web',
    });
    await confirmSuggestion({ userId: user, suggestionOrCode: quote.suggestionId, channel: 'web' });
    const outcome = await placeConfirmedBet(requestExecutionGrant('bet_placement'), {
      userId: user,
      suggestionOrCode: quote.suggestionId,
      channel: 'web',
      ctx: newTraceContext({ userId: user, channel: 'web' }),
    });
    setExecutor(null);
    expect(outcome.status === 'failed', `expected failed, got ${outcome.status}`);
    const stored = await store.getExecution(outcome.executionId);
    expect(stored?.reportedToUserAt === null, 'reportedToUserAt was set on a failed bet');
    return `status=failed, reportedToUserAt=null`;
  });

  await check('audit chain is ordered correctly by sequence', async () => {
    const events = await store.listAudit({ executionId: confirmedExecutionId, limit: 50 });
    const kinds = events.map((e) => e.kind).reverse();
    expect(kinds.includes('execution_confirmed'), 'no execution_confirmed event');
    expect(kinds.includes('success_reported'), 'no success_reported event');
    expect(
      kinds.indexOf('execution_confirmed') < kinds.indexOf('success_reported'),
      'success was reported before the transaction confirmed',
    );
    return kinds.join(' → ');
  });

  await check('token usage aggregates per role', async () => {
    const rows = await store.aggregateTokenUsage({ userId: user });
    return rows.length ? rows.map((r) => `${r.agentRole}:${r.totalTokens}`).join(', ') : 'no LLM calls in this run';
  });

  const pad = Math.max(...results.map((r) => r.name.length));
  process.stdout.write('\nNeon Postgres verification\n');
  process.stdout.write('='.repeat(pad + 12) + '\n');
  for (const r of results) {
    process.stdout.write(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name.padEnd(pad)}  ${r.note}\n`);
  }
  const failed = results.filter((r) => !r.ok);
  process.stdout.write('='.repeat(pad + 12) + '\n');
  process.stdout.write(`${results.length - failed.length}/${results.length} checks passed\n\n`);
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((err) => {
  process.stderr.write(`verify-db crashed: ${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});
