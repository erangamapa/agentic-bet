import type { FastifyInstance } from 'fastify';
import { env, hasDatabase, hasLlm, hasTracing } from '../../config/env.js';
import { describeModelChain } from '../../llm/models.js';
import { getStore } from '../../repositories/index.js';
import { sessionCount } from '../../graph/session.js';

export async function registerHealthRoutes(app: FastifyInstance): Promise<void> {
  app.get('/health', async (_request, reply) => {
    const models = describeModelChain();
    return reply.send({
      status: 'ok',
      nodeEnv: env.NODE_ENV,
      store: getStore().kind,
      database: hasDatabase ? 'neon' : 'in-memory (DATABASE_URL not set)',
      llm: hasLlm ? models : 'not configured',
      tracing: hasTracing ? { provider: 'langsmith', project: env.LANGSMITH_PROJECT } : 'disabled',
      executionMode: env.EXECUTION_MODE,
      chainId: env.CHAIN_ID,
      activeSessions: sessionCount(),
    });
  });
}
