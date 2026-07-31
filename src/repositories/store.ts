import type {
  AuditEvent,
  BetExecution,
  Confirmation,
  Market,
  Suggestion,
  TokenUsageRecord,
  User,
} from '../domain/types.js';

export interface ContentItem {
  id: string;
  source: string;
  author: string | null;
  body: string;
  marketId: string | null;
  sanitised: boolean;
  publishedAt: Date;
}

export interface DailyStakeSummary {
  totalStake: number;
  betCount: number;
}

/**
 * Persistence contract. Two implementations exist: Neon Postgres (production)
 * and an in-memory store (used when DATABASE_URL is absent, so the whole system
 * still boots and can be exercised end-to-end without external services).
 */
export interface Store {
  readonly kind: 'postgres' | 'memory';

  // users
  getUser(id: string): Promise<User | null>;
  getUserByTelegramId(telegramId: string): Promise<User | null>;
  upsertUser(user: Omit<User, 'createdAt'> & { createdAt?: Date }): Promise<User>;

  // markets
  listMarkets(filter?: { sport?: string; competition?: string; query?: string }): Promise<Market[]>;
  getMarket(id: string): Promise<Market | null>;
  upsertMarkets(markets: Market[]): Promise<void>;

  // content
  listContent(filter?: { marketId?: string; query?: string; limit?: number }): Promise<ContentItem[]>;
  upsertContent(items: ContentItem[]): Promise<void>;

  // suggestions
  createSuggestion(suggestion: Suggestion): Promise<Suggestion>;
  getSuggestion(id: string): Promise<Suggestion | null>;
  listSuggestions(userId: string, opts?: { status?: Suggestion['status']; limit?: number }): Promise<Suggestion[]>;
  updateSuggestionStatus(id: string, status: Suggestion['status']): Promise<void>;

  // confirmations
  createConfirmation(confirmation: Confirmation): Promise<Confirmation>;
  findUsableConfirmation(userId: string, intentHash: string, now: Date): Promise<Confirmation | null>;
  consumeConfirmation(id: string, executionId: string, now: Date): Promise<boolean>;

  // executions
  createExecution(execution: BetExecution): Promise<BetExecution>;
  getExecution(id: string): Promise<BetExecution | null>;
  getExecutionByIdempotencyKey(key: string): Promise<BetExecution | null>;
  updateExecution(id: string, patch: Partial<BetExecution>): Promise<BetExecution>;
  listExecutions(userId: string, opts?: { limit?: number }): Promise<BetExecution[]>;
  /** Across all users — the reconciler sweeps these, oldest first. */
  listPendingExecutions(limit?: number): Promise<BetExecution[]>;
  countOpenExecutions(userId: string): Promise<number>;
  sumStakeSince(userId: string, since: Date): Promise<DailyStakeSummary>;

  // observability
  appendAudit(event: AuditEvent): Promise<void>;
  listAudit(filter: { userId?: string; executionId?: string; limit?: number }): Promise<AuditEvent[]>;
  recordTokenUsage(record: TokenUsageRecord): Promise<void>;
  aggregateTokenUsage(filter?: { userId?: string; since?: Date }): Promise<
    { agentRole: string; model: string; inputTokens: number; outputTokens: number; totalTokens: number; calls: number }[]
  >;
}
