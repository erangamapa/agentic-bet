import { getStore } from '../repositories/index.js';
import { newId, type AgentRole, type AuditEvent, type AuditKind, type ClientChannel } from '../domain/types.js';
import { logger } from './logger.js';
import type { TraceContext } from './tracing.js';

export interface AuditInput {
  kind: AuditKind;
  userId?: string | null;
  executionId?: string | null;
  suggestionId?: string | null;
  agentRole?: AgentRole | null;
  channel?: ClientChannel | null;
  detail?: Record<string, unknown>;
  traceId?: string | null;
  runId?: string | null;
}

/**
 * Append-only record of everything the system decided or did. This is the local
 * counterpart to LangSmith: LangSmith holds the LLM reasoning, this holds the
 * authoritative business events (who confirmed what, what was broadcast, what
 * was reported to the user and when).
 *
 * Audit writes never throw into the caller — losing an audit row must not roll
 * back a bet — but a failure is logged at error level.
 */
export async function audit(input: AuditInput): Promise<AuditEvent> {
  const event: AuditEvent = {
    id: newId('aud'),
    userId: input.userId ?? null,
    executionId: input.executionId ?? null,
    suggestionId: input.suggestionId ?? null,
    agentRole: input.agentRole ?? null,
    channel: input.channel ?? null,
    kind: input.kind,
    detail: input.detail ?? {},
    traceId: input.traceId ?? null,
    runId: input.runId ?? null,
    createdAt: new Date(),
  };

  logger.info(
    {
      component: 'audit',
      kind: event.kind,
      userId: event.userId,
      executionId: event.executionId,
      agentRole: event.agentRole,
      traceId: event.traceId,
      ...event.detail,
    },
    `audit:${event.kind}`,
  );

  try {
    await getStore().appendAudit(event);
  } catch (err) {
    logger.error({ component: 'audit', err, kind: event.kind }, 'Failed to persist audit event');
  }
  return event;
}

/** Convenience wrapper that fills identity fields from a trace context. */
export function auditWith(ctx: TraceContext) {
  return (input: Omit<AuditInput, 'userId' | 'channel' | 'traceId'> & Partial<Pick<AuditInput, 'userId' | 'channel' | 'traceId'>>) =>
    audit({
      userId: ctx.userId,
      channel: ctx.channel,
      traceId: ctx.traceId,
      executionId: ctx.executionId ?? null,
      suggestionId: ctx.suggestionId ?? null,
      ...input,
    });
}
