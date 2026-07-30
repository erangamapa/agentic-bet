import { HumanMessage } from '@langchain/core/messages';
import { tool, type StructuredToolInterface } from '@langchain/core/tools';
import { z } from 'zod';
import { env } from '../config/env.js';
import { resolveLimits } from '../config/limits.js';
import { toErrorPayload } from '../domain/errors.js';
import { audit } from '../observability/audit.js';
import { logger } from '../observability/logger.js';
import { traceConfig, type TraceContext } from '../observability/tracing.js';
import { getStore } from '../repositories/index.js';
import {
  confirmCodeFor,
  getExecutionStatus,
  listPendingSuggestions,
  listUserExecutions,
  placeConfirmedBet,
  quoteBet,
} from '../services/betting.js';
import { createScopedAgent, type BuiltAgent } from './factory.js';
import { computeIntentHash } from '../domain/types.js';
import {
  registerTool,
  requestExecutionGrant,
  type ExecutionGrant,
} from './privilege.js';
import { betPlacementSystemPrompt } from './prompts.js';
import { renderContent } from './analyst.js';

/**
 * The Bet Placement Agent's tool set.
 *
 * Note what `place_confirmed_bet` accepts: a suggestion reference and nothing
 * else. Stake, odds, market and selection all come from the stored row the user
 * confirmed against — the model has no parameter through which it could alter
 * the size or target of a bet, whether by mistake, by hallucination, or because
 * something upstream told it to.
 */
export function buildBetPlacementTools(ctx: TraceContext, grant: ExecutionGrant): StructuredToolInterface[] {
  const quote = tool(
    async ({ marketId, selectionId, stake, fromSuggestionId }: {
      marketId: string;
      selectionId: string;
      stake: number;
      fromSuggestionId?: string;
    }) => {
      try {
        const q = await quoteBet({
          userId: ctx.userId,
          marketId,
          selectionId,
          stake,
          channel: ctx.channel,
          fromSuggestionId: fromSuggestionId ?? null,
        });
        ctx.suggestionId = q.suggestionId;
        return JSON.stringify({
          ok: true,
          confirmCode: q.confirmCode,
          suggestionId: q.suggestionId,
          fixture: q.fixture,
          selection: q.selectionLabel,
          stake: q.stake,
          odds: q.odds,
          potentialReturn: q.potentialReturn,
          expiresAt: q.expiresAt.toISOString(),
          instruction:
            'Present these numbers to the user and ask them to confirm with this code. Do NOT call place_confirmed_bet until they have.',
        });
      } catch (err) {
        return JSON.stringify({ ok: false, ...toErrorPayload(err) });
      }
    },
    {
      name: 'quote_bet',
      description:
        'Validate a proposed bet against live odds and the user\'s risk limits, and register it as a pending bet with a confirmation code. Moves no money. Always call this before place_confirmed_bet.',
      schema: z.object({
        marketId: z.string().describe('Market id, e.g. "mkt_epl_ars_che_1x2"'),
        selectionId: z.string().describe('Selection within the market, e.g. "home"'),
        stake: z.number().positive().describe('Stake in account currency units'),
        fromSuggestionId: z
          .string()
          .optional()
          .describe('Id of the Analyst suggestion this came from, if any'),
      }),
    },
  );

  const checkConfirmation = tool(
    async ({ suggestionIdOrCode }: { suggestionIdOrCode: string }) => {
      const store = getStore();
      const pending = await listPendingSuggestions(ctx.userId, 25);
      const match =
        pending.find((s) => s.id === suggestionIdOrCode) ??
        pending.find((s) => confirmCodeFor(s.id) === suggestionIdOrCode.trim().toUpperCase());

      if (!match) {
        return JSON.stringify({ confirmed: false, reason: 'No pending bet matches that reference' });
      }

      const intentHash = computeIntentHash({
        userId: match.userId,
        marketId: match.marketId,
        selectionId: match.selectionId,
        stake: match.suggestedStake,
        odds: match.odds,
      });
      const confirmation = await store.findUsableConfirmation(ctx.userId, intentHash, new Date());

      return JSON.stringify({
        confirmed: Boolean(confirmation),
        suggestionId: match.id,
        confirmCode: confirmCodeFor(match.id),
        stake: match.suggestedStake,
        odds: match.odds,
        marketId: match.marketId,
        selectionId: match.selectionId,
        reason: confirmation
          ? null
          : 'The user has not confirmed this bet (or the confirmation expired or was already used).',
      });
    },
    {
      name: 'check_confirmation',
      description:
        'Check whether the user has actually confirmed a pending bet. Use this whenever you are unsure — never assume confirmation from conversation alone.',
      schema: z.object({
        suggestionIdOrCode: z.string().describe('Suggestion id or the 6-character confirmation code'),
      }),
    },
  );

  const place = tool(
    async ({ suggestionIdOrCode }: { suggestionIdOrCode: string }) => {
      try {
        const outcome = await placeConfirmedBet(grant, {
          userId: ctx.userId,
          suggestionOrCode: suggestionIdOrCode,
          channel: ctx.channel,
          ctx,
        });

        if (outcome.status === 'confirmed') {
          return JSON.stringify({
            status: 'confirmed',
            executionId: outcome.executionId,
            txHash: outcome.txHash,
            blockNumber: outcome.blockNumber,
            stake: outcome.stake,
            odds: outcome.odds,
            potentialReturn: outcome.potentialReturn,
            instruction:
              'The transaction is confirmed on-chain. You may now tell the user the bet is placed, quoting the transaction hash.',
          });
        }

        if (outcome.status === 'pending') {
          return JSON.stringify({
            status: 'pending',
            executionId: outcome.executionId,
            txHash: outcome.txHash,
            instruction:
              'The transaction was broadcast but has NOT confirmed. Do NOT tell the user the bet is placed. Say it is still confirming and give them the execution id so they can check with get_bet_status.',
          });
        }

        return JSON.stringify({
          status: 'failed',
          executionId: outcome.executionId,
          reason: outcome.failureReason,
          instruction:
            'The bet was NOT placed. Tell the user clearly that it failed and give the reason. Do not retry without a fresh confirmation.',
        });
      } catch (err) {
        const payload = toErrorPayload(err);
        return JSON.stringify({
          status: 'refused',
          ...payload,
          instruction:
            'The bet was NOT placed. Explain the reason to the user. If confirmation is required, ask them to confirm with the code.',
        });
      }
    },
    {
      name: 'place_confirmed_bet',
      description:
        'Place a bet that the user has ALREADY confirmed. Takes only the reference to the confirmed bet — stake, odds and market come from the confirmed record and cannot be changed here. Never call this before the user has confirmed.',
      schema: z.object({
        suggestionIdOrCode: z
          .string()
          .describe('Suggestion id or the 6-character confirmation code of the bet the user confirmed'),
      }),
    },
  );

  const betStatus = tool(
    async ({ executionId }: { executionId: string }) => {
      try {
        const execution = await getExecutionStatus(ctx.userId, executionId);
        return JSON.stringify({
          executionId: execution.id,
          txStatus: execution.txStatus,
          txHash: execution.txHash,
          blockNumber: execution.blockNumber,
          stake: execution.stake,
          odds: execution.odds,
          marketId: execution.marketId,
          selectionId: execution.selectionId,
          reportedToUserAt: execution.reportedToUserAt?.toISOString() ?? null,
          failureReason: execution.failureReason,
          note:
            execution.txStatus === 'confirmed'
              ? 'Confirmed on-chain — safe to describe as placed.'
              : 'NOT confirmed — must not be described as placed.',
        });
      } catch (err) {
        return JSON.stringify({ ok: false, ...toErrorPayload(err) });
      }
    },
    {
      name: 'get_bet_status',
      description: 'Look up the on-chain status of a previously submitted bet by its execution id.',
      schema: z.object({ executionId: z.string() }),
    },
  );

  const listBets = tool(
    async () => {
      const [executions, pending] = await Promise.all([
        listUserExecutions(ctx.userId, 10),
        listPendingSuggestions(ctx.userId, 10),
      ]);
      return JSON.stringify({
        placedOrAttempted: executions.map((e) => ({
          executionId: e.id,
          marketId: e.marketId,
          selectionId: e.selectionId,
          stake: e.stake,
          odds: e.odds,
          txStatus: e.txStatus,
          txHash: e.txHash,
          createdAt: e.createdAt.toISOString(),
        })),
        awaitingConfirmation: pending.map((s) => ({
          suggestionId: s.id,
          confirmCode: confirmCodeFor(s.id),
          marketId: s.marketId,
          selectionId: s.selectionId,
          stake: s.suggestedStake,
          odds: s.odds,
          status: s.status,
          expiresAt: s.expiresAt?.toISOString() ?? null,
        })),
      });
    },
    {
      name: 'list_user_bets',
      description: 'List the user\'s recent bets and any bets still waiting for their confirmation.',
      schema: z.object({}),
    },
  );

  return [
    registerTool(quote as unknown as StructuredToolInterface, 'read'),
    registerTool(checkConfirmation as unknown as StructuredToolInterface, 'read'),
    // The only `execute`-clearance tool in the system.
    registerTool(place as unknown as StructuredToolInterface, 'execute'),
    registerTool(betStatus as unknown as StructuredToolInterface, 'read'),
    registerTool(listBets as unknown as StructuredToolInterface, 'read'),
  ];
}

/**
 * Builds the Bet Placement Agent. The execution grant is minted here and closed
 * over by the tool — it is never stored on the agent, never serialised into
 * state, and never reachable from another module.
 */
export async function buildBetPlacementAgent(ctx: TraceContext): Promise<BuiltAgent> {
  const grant = requestExecutionGrant('bet_placement');
  const user = await getStore().getUser(ctx.userId);
  const limits = resolveLimits(user?.limitsOverride ?? null);

  return createScopedAgent({
    role: 'bet_placement',
    systemPrompt: betPlacementSystemPrompt(limits),
    tools: buildBetPlacementTools(ctx, grant),
    // Low temperature: this agent should be boring and repeatable.
    temperature: 0,
    maxTokens: 1200,
    ...(env.PRIMARY_MODEL ? { preferredModel: env.PRIMARY_MODEL } : {}),
    getUserId: () => ctx.userId,
    getTraceId: () => ctx.traceId,
  });
}

export async function runBetPlacement(built: BuiltAgent, ctx: TraceContext, instruction: string): Promise<string> {
  await audit({
    kind: 'agent_invoked',
    agentRole: 'bet_placement',
    userId: ctx.userId,
    channel: ctx.channel,
    traceId: ctx.traceId,
    detail: { instruction: instruction.slice(0, 500), tools: built.toolNames, toolSchemaTokens: built.toolSchemaTokens },
  });

  try {
    const result = await built.agent.invoke(
      { messages: [new HumanMessage(instruction)] },
      traceConfig(ctx, 'bet_placement', { callbacks: [built.usageHandler], recursionLimit: 12 }),
    );
    const messages = (result as { messages?: { content?: unknown }[] }).messages ?? [];
    const reply = renderContent(messages[messages.length - 1]?.content);

    await audit({
      kind: 'agent_completed',
      agentRole: 'bet_placement',
      userId: ctx.userId,
      channel: ctx.channel,
      traceId: ctx.traceId,
      executionId: ctx.executionId ?? null,
      detail: { replyChars: reply.length },
    });
    return reply;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ component: 'bet-placement', err: message, traceId: ctx.traceId }, 'Bet placement run failed');
    await audit({
      kind: 'agent_failed',
      agentRole: 'bet_placement',
      userId: ctx.userId,
      channel: ctx.channel,
      traceId: ctx.traceId,
      detail: { error: message },
    });
    throw err;
  }
}
