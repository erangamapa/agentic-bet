import { hasDatabase } from '../config/env.js';
import { demoContent, demoMarkets } from '../data/fixtures.js';
import { logger } from '../observability/logger.js';
import { getStore } from '../repositories/index.js';
import { migrate } from './migrate.js';

/**
 * Idempotent demo data. Runs on server boot so a clone-and-run works with no
 * setup; safe to run repeatedly because both upserts are conflict-tolerant.
 */
export async function ensureSeedData(): Promise<void> {
  const store = getStore();

  if (hasDatabase) {
    await migrate();
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
