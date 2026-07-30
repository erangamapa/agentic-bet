import { demoContent, demoMarkets } from '../src/data/fixtures.js';
import { MemoryStore, setStore } from '../src/repositories/index.js';
import { setExecutor } from '../src/chain/executor.js';

export const TEST_USER = 'usr_test';

/** Fresh store + default stub executor for each test. */
export async function resetWorld(): Promise<MemoryStore> {
  const store = new MemoryStore();
  setStore(store);
  setExecutor(null);
  await store.upsertMarkets(demoMarkets);
  await store.upsertContent(demoContent);
  await store.upsertUser({
    id: TEST_USER,
    displayName: 'Test User',
    walletAddress: null,
    telegramId: null,
    limitsOverride: null,
  });
  return store;
}
