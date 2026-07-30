import { neon } from '@neondatabase/serverless';
import { drizzle, type NeonHttpDatabase } from 'drizzle-orm/neon-http';
import { env, hasDatabase } from '../config/env.js';
import { logger } from '../observability/logger.js';
import { schema } from './schema.js';

export type Database = NeonHttpDatabase<typeof schema>;

let cached: Database | null = null;

/**
 * Neon serverless HTTP driver. HTTP (rather than the WebSocket pool) is the right
 * default here: every query in this system is a short, independent statement issued
 * from a request- or agent-scoped context, so there is no long-lived session to keep.
 */
export function getDb(): Database {
  if (!hasDatabase) {
    throw new Error('DATABASE_URL is not configured — the in-memory store should be used instead.');
  }
  if (cached) return cached;
  const sql = neon(env.DATABASE_URL!);
  cached = drizzle(sql, { schema });
  logger.debug({ component: 'db' }, 'Neon Postgres client initialised');
  return cached;
}

/** Raw tagged-template client, for migrations and multi-statement DDL. */
export function getSql() {
  if (!hasDatabase) throw new Error('DATABASE_URL is not configured.');
  return neon(env.DATABASE_URL!);
}
