import { HumanMessage } from '@langchain/core/messages';
import { env } from '../config/env.js';
import type { BetSuggestionInput } from '../domain/types.js';
import { audit } from '../observability/audit.js';
import { logger } from '../observability/logger.js';
import { traceConfig, type TraceContext } from '../observability/tracing.js';
import { buildAnalystTools } from '../tools/analyst-tools.js';
import { createScopedAgent, type BuiltAgent } from './factory.js';
import { ANALYST_SYSTEM_PROMPT } from './prompts.js';
import { extractSuggestion } from './suggestion-parser.js';

export interface AnalystResult {
  analysis: string;
  suggestion: BetSuggestionInput | null;
}

/**
 * The Analyst Agent — the only agent that reads untrusted third-party content,
 * and therefore the one deliberately kept at `read` clearance. It produces a
 * structured suggestion; it cannot act on it.
 */
export function buildAnalystAgent(ctx: TraceContext): BuiltAgent {
  return createScopedAgent({
    role: 'analyst',
    systemPrompt: ANALYST_SYSTEM_PROMPT,
    tools: buildAnalystTools(ctx),
    temperature: 0.3,
    maxTokens: 1500,
    ...(env.PRIMARY_MODEL ? { preferredModel: env.PRIMARY_MODEL } : {}),
    getUserId: () => ctx.userId,
    getTraceId: () => ctx.traceId,
  });
}

export async function runAnalyst(built: BuiltAgent, ctx: TraceContext, question: string): Promise<AnalystResult> {
  await audit({
    kind: 'agent_invoked',
    agentRole: 'analyst',
    userId: ctx.userId,
    channel: ctx.channel,
    traceId: ctx.traceId,
    detail: { question: truncate(question, 500), tools: built.toolNames, toolSchemaTokens: built.toolSchemaTokens },
  });

  try {
    const result = await built.agent.invoke(
      { messages: [new HumanMessage(question)] },
      traceConfig(ctx, 'analyst', { callbacks: [built.usageHandler], recursionLimit: 12 }),
    );

    const messages = (result as { messages?: { content?: unknown }[] }).messages ?? [];
    const last = messages[messages.length - 1];
    const analysis = renderContent(last?.content);
    const suggestion = extractSuggestion(analysis);

    await audit({
      kind: 'agent_completed',
      agentRole: 'analyst',
      userId: ctx.userId,
      channel: ctx.channel,
      traceId: ctx.traceId,
      detail: {
        producedSuggestion: Boolean(suggestion),
        ...(suggestion ? { marketId: suggestion.marketId, selectionId: suggestion.selectionId } : {}),
        analysisChars: analysis.length,
      },
    });

    return { analysis, suggestion };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ component: 'analyst', err: message, traceId: ctx.traceId }, 'Analyst run failed');
    await audit({
      kind: 'agent_failed',
      agentRole: 'analyst',
      userId: ctx.userId,
      channel: ctx.channel,
      traceId: ctx.traceId,
      detail: { error: message },
    });
    throw err;
  }
}

export function renderContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        if (typeof block === 'string') return block;
        if (block && typeof block === 'object' && 'text' in block) return String((block as { text: unknown }).text);
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }
  return '';
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}…`;
}
