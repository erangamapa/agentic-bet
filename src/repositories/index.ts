import { hasDatabase } from '../config/env.js';
import { logger } from '../observability/logger.js';
import { MemoryStore } from './memory-store.js';
import { PostgresStore } from './postgres-store.js';
import type { Store } from './store.js';

let instance: Store | null = null;

/**
 * Resolves the persistence layer once per process. Neon Postgres when
 * DATABASE_URL is set; otherwise an in-memory store so the system still boots
 * (dev/demo only — the warning is deliberately loud).
 */
export function getStore(): Store {
  if (instance) return instance;
  if (hasDatabase) {
    instance = new PostgresStore();
    logger.info({ component: 'store', kind: 'postgres' }, 'Using Neon Postgres store');
  } else {
    instance = new MemoryStore();
    logger.warn(
      { component: 'store', kind: 'memory' },
      'DATABASE_URL is not set — falling back to the in-memory store. Suggestions, executions and audit history will not survive a restart.',
    );
  }
  return instance;
}

/** Test hook: swap the store implementation. */
export function setStore(store: Store | null): void {
  instance = store;
}

export type { Store } from './store.js';
export { MemoryStore } from './memory-store.js';
export { PostgresStore } from './postgres-store.js';
