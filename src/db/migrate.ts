import { hasDatabase } from '../config/env.js';
import { logger } from '../observability/logger.js';
import { getSql } from './client.js';

/**
 * Schema bootstrap.
 *
 * `drizzle-kit generate` produces versioned SQL in ./drizzle for real migration
 * history; this script applies the current schema directly with IF NOT EXISTS
 * so a fresh Neon branch is usable in one command. Both paths agree because
 * both derive from src/db/schema.ts.
 */
const statements: string[] = [
  `CREATE TABLE IF NOT EXISTS users (
     id text PRIMARY KEY,
     display_name text NOT NULL,
     wallet_address text,
     telegram_id text,
     limits_override jsonb,
     created_at timestamptz NOT NULL DEFAULT now()
   )`,

  `CREATE TABLE IF NOT EXISTS markets (
     id text PRIMARY KEY,
     sport text NOT NULL,
     competition text NOT NULL,
     home_team text NOT NULL,
     away_team text NOT NULL,
     starts_at timestamptz NOT NULL,
     status text NOT NULL DEFAULT 'open',
     selections jsonb NOT NULL,
     updated_at timestamptz NOT NULL DEFAULT now()
   )`,

  `CREATE TABLE IF NOT EXISTS suggestions (
     id text PRIMARY KEY,
     user_id text NOT NULL,
     market_id text NOT NULL,
     selection_id text NOT NULL,
     suggested_stake double precision NOT NULL,
     odds double precision NOT NULL,
     confidence double precision NOT NULL DEFAULT 0.5,
     rationale text NOT NULL,
     source text NOT NULL,
     status text NOT NULL DEFAULT 'suggested',
     trace_id text,
     created_at timestamptz NOT NULL DEFAULT now(),
     expires_at timestamptz
   )`,
  `CREATE INDEX IF NOT EXISTS suggestions_user_idx ON suggestions (user_id)`,
  `CREATE INDEX IF NOT EXISTS suggestions_status_idx ON suggestions (status)`,

  `CREATE TABLE IF NOT EXISTS confirmations (
     id text PRIMARY KEY,
     user_id text NOT NULL,
     intent_hash text NOT NULL,
     suggestion_id text,
     channel text NOT NULL,
     created_at timestamptz NOT NULL DEFAULT now(),
     expires_at timestamptz NOT NULL,
     consumed_at timestamptz,
     consumed_by_execution_id text
   )`,
  `CREATE INDEX IF NOT EXISTS confirmations_lookup_idx ON confirmations (user_id, intent_hash)`,

  `CREATE TABLE IF NOT EXISTS bet_executions (
     id text PRIMARY KEY,
     suggestion_id text,
     user_id text NOT NULL,
     market_id text NOT NULL,
     selection_id text NOT NULL,
     stake double precision NOT NULL,
     odds double precision NOT NULL,
     tx_status text NOT NULL DEFAULT 'pending',
     tx_hash text,
     block_number integer,
     reported_to_user_at timestamptz,
     failure_reason text,
     channel text NOT NULL,
     confirmation_id text,
     intent_hash text NOT NULL,
     idempotency_key text NOT NULL,
     trace_id text,
     created_at timestamptz NOT NULL DEFAULT now(),
     updated_at timestamptz NOT NULL DEFAULT now()
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS bet_executions_idempotency_idx ON bet_executions (idempotency_key)`,
  `CREATE INDEX IF NOT EXISTS bet_executions_user_idx ON bet_executions (user_id)`,
  `CREATE INDEX IF NOT EXISTS bet_executions_status_idx ON bet_executions (tx_status)`,

  // Enforces the "never report success before confirmation" rule at the storage
  // layer, so it holds even against a direct SQL write that bypasses the service.
  `ALTER TABLE bet_executions DROP CONSTRAINT IF EXISTS bet_executions_report_requires_confirmed`,
  `ALTER TABLE bet_executions ADD CONSTRAINT bet_executions_report_requires_confirmed
     CHECK (reported_to_user_at IS NULL OR tx_status = 'confirmed')`,

  `CREATE TABLE IF NOT EXISTS audit_events (
     id text PRIMARY KEY,
     user_id text,
     execution_id text,
     suggestion_id text,
     agent_role text,
     channel text,
     kind text NOT NULL,
     detail jsonb NOT NULL DEFAULT '{}'::jsonb,
     trace_id text,
     run_id text,
     created_at timestamptz NOT NULL DEFAULT now()
   )`,
  `CREATE INDEX IF NOT EXISTS audit_user_idx ON audit_events (user_id)`,
  `CREATE INDEX IF NOT EXISTS audit_execution_idx ON audit_events (execution_id)`,
  `CREATE INDEX IF NOT EXISTS audit_kind_idx ON audit_events (kind)`,

  `CREATE TABLE IF NOT EXISTS token_usage (
     id text PRIMARY KEY,
     agent_role text NOT NULL,
     model text NOT NULL,
     provider text NOT NULL,
     input_tokens integer NOT NULL DEFAULT 0,
     output_tokens integer NOT NULL DEFAULT 0,
     total_tokens integer NOT NULL DEFAULT 0,
     tool_schema_tokens integer NOT NULL DEFAULT 0,
     user_id text,
     trace_id text,
     created_at timestamptz NOT NULL DEFAULT now()
   )`,
  `CREATE INDEX IF NOT EXISTS token_usage_role_idx ON token_usage (agent_role)`,
  `CREATE INDEX IF NOT EXISTS token_usage_user_idx ON token_usage (user_id)`,

  `CREATE TABLE IF NOT EXISTS content_items (
     id text PRIMARY KEY,
     source text NOT NULL,
     author text,
     body text NOT NULL,
     market_id text,
     sanitised boolean NOT NULL DEFAULT false,
     published_at timestamptz NOT NULL DEFAULT now()
   )`,
  `CREATE INDEX IF NOT EXISTS content_market_idx ON content_items (market_id)`,
];

export async function migrate(): Promise<void> {
  if (!hasDatabase) {
    logger.warn({ component: 'migrate' }, 'DATABASE_URL is not set — nothing to migrate');
    return;
  }
  const sql = getSql();
  for (const statement of statements) {
    await sql.query(statement);
  }
  logger.info({ component: 'migrate', statements: statements.length }, 'Schema applied');
}

const invokedDirectly = process.argv[1]?.includes('migrate');
if (invokedDirectly) {
  migrate()
    .then(() => process.exit(0))
    .catch((err) => {
      logger.fatal({ err }, 'Migration failed');
      process.exit(1);
    });
}
