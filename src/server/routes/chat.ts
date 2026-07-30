import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { runTurn } from '../../graph/index.js';
import { clearSession } from '../../graph/session.js';

const chatBody = z.object({
  message: z.string().min(1).max(4000),
  sessionId: z.string().optional(),
});

export async function registerChatRoutes(app: FastifyInstance): Promise<void> {
  /**
   * The web client's only conversational entry point. It carries no betting
   * logic — it hands the message to the same agent graph the Telegram bot uses.
   */
  app.post('/api/chat', async (request, reply) => {
    const parsed = chatBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: { code: 'bad_request', message: 'message is required' } });
    }

    const result = await runTurn({
      userId: request.userId,
      channel: 'web',
      message: parsed.data.message,
      ...(parsed.data.sessionId ? { sessionId: parsed.data.sessionId } : {}),
    });

    return reply.send(result);
  });

  app.post('/api/chat/reset', async (request, reply) => {
    const sessionId = (request.body as { sessionId?: string } | undefined)?.sessionId ?? `sess_${request.userId}_web`;
    clearSession(sessionId);
    return reply.send({ ok: true, sessionId });
  });
}
