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
  });

  await app.register(cors, { origin: true });

  await app.register(fastifyStatic, {
    root: join(here, '../../public'),
    prefix: '/',
  });

  // The action endpoints (confirm / dismiss / place) take no body, but clients
  // routinely send `content-type: application/json` on every POST. Fastify's
  // default parser rejects that combination outright, so treat an empty body as
  // an empty object rather than a 400 the caller cannot act on.
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_request, body, done) => {
    const raw = typeof body === 'string' ? body.trim() : '';
    if (!raw) return done(null, {});
    try {
      done(null, JSON.parse(raw));
    } catch {
      done(new AppError('bad_request', 'Request body is not valid JSON'), undefined);
    }
  });

  app.setErrorHandler((err, request, reply) => {
    if (err instanceof AppError) {
      request.log.warn({ code: err.code, detail: err.detail }, err.message);
      return reply.status(err.httpStatus).send({ error: { code: err.code, message: err.message, detail: err.detail } });
    }
    // Framework errors (validation, payload limits) carry their own status —
    // collapsing them to 500 would tell the client to retry an unfixable request.
    const framework = err as { statusCode?: number; code?: string; message?: string };
    const status =
      typeof framework.statusCode === 'number' && framework.statusCode >= 400 && framework.statusCode < 500
        ? framework.statusCode
        : 500;

    if (status >= 500) request.log.error({ err }, 'Unhandled error');
    else request.log.warn({ err: framework.message, code: framework.code }, 'Request rejected');

    return reply.status(status).send({
      error: {
        code: framework.code ?? (status >= 500 ? 'internal_error' : 'bad_request'),
        message: status >= 500 ? 'Something went wrong' : (framework.message ?? 'Bad request'),
      },
    });
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
