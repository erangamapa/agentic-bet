import type { StructuredToolInterface } from '@langchain/core/tools';
import { env } from '../config/env.js';
import type { AgentRole, ClientChannel } from '../domain/types.js';
import type { TraceContext } from '../observability/tracing.js';
import { agentAsTool } from './agent-as-tool.js';
import { buildAnalystAgent, runAnalyst } from './analyst.js';
import { buildBetPlacementAgent, runBetPlacement } from './bet-placement.js';
import { createScopedAgent, type BuiltAgent } from './factory.js';
import { recordAnalystSuggestion } from '../services/betting.js';
import { confirmCodeFor } from '../services/betting.js';
import { stripSuggestionBlock } from './suggestion-parser.js';
import { TELEGRAM_PERSONA_PROMPT, WEB_PERSONA_PROMPT } from './prompts.js';

export interface PersonaBundle {
  persona: BuiltAgent;
  analyst: BuiltAgent;
  betPlacement: BuiltAgent;
}

const personaRoleFor = (channel: ClientChannel): AgentRole =>
  channel === 'telegram' ? 'telegram_persona' : 'web_persona';

const personaPromptFor = (channel: ClientChannel): string =>
  channel === 'telegram' ? TELEGRAM_PERSONA_PROMPT : WEB_PERSONA_PROMPT;

/**
 * Builds a front-end persona and the two specialists it delegates to.
 *
 * Both channels are built from the same function with the same specialist
 * builders. The only per-channel difference is the persona's system prompt —
 * tone and formatting. Betting behaviour is identical because it lives entirely
 * inside the Bet Placement Agent, which neither persona can bypass or reimplement.
 */
export async function buildPersona(ctx: TraceContext): Promise<PersonaBundle> {
  const analyst = buildAnalystAgent(ctx);
  const betPlacement = await buildBetPlacementAgent(ctx);

  const analystTool = agentAsTool(ctx, {
    name: 'analyst',
    description:
      'Ask the Analyst Agent about a match, a price, social/news chatter, or what looks worth betting on. Returns analysis and sometimes a proposed bet. It cannot place bets.',
    inputDescription:
      'The full analysis question, including any team, competition or market the user mentioned. The analyst does not see the conversation.',
    run: async (instruction) => {
      const result = await runAnalyst(analyst, ctx, instruction);
      if (!result.suggestion) return result.analysis;

      // The orchestrator — not the Analyst — persists the suggestion. The
      // Analyst produced structured data; deciding it becomes a durable, quotable
      // record is a privileged act that stays outside the untrusted-input agent.
      const stored = await recordAnalystSuggestion({
        userId: ctx.userId,
        channel: ctx.channel,
        traceId: ctx.traceId,
        marketId: result.suggestion.marketId,
        selectionId: result.suggestion.selectionId,
        suggestedStake: result.suggestion.suggestedStake,
        odds: result.suggestion.odds,
        confidence: result.suggestion.confidence,
        rationale: result.suggestion.rationale,
        source: result.suggestion.source,
      });
      ctx.suggestionId = stored.id;

      return [
        stripSuggestionBlock(result.analysis),
        '',
        `[analyst suggestion recorded] suggestionId=${stored.id} market=${stored.marketId} selection=${stored.selectionId} stake=${stored.suggestedStake} odds=${stored.odds} confidence=${stored.confidence}`,
        `This is a SUGGESTION ONLY — nothing has been bet. To act on it, pass suggestionId ${stored.id} to the bet_placement agent, which will quote it and ask the user to confirm (code ${confirmCodeFor(stored.id)}).`,
      ].join('\n');
    },
  });

  const betPlacementTool = agentAsTool(ctx, {
    name: 'bet_placement',
    description:
      'The single execution path for anything involving money: quoting a bet, checking whether the user confirmed, placing a confirmed bet, and looking up bet status. Enforces stake limits and requires explicit user confirmation. Use it for ALL betting actions — never reason about limits or confirmation yourself.',
    inputDescription:
      'What you need done, with every parameter the user gave: market, selection, stake, and any suggestion id or confirmation code. State clearly whether the user has already confirmed.',
    run: (instruction) => runBetPlacement(betPlacement, ctx, instruction),
  });

  const tools: StructuredToolInterface[] = [analystTool, betPlacementTool];

  const persona = createScopedAgent({
    role: personaRoleFor(ctx.channel),
    systemPrompt: personaPromptFor(ctx.channel),
    tools,
    temperature: 0.4,
    maxTokens: 1000,
    ...(env.PERSONA_MODEL ? { preferredModel: env.PERSONA_MODEL } : {}),
    getUserId: () => ctx.userId,
    getTraceId: () => ctx.traceId,
  });

  return { persona, analyst, betPlacement };
}
