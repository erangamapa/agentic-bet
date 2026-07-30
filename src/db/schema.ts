import {
  boolean,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

export const users = pgTable('users', {
  id: text('id').primaryKey(),
  displayName: text('display_name').notNull(),
  walletAddress: text('wallet_address'),
  telegramId: text('telegram_id'),
  limitsOverride: jsonb('limits_override').$type<Record<string, number> | null>(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const markets = pgTable('markets', {
  id: text('id').primaryKey(),
  sport: text('sport').notNull(),
  competition: text('competition').notNull(),
  homeTeam: text('home_team').notNull(),
  awayTeam: text('away_team').notNull(),
  startsAt: timestamp('starts_at', { withTimezone: true }).notNull(),
  status: text('status').notNull().default('open'),
  selections: jsonb('selections').$type<{ id: string; label: string; odds: number }[]>().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const suggestions = pgTable(
  'suggestions',
  {
    id: text('id').primaryKey(),
    userId: text('user_id').notNull(),
    marketId: text('market_id').notNull(),
    selectionId: text('selection_id').notNull(),
    suggestedStake: doublePrecision('suggested_stake').notNull(),
    odds: doublePrecision('odds').notNull(),
    confidence: doublePrecision('confidence').notNull().default(0.5),
    rationale: text('rationale').notNull(),
    source: text('source').notNull(),
    status: text('status').notNull().default('suggested'),
    traceId: text('trace_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
  },
  (t) => [index('suggestions_user_idx').on(t.userId), index('suggestions_status_idx').on(t.status)],
);

export const confirmations = pgTable(
  'confirmations',
  {
    id: text('id').primaryKey(),
    userId: text('user_id').notNull(),
    intentHash: text('intent_hash').notNull(),
    suggestionId: text('suggestion_id'),
    channel: text('channel').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    consumedByExecutionId: text('consumed_by_execution_id'),
  },
  (t) => [index('confirmations_lookup_idx').on(t.userId, t.intentHash)],
);

export const betExecutions = pgTable(
  'bet_executions',
  {
    id: text('id').primaryKey(),
    suggestionId: text('suggestion_id'),
    userId: text('user_id').notNull(),
    marketId: text('market_id').notNull(),
    selectionId: text('selection_id').notNull(),
    stake: doublePrecision('stake').notNull(),
    odds: doublePrecision('odds').notNull(),
    txStatus: text('tx_status').notNull().default('pending'),
    txHash: text('tx_hash'),
    blockNumber: integer('block_number'),
    reportedToUserAt: timestamp('reported_to_user_at', { withTimezone: true }),
    failureReason: text('failure_reason'),
    channel: text('channel').notNull(),
    confirmationId: text('confirmation_id'),
    intentHash: text('intent_hash').notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    traceId: text('trace_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('bet_executions_idempotency_idx').on(t.idempotencyKey),
    index('bet_executions_user_idx').on(t.userId),
    index('bet_executions_status_idx').on(t.txStatus),
  ],
);

export const auditEvents = pgTable(
  'audit_events',
  {
    id: text('id').primaryKey(),
    userId: text('user_id'),
    executionId: text('execution_id'),
    suggestionId: text('suggestion_id'),
    agentRole: text('agent_role'),
    channel: text('channel'),
    kind: text('kind').notNull(),
    detail: jsonb('detail').$type<Record<string, unknown>>().notNull().default({}),
    traceId: text('trace_id'),
    runId: text('run_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('audit_user_idx').on(t.userId),
    index('audit_execution_idx').on(t.executionId),
    index('audit_kind_idx').on(t.kind),
  ],
);

export const tokenUsage = pgTable(
  'token_usage',
  {
    id: text('id').primaryKey(),
    agentRole: text('agent_role').notNull(),
    model: text('model').notNull(),
    provider: text('provider').notNull(),
    inputTokens: integer('input_tokens').notNull().default(0),
    outputTokens: integer('output_tokens').notNull().default(0),
    totalTokens: integer('total_tokens').notNull().default(0),
    toolSchemaTokens: integer('tool_schema_tokens').notNull().default(0),
    userId: text('user_id'),
    traceId: text('trace_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('token_usage_role_idx').on(t.agentRole), index('token_usage_user_idx').on(t.userId)],
);

/** Untrusted social/news content the Analyst reads. Stored so traces can be replayed. */
export const contentItems = pgTable(
  'content_items',
  {
    id: text('id').primaryKey(),
    source: text('source').notNull(),
    author: text('author'),
    body: text('body').notNull(),
    marketId: text('market_id'),
    /** Flag set by the sanitiser when injection-looking patterns were stripped. */
    sanitised: boolean('sanitised').notNull().default(false),
    publishedAt: timestamp('published_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('content_market_idx').on(t.marketId)],
);

export const schema = {
  users,
  markets,
  suggestions,
  confirmations,
  betExecutions,
  auditEvents,
  tokenUsage,
  contentItems,
};
