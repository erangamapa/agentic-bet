import { HumanMessage, type BaseMessage } from '@langchain/core/messages';
import { buildPersona } from '../agents/personas.js';
import { renderContent } from '../agents/analyst.js';
import type { ClientChannel } from '../domain/types.js';
import { audit } from '../observability/audit.js';
import { logger } from '../observability/logger.js';
import { newTraceContext, traceConfig, traceUrl, type TraceContext } from '../observability/tracing.js';
import { getSession, recordTurn } from './session.js';

export interface TurnInput {
  userId: string;
  channel: ClientChannel;
  message: string;
  sessionId?: string;
}

export interface TurnResult {
  reply: string;
  traceId: string;
  traceUrl: string | null;
  sessionId: string;
  executionId: string | null;
  suggestionId: string | null;
}

/**
 * One user turn through the agent graph.
 *
 *   user message
 *     -> front-end persona (web or telegram)
 *        -> analyst        (agent-as-tool, read clearance)
 *        -> bet_placement  (agent-as-tool, the only execute clearance)
 *
 * The entry point is identical for every channel. `channel` selects the persona
 * prompt and nothing else, which is what makes "web and Telegram behave the
 * same for equivalent input" a property of the code rather than a test result.
 */
export async function runTurn(input: TurnInput): Promise<TurnResult> {
  const ctx: TraceContext = newTraceContext({
    userId: input.userId,
    channel: input.channel,
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
  });

  const session = getSession(ctx.sessionId);
  const bundle = await buildPersona(ctx);

  await audit({
    kind: 'agent_invoked',
    agentRole: bundle.persona.role,
    userId: ctx.userId,
    channel: ctx.channel,
    traceId: ctx.traceId,
    detail: {
      message: input.message.slice(0, 500),
      tools: bundle.persona.toolNames,
      toolSchemaTokens: bundle.persona.toolSchemaTokens,
      historyTurns: session.messages.length,
    },
  });

  const messages: BaseMessage[] = [...session.messages, new HumanMessage(input.message)];

  try {
    const result = await bundle.persona.agent.invoke(
      { messages },
      traceConfig(ctx, bundle.persona.role, {
        callbacks: [bundle.persona.usageHandler],
        recursionLimit: 16,
      }),
    );

    const out = (result as { messages?: { content?: unknown }[] }).messages ?? [];
    const reply = renderContent(out[out.length - 1]?.content) || 'I could not produce a reply for that.';

    recordTurn(ctx.sessionId, input.message, reply);

    await audit({
      kind: 'agent_completed',
      agentRole: bundle.persona.role,
      userId: ctx.userId,
      channel: ctx.channel,
      traceId: ctx.traceId,
      executionId: ctx.executionId ?? null,
      suggestionId: ctx.suggestionId ?? null,
      detail: { replyChars: reply.length },
    });

    return {
      reply,
      traceId: ctx.traceId,
      traceUrl: traceUrl(ctx.traceId),
      sessionId: ctx.sessionId,
      executionId: ctx.executionId ?? null,
      suggestionId: ctx.suggestionId ?? null,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ component: 'graph', err: message, traceId: ctx.traceId }, 'Turn failed');
    await audit({
      kind: 'agent_failed',
      agentRole: bundle.persona.role,
      userId: ctx.userId,
      channel: ctx.channel,
      traceId: ctx.traceId,
      detail: { error: message },
    });
    throw err;
  }
}

export { buildPersona } from '../agents/personas.js';
