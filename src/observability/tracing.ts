import { randomUUID } from 'node:crypto';
import type { RunnableConfig } from '@langchain/core/runnables';
import { env, hasTracing } from '../config/env.js';
import type { AgentRole, ClientChannel } from '../domain/types.js';
import { logger } from './logger.js';

/**
 * LangSmith is configured through environment variables that the LangChain SDK
 * reads at call time. We set them from our own validated config so a single
 * source of truth (`env`) drives tracing, and we can hard-disable tracing when
 * no API key is present instead of letting the SDK fail per-request.
 */
export function initTracing(): void {
  if (hasTracing) {
    process.env.LANGSMITH_TRACING = 'true';
    process.env.LANGCHAIN_TRACING_V2 = 'true';
    process.env.LANGSMITH_API_KEY = env.LANGSMITH_API_KEY!;
    process.env.LANGSMITH_PROJECT = env.LANGSMITH_PROJECT;
    process.env.LANGSMITH_ENDPOINT = env.LANGSMITH_ENDPOINT;
    logger.info({ component: 'tracing', project: env.LANGSMITH_PROJECT }, 'LangSmith tracing enabled');
  } else {
    process.env.LANGSMITH_TRACING = 'false';
    process.env.LANGCHAIN_TRACING_V2 = 'false';
    logger.warn(
      { component: 'tracing' },
      'LangSmith tracing disabled (set LANGSMITH_TRACING=true and LANGSMITH_API_KEY to enable). Local audit log still captures every hop.',
    );
  }
}

export interface TraceContext {
  /** Correlates every agent hop, tool call and DB row for one user turn. */
  traceId: string;
  userId: string;
  channel: ClientChannel;
  sessionId: string;
  /** Set once an execution row exists, so traces are queryable by BetExecution.id. */
  executionId?: string;
  suggestionId?: string;
}

export function newTraceContext(input: {
  userId: string;
  channel: ClientChannel;
  sessionId?: string;
  traceId?: string;
}): TraceContext {
  return {
    traceId: input.traceId ?? `trace_${randomUUID()}`,
    userId: input.userId,
    channel: input.channel,
    sessionId: input.sessionId ?? `sess_${input.userId}_${input.channel}`,
  };
}

/**
 * Builds the RunnableConfig for an agent hop. Metadata (not just tags) carries
 * userId and executionId so LangSmith runs are filterable by both — that is the
 * requirement for adjudicating a "I never confirmed this bet" dispute.
 */
export function traceConfig(
  ctx: TraceContext,
  agentRole: AgentRole,
  extra: Partial<RunnableConfig> = {},
): RunnableConfig {
  const metadata: Record<string, unknown> = {
    trace_id: ctx.traceId,
    user_id: ctx.userId,
    channel: ctx.channel,
    session_id: ctx.sessionId,
    agent_role: agentRole,
  };
  if (ctx.executionId) metadata.execution_id = ctx.executionId;
  if (ctx.suggestionId) metadata.suggestion_id = ctx.suggestionId;

  const tags = [`role:${agentRole}`, `channel:${ctx.channel}`, `user:${ctx.userId}`];
  if (ctx.executionId) tags.push(`execution:${ctx.executionId}`);

  return {
    ...extra,
    runName: `${agentRole}_agent`,
    tags: [...tags, ...(extra.tags ?? [])],
    metadata: { ...metadata, ...(extra.metadata ?? {}) },
    configurable: { thread_id: ctx.sessionId, ...(extra.configurable ?? {}) },
  };
}

/** Direct link to the LangSmith project filtered by this trace id. */
export function traceUrl(traceId: string): string | null {
  if (!hasTracing) return null;
  const base = env.LANGSMITH_ENDPOINT.replace('api.smith', 'smith');
  return `${base}/o/-/projects/p/${encodeURIComponent(env.LANGSMITH_PROJECT)}?searchModel=%7B%22filter%22%3A%22eq(metadata.trace_id%2C%20%5C%22${traceId}%5C%22)%22%7D`;
}
