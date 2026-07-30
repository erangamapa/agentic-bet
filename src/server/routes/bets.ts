import type { FastifyInstance } from 'fastify';
import { newTraceContext } from '../../observability/tracing.js';
import { requestExecutionGrant } from '../../agents/privilege.js';
import {
  confirmCodeFor,
  confirmSuggestion,
  dismissSuggestion,
  getExecutionStatus,
  listPendingSuggestions,
  listUserExecutions,
  placeConfirmedBet,
} from '../../services/betting.js';

export async function registerBetRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/suggestions', async (request, reply) => {
    const suggestions = await listPendingSuggestions(request.userId, 20);
    return reply.send({
      suggestions: suggestions.map((s) => ({
        id: s.id,
        confirmCode: confirmCodeFor(s.id),
        marketId: s.marketId,
        selectionId: s.selectionId,
        stake: s.suggestedStake,
        odds: s.odds,
        potentialReturn: Math.round(s.suggestedStake * s.odds * 100) / 100,
        confidence: s.confidence,
        rationale: s.rationale,
        source: s.source,
        status: s.status,
        createdAt: s.createdAt,
        expiresAt: s.expiresAt,
      })),
    });
  });

  /**
   * The UI's Confirm button. This is the *other* half of the confirmation flow —
   * the Telegram `/confirm` command hits the same service function, so both
   * channels create identical confirmation records and neither can loosen the
   * requirement on its own.
   */
  app.post<{ Params: { id: string } }>('/api/suggestions/:id/confirm', async (request, reply) => {
    const { confirmation, suggestion } = await confirmSuggestion({
      userId: request.userId,
      suggestionOrCode: request.params.id,
      channel: 'web',
    });
    return reply.send({
      confirmed: true,
      confirmationId: confirmation.id,
      suggestionId: suggestion.id,
      expiresAt: confirmation.expiresAt,
      next: 'Ask the assistant to place it, or POST /api/suggestions/:id/place',
    });
  });

  app.post<{ Params: { id: string } }>('/api/suggestions/:id/dismiss', async (request, reply) => {
    await dismissSuggestion(request.userId, request.params.id);
    return reply.send({ dismissed: true });
  });

  /**
   * Direct placement path for a confirmed bet, for clients that want a button
   * rather than a chat turn. It calls exactly the same privileged service the
   * Bet Placement Agent's tool calls — same limits, same confirmation gate,
   * same verify-before-success rule. No shortcut exists.
   */
  app.post<{ Params: { id: string } }>('/api/suggestions/:id/place', async (request, reply) => {
    const ctx = newTraceContext({ userId: request.userId, channel: 'web' });
    const outcome = await placeConfirmedBet(requestExecutionGrant('bet_placement'), {
      userId: request.userId,
      suggestionOrCode: request.params.id,
      channel: 'web',
      ctx,
    });
    const status = outcome.status === 'confirmed' ? 200 : outcome.status === 'pending' ? 202 : 422;
    return reply.status(status).send(outcome);
  });

  app.get('/api/bets', async (request, reply) => {
    const executions = await listUserExecutions(request.userId, 25);
    return reply.send({
      bets: executions.map((e) => ({
        executionId: e.id,
        marketId: e.marketId,
        selectionId: e.selectionId,
        stake: e.stake,
        odds: e.odds,
        txStatus: e.txStatus,
        txHash: e.txHash,
        blockNumber: e.blockNumber,
        // Present so a client can render "placed" strictly from confirmed state.
        reportedToUserAt: e.reportedToUserAt,
        failureReason: e.failureReason,
        channel: e.channel,
        traceId: e.traceId,
        createdAt: e.createdAt,
      })),
    });
  });

  app.get<{ Params: { executionId: string } }>('/api/bets/:executionId', async (request, reply) => {
    const execution = await getExecutionStatus(request.userId, request.params.executionId);
    return reply.send(execution);
  });
}
