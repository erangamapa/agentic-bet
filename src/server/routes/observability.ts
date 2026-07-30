import type { FastifyInstance } from 'fastify';
import { getStore } from '../../repositories/index.js';
import { traceUrl } from '../../observability/tracing.js';
import { registeredToolClearances, roleClearance } from '../../agents/privilege.js';
import { env } from '../../config/env.js';

export async function registerObservabilityRoutes(app: FastifyInstance): Promise<void> {
  /**
   * Dispute resolution endpoint. Given a userId or an execution id, returns the
   * full ordered event chain — including whether a confirmation was ever
   * created, by which channel, and when success was reported. This is what
   * answers "I never confirmed that bet" with evidence rather than opinion.
   */
  app.get<{ Querystring: { executionId?: string; limit?: string } }>('/api/audit', async (request, reply) => {
    const limit = Math.min(Number(request.query.limit ?? 100) || 100, 500);
    const events = await getStore().listAudit({
      userId: request.userId,
      ...(request.query.executionId ? { executionId: request.query.executionId } : {}),
      limit,
    });

    return reply.send({
      count: events.length,
      events: events.map((e) => ({
        id: e.id,
        kind: e.kind,
        agentRole: e.agentRole,
        channel: e.channel,
        executionId: e.executionId,
        suggestionId: e.suggestionId,
        traceId: e.traceId,
        traceUrl: e.traceId ? traceUrl(e.traceId) : null,
        detail: e.detail,
        createdAt: e.createdAt,
      })),
    });
  });

  /** Token cost per agent role — the Section 2 cost-control metric. */
  app.get<{ Querystring: { sinceHours?: string; allUsers?: string } }>('/api/usage', async (request, reply) => {
    const sinceHours = Number(request.query.sinceHours ?? 24) || 24;
    const since = new Date(Date.now() - sinceHours * 3_600_000);
    const rows = await getStore().aggregateTokenUsage({
      ...(request.query.allUsers === 'true' ? {} : { userId: request.userId }),
      since,
    });

    const total = rows.reduce((sum, r) => sum + r.totalTokens, 0);
    return reply.send({
      sinceHours,
      totalTokens: total,
      byRole: rows.map((r) => ({
        ...r,
        shareOfTotal: total > 0 ? Number((r.totalTokens / total).toFixed(4)) : 0,
        avgTokensPerCall: r.calls > 0 ? Math.round(r.totalTokens / r.calls) : 0,
      })),
    });
  });

  /**
   * Machine-readable statement of the privilege boundary. Useful in review and
   * in CI: an assertion that `analyst` never appears against an `execute` tool
   * is a one-line check against this payload.
   */
  app.get('/api/architecture', async (_request, reply) => {
    const tools = [...registeredToolClearances().entries()].map(([name, clearance]) => ({ name, clearance }));
    return reply.send({
      executionMode: env.EXECUTION_MODE,
      roles: Object.entries(roleClearance).map(([role, clearance]) => ({
        role,
        clearance,
        canExecute: clearance === 'execute',
        readsUntrustedContent: role === 'analyst',
      })),
      tools,
      invariants: [
        'Only the bet_placement role may hold execute-clearance tools.',
        'The analyst role reads untrusted content and is capped at read clearance.',
        'Web and Telegram personas hold delegate-clearance tools only; both call the same bet_placement agent.',
        'No execution reports success unless the transaction was verified on-chain.',
      ],
    });
  });
}
