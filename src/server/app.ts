import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import { env } from '../config/env.js';
import { AppError } from '../domain/errors.js';
import { logger } from '../observability/logger.js';
import { registerBetRoutes } from './routes/bets.js';
import { registerChatRoutes } from './routes/chat.js';
import { registerHealthRoutes } from './routes/health.js';
import { registerObservabilityRoutes } from './routes/observability.js';
import { registerMarketRoutes } from './routes/markets.js';
import { requireUser } from './auth.js';

const here = dirname(fileURLToPath(import.meta.url));

export async function buildApp(): Promise<FastifyInstance> {
  // Cast: pino's concrete Logger type is narrower than FastifyBaseLogger, which
  // otherwise leaks the specialisation into every route module's signature.
  const app: FastifyInstance = Fastify({
    loggerInstance: logger as unknown as FastifyBaseLogger,
    disableRequestLogging: false,
  });

  await app.register(cors, { origin: true });

  await app.register(fastifyStatic, {
    root: join(here, '../../public'),
    prefix: '/',
  });

  app.setErrorHandler((err, request, reply) => {
    if (err instanceof AppError) {
      request.log.warn({ code: err.code, detail: err.detail }, err.message);
      return reply.status(err.httpStatus).send({ error: { code: err.code, message: err.message, detail: err.detail } });
    }
    request.log.error({ err }, 'Unhandled error');
    return reply.status(500).send({ error: { code: 'internal_error', message: 'Something went wrong' } });
  });

  // Identity is resolved once, before any route body runs, so no route can
  // accidentally trust a userId supplied in a request body.
  app.decorateRequest('userId', '');
  app.addHook('preHandler', requireUser);

  await registerHealthRoutes(app);
  await registerChatRoutes(app);
  await registerBetRoutes(app);
  await registerMarketRoutes(app);
  await registerObservabilityRoutes(app);

  app.get('/api', async () => ({
    service: 'agentic-bet',
    endpoints: [
      'POST /api/chat',
      'GET  /api/markets',
      'GET  /api/suggestions',
      'POST /api/suggestions/:id/confirm',
      'POST /api/suggestions/:id/dismiss',
      'GET  /api/bets',
      'GET  /api/bets/:executionId',
      'GET  /api/audit',
      'GET  /api/usage',
      'GET  /api/architecture',
      'GET  /health',
    ],
    executionMode: env.EXECUTION_MODE,
  }));

  return app;
}
