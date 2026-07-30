import type { FastifyInstance } from 'fastify';
import { getStore } from '../../repositories/index.js';

export async function registerMarketRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: { sport?: string; q?: string } }>('/api/markets', async (request, reply) => {
    const markets = await getStore().listMarkets({
      ...(request.query.sport ? { sport: request.query.sport } : {}),
      ...(request.query.q ? { query: request.query.q } : {}),
    });
    return reply.send({ markets });
  });

  app.get<{ Params: { id: string } }>('/api/markets/:id', async (request, reply) => {
    const market = await getStore().getMarket(request.params.id);
    if (!market) return reply.status(404).send({ error: { code: 'not_found', message: 'Unknown market' } });
    return reply.send(market);
  });
}
