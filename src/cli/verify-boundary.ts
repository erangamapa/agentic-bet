/**
 * Milestone 7 verification, runnable with no API keys and no database.
 *
 * Checks the three properties the spec asks to prove:
 *   (a) the Analyst Agent cannot trigger execution under any input,
 *   (b) web and Telegram produce identical betting behaviour for equivalent input,
 *   (c) no "success" is ever reported without a confirmed transaction.
 *
 * Run with: npm run verify:boundary
 */
import { tool, type StructuredToolInterface } from '@langchain/core/tools';
import { z } from 'zod';
import {
  assertToolsAllowedForRole,
  registerTool,
  requestExecutionGrant,
  roleClearance,
  type ExecutionGrant,
} from '../agents/privilege.js';
import { setExecutor, type BetExecutor, type ExecutionRequest, type VerificationResult } from '../chain/executor.js';
import { PrivilegeViolationError } from '../domain/errors.js';
import { computeIntentHash } from '../domain/types.js';
import { newTraceContext } from '../observability/tracing.js';
import { MemoryStore, setStore } from '../repositories/index.js';
import { buildAnalystTools } from '../tools/analyst-tools.js';
import { sanitiseUntrustedText } from '../tools/sanitiser.js';
import { demoContent, demoMarkets } from '../data/fixtures.js';
import { confirmSuggestion, placeConfirmedBet, quoteBet } from '../services/betting.js';

interface Check {
  name: string;
  run: () => Promise<string>;
}

const results: { name: string; ok: boolean; note: string }[] = [];

async function check(name: string, run: () => Promise<string>): Promise<void> {
  try {
    const note = await run();
    results.push({ name, ok: true, note });
  } catch (err) {
    results.push({ name, ok: false, note: err instanceof Error ? err.message : String(err) });
  }
}

function expect(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

/** Stand-in for the real bet tool, used to prove the analyst cannot hold one. */
function makeFakeExecutionTool(): StructuredToolInterface {
  const t = tool(async () => 'executed', {
    name: 'place_confirmed_bet__probe',
    description: 'probe',
    schema: z.object({ x: z.string() }),
  });
  return registerTool(t as unknown as StructuredToolInterface, 'execute');
}

/** Executor whose broadcast succeeds but whose verification never confirms. */
class NeverConfirmsExecutor implements BetExecutor {
  readonly mode = 'stub' as const;
  async broadcast(): Promise<{ txHash: string; elapsedMs: number }> {
    return { txHash: '0xdeadbeef', elapsedMs: 1 };
  }
  async verify(_request: ExecutionRequest, txHash: string): Promise<VerificationResult> {
    return {
      status: 'failed',
      txHash,
      blockNumber: null,
      onChainIntentHash: null,
      betId: null,
      reason: 'Simulated: receipt never reached success',
    };
  }
}

async function freshStore(): Promise<MemoryStore> {
  const store = new MemoryStore();
  setStore(store);
  await store.upsertMarkets(demoMarkets);
  await store.upsertContent(demoContent);
  await store.upsertUser({
    id: 'usr_verify',
    displayName: 'Verify',
    walletAddress: null,
    telegramId: null,
    limitsOverride: null,
  });
  return store;
}

const checks: Check[] = [
  // -----------------------------------------------------------------------
  // (a) The Analyst cannot trigger execution
  // -----------------------------------------------------------------------
  {
    name: 'a1. analyst role is capped at read clearance',
    run: async () => {
      expect(roleClearance.analyst === 'read', `analyst clearance is "${roleClearance.analyst}"`);
      expect(roleClearance.bet_placement === 'execute', 'bet_placement should hold execute clearance');
      return 'analyst=read, bet_placement=execute';
    },
  },
  {
    name: 'a2. analyst tool set contains no execute-clearance tool',
    run: async () => {
      await freshStore();
      const ctx = newTraceContext({ userId: 'usr_verify', channel: 'web' });
      const tools = buildAnalystTools(ctx);
      assertToolsAllowedForRole('analyst', tools);
      return `${tools.length} read tools: ${tools.map((t) => t.name).join(', ')}`;
    },
  },
  {
    name: 'a3. giving the analyst an execution tool fails at construction',
    run: async () => {
      await freshStore();
      const ctx = newTraceContext({ userId: 'usr_verify', channel: 'web' });
      const tools = [...buildAnalystTools(ctx), makeFakeExecutionTool()];
      let threw = false;
      try {
        assertToolsAllowedForRole('analyst', tools);
      } catch (err) {
        threw = err instanceof PrivilegeViolationError;
      }
      expect(threw, 'analyst was allowed to hold an execute-clearance tool');
      return 'PrivilegeViolationError raised as expected';
    },
  },
  {
    name: 'a4. analyst cannot obtain an execution grant',
    run: async () => {
      let threw = false;
      try {
        requestExecutionGrant('analyst');
      } catch (err) {
        threw = err instanceof PrivilegeViolationError;
      }
      expect(threw, 'analyst obtained an execution grant');
      return 'grant refused for role "analyst"';
    },
  },
  {
    name: 'a5. a forged execution grant is rejected by the money path',
    run: async () => {
      await freshStore();
      const ctx = newTraceContext({ userId: 'usr_verify', channel: 'web' });
      const forged = { role: 'bet_placement', issuedAt: new Date() } as unknown as ExecutionGrant;
      let threw = false;
      try {
        await placeConfirmedBet(forged, {
          userId: 'usr_verify',
          suggestionOrCode: 'sug_whatever',
          channel: 'web',
          ctx,
        });
      } catch (err) {
        threw = err instanceof PrivilegeViolationError;
      }
      expect(threw, 'a hand-built grant object was accepted');
      return 'forged grant rejected — the brand symbol is module-private';
    },
  },
  {
    name: 'a6. prompt-injected content is flagged and neutralised before the analyst reads it',
    run: async () => {
      const injected = demoContent.find((c) => c.id === 'post_004_injection');
      expect(Boolean(injected), 'injection fixture missing');
      const { sanitised, flags, text } = sanitiseUntrustedText(injected!.body);
      expect(sanitised, 'injection payload was not detected');
      expect(!/placeBetOnBehalfOf/.test(text), 'tool name survived sanitisation');
      return `flags: ${flags.join(', ')}`;
    },
  },

  // -----------------------------------------------------------------------
  // (b) Web and Telegram behave identically
  // -----------------------------------------------------------------------
  {
    name: 'b1. identical input produces identical quotes on web and telegram',
    run: async () => {
      await freshStore();
      const web = await quoteBet({
        userId: 'usr_verify',
        marketId: 'mkt_epl_ars_che_1x2',
        selectionId: 'home',
        stake: 25,
        channel: 'web',
      });
      const telegram = await quoteBet({
        userId: 'usr_verify',
        marketId: 'mkt_epl_ars_che_1x2',
        selectionId: 'home',
        stake: 25,
        channel: 'telegram',
      });
      expect(web.intentHash === telegram.intentHash, 'intent hashes differ between channels');
      expect(web.stake === telegram.stake && web.odds === telegram.odds, 'stake/odds differ between channels');
      expect(
        JSON.stringify(web.limits) === JSON.stringify(telegram.limits),
        'risk limits differ between channels',
      );
      return `both channels: stake=${web.stake} odds=${web.odds} intentHash=${web.intentHash.slice(0, 12)}…`;
    },
  },
  {
    name: 'b2. the same limit refuses the same bet on both channels',
    run: async () => {
      await freshStore();
      const overLimit = { marketId: 'mkt_epl_ars_che_1x2', selectionId: 'home', stake: 100_000 };
      const messages: string[] = [];
      for (const channel of ['web', 'telegram'] as const) {
        try {
          await quoteBet({ userId: 'usr_verify', channel, ...overLimit });
          throw new Error(`${channel} accepted an over-limit stake`);
        } catch (err) {
          messages.push(err instanceof Error ? err.message : String(err));
        }
      }
      expect(messages[0] === messages[1], `refusal differs: "${messages[0]}" vs "${messages[1]}"`);
      return `identical refusal on both channels: ${messages[0]}`;
    },
  },
  {
    name: 'b3. a telegram confirmation is honoured by a web execution (one shared gate)',
    run: async () => {
      const store = await freshStore();
      setExecutor(null);
      const quote = await quoteBet({
        userId: 'usr_verify',
        marketId: 'mkt_epl_ars_che_1x2',
        selectionId: 'home',
        stake: 10,
        channel: 'telegram',
      });
      await confirmSuggestion({ userId: 'usr_verify', suggestionOrCode: quote.confirmCode, channel: 'telegram' });
      const ctx = newTraceContext({ userId: 'usr_verify', channel: 'web' });
      const outcome = await placeConfirmedBet(requestExecutionGrant('bet_placement'), {
        userId: 'usr_verify',
        suggestionOrCode: quote.suggestionId,
        channel: 'web',
        ctx,
      });
      expect(outcome.status === 'confirmed', `expected confirmed, got ${outcome.status}`);
      const stored = await store.getExecution(outcome.executionId);
      expect(stored?.txStatus === 'confirmed', 'stored execution is not confirmed');
      return `confirmed cross-channel, tx ${outcome.txHash?.slice(0, 12)}…`;
    },
  },

  // -----------------------------------------------------------------------
  // (c) No success without a confirmed transaction
  // -----------------------------------------------------------------------
  {
    name: 'c1. execution without a user confirmation is refused',
    run: async () => {
      await freshStore();
      setExecutor(null);
      const quote = await quoteBet({
        userId: 'usr_verify',
        marketId: 'mkt_nba_bos_den_ml',
        selectionId: 'home',
        stake: 20,
        channel: 'web',
      });
      const ctx = newTraceContext({ userId: 'usr_verify', channel: 'web' });
      let refused = false;
      let message = '';
      try {
        await placeConfirmedBet(requestExecutionGrant('bet_placement'), {
          userId: 'usr_verify',
          suggestionOrCode: quote.suggestionId,
          channel: 'web',
          ctx,
        });
      } catch (err) {
        refused = true;
        message = err instanceof Error ? err.message : String(err);
      }
      expect(refused, 'an unconfirmed bet was executed');
      return message.slice(0, 90);
    },
  },
  {
    name: 'c2. broadcast-but-not-verified never reports success',
    run: async () => {
      const store = await freshStore();
      setExecutor(new NeverConfirmsExecutor());
      const quote = await quoteBet({
        userId: 'usr_verify',
        marketId: 'mkt_nba_bos_den_ml',
        selectionId: 'home',
        stake: 15,
        channel: 'web',
      });
      await confirmSuggestion({ userId: 'usr_verify', suggestionOrCode: quote.suggestionId, channel: 'web' });
      const ctx = newTraceContext({ userId: 'usr_verify', channel: 'web' });
      const outcome = await placeConfirmedBet(requestExecutionGrant('bet_placement'), {
        userId: 'usr_verify',
        suggestionOrCode: quote.suggestionId,
        channel: 'web',
        ctx,
      });
      expect(outcome.status === 'failed', `expected failed, got ${outcome.status}`);
      expect(outcome.reportedToUserAt === null, 'reportedToUserAt was set for an unconfirmed transaction');
      const stored = await store.getExecution(outcome.executionId);
      expect(stored?.reportedToUserAt === null, 'stored row reported success without confirmation');
      setExecutor(null);
      return `status=failed, reportedToUserAt=null, reason="${outcome.failureReason}"`;
    },
  },
  {
    name: 'c3. a confirmation cannot be reused for a second bet',
    run: async () => {
      await freshStore();
      setExecutor(null);
      const quote = await quoteBet({
        userId: 'usr_verify',
        marketId: 'mkt_epl_liv_mci_1x2',
        selectionId: 'home',
        stake: 12,
        channel: 'web',
      });
      await confirmSuggestion({ userId: 'usr_verify', suggestionOrCode: quote.suggestionId, channel: 'web' });
      const ctx = newTraceContext({ userId: 'usr_verify', channel: 'web' });
      const first = await placeConfirmedBet(requestExecutionGrant('bet_placement'), {
        userId: 'usr_verify',
        suggestionOrCode: quote.suggestionId,
        channel: 'web',
        ctx,
      });
      expect(first.status === 'confirmed', 'first placement did not confirm');

      let refused = false;
      try {
        await placeConfirmedBet(requestExecutionGrant('bet_placement'), {
          userId: 'usr_verify',
          suggestionOrCode: quote.suggestionId,
          channel: 'web',
          ctx: newTraceContext({ userId: 'usr_verify', channel: 'web' }),
        });
      } catch {
        refused = true;
      }
      expect(refused, 'the same confirmation placed two bets');
      return 'second attempt refused — confirmation was already consumed';
    },
  },
  {
    name: 'c4. tampering with parameters after confirmation invalidates it',
    run: async () => {
      await freshStore();
      const base = {
        userId: 'usr_verify',
        marketId: 'mkt_epl_ars_che_1x2',
        selectionId: 'home',
        stake: 25,
        odds: 1.95,
      };
      const confirmed = computeIntentHash(base);
      const tamperedStake = computeIntentHash({ ...base, stake: 250 });
      const tamperedMarket = computeIntentHash({ ...base, marketId: 'mkt_nba_bos_den_ml' });
      expect(confirmed !== tamperedStake, 'stake change did not alter the intent hash');
      expect(confirmed !== tamperedMarket, 'market change did not alter the intent hash');
      return 'intent hash binds user, market, selection, stake and odds';
    },
  },
  {
    name: 'c5. a market that is not open cannot be bet on',
    run: async () => {
      await freshStore();
      let refused = false;
      let message = '';
      try {
        await quoteBet({
          userId: 'usr_verify',
          marketId: 'mkt_atp_final_ws',
          selectionId: 'home',
          stake: 10,
          channel: 'web',
        });
      } catch (err) {
        refused = true;
        message = err instanceof Error ? err.message : String(err);
      }
      expect(refused, 'a suspended market accepted a bet');
      return message;
    },
  },
];

async function main(): Promise<void> {
  for (const c of checks) {
    await check(c.name, c.run);
  }

  const pad = Math.max(...results.map((r) => r.name.length));
  process.stdout.write('\nBoundary verification\n');
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
  process.stderr.write(`verify-boundary crashed: ${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});
