import type { FastifyReply, FastifyRequest } from 'fastify';
import { env } from '../config/env.js';
import { getStore } from '../repositories/index.js';

declare module 'fastify' {
  interface FastifyRequest {
    userId: string;
  }
}

const PUBLIC_PATHS = new Set(['/health', '/api', '/api/architecture']);

/**
 * Minimal identity for the demo: a shared API key plus an `x-user-id` header.
 *
 * The important property is not the auth scheme — it is that `userId` is
 * established *here*, from the transport, and every downstream layer reads
 * `request.userId`. No agent, tool or request body can name a different user,
 * so a manipulated model cannot place a bet against someone else's account.
 * Swap this for real sessions/JWT without touching anything below it.
 */
export async function requireUser(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const path = request.routeOptions?.url ?? request.url;
  if (PUBLIC_PATHS.has(path) || !path.startsWith('/api')) return;

  if (env.WEB_API_KEY) {
    const provided = request.headers['x-api-key'];
    if (provided !== env.WEB_API_KEY) {
      await reply.status(401).send({ error: { code: 'unauthorized', message: 'Invalid or missing x-api-key' } });
      return;
    }
  }

  const headerUser = request.headers['x-user-id'];
  const userId = typeof headerUser === 'string' && headerUser.trim() ? headerUser.trim() : 'usr_demo';
  request.userId = userId;

  // Auto-provision so a fresh browser session works without a signup flow.
  const store = getStore();
  const existing = await store.getUser(userId);
  if (!existing) {
    await store.upsertUser({
      id: userId,
      displayName: userId,
      walletAddress: null,
      telegramId: null,
      limitsOverride: null,
    });
  }
}
