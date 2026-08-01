import { hasDatabase, runMigrationsOnBoot, seedDemoData } from '../config/env.js';
import { demoContent, demoMarkets } from '../data/fixtures.js';
import { logger } from '../observability/logger.js';
import { getStore } from '../repositories/index.js';
import { migrate } from './migrate.js';

/**
 * Boot-time data preparation.
 *
 * Both steps are opt-out in production: applying schema on every cold start is
 * wasted work when the deploy pipeline already ran it, and demo fixtures must
 * never appear in a real book. Locally both default on, so a fresh clone runs
 * with no setup.
 */
export async function ensureSeedData(): Promise<void> {
  const store = getStore();

  if (hasDatabase && runMigrationsOnBoot) {
    await migrate();
  }

  if (!seedDemoData) {
    logger.info({ component: 'seed', store: store.kind }, 'Demo seeding disabled');
    return;
  }

  await store.upsertMarkets(demoMarkets);
  await store.upsertContent(demoContent);
  await store.upsertUser({
    id: 'usr_demo',
    displayName: 'Demo User',
    walletAddress: null,
    telegramId: null,
    limitsOverride: null,
  });

  logger.info(
    { component: 'seed', markets: demoMarkets.length, content: demoContent.length, store: store.kind },
    'Seed data ensured',
  );
}

const invokedDirectly = process.argv[1]?.includes('seed');
if (invokedDirectly) {
  ensureSeedData()
    .then(() => process.exit(0))
    .catch((err) => {
      logger.fatal({ err }, 'Seed failed');
      process.exit(1);
    });
}
