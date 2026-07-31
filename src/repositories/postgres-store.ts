import { and, desc, eq, gte, ilike, inArray, isNull, or, sql } from 'drizzle-orm';
import { getDb, type Database } from '../db/client.js';
import {
  auditEvents,
  betExecutions,
  confirmations,
  contentItems,
  markets as marketsTable,
  suggestions as suggestionsTable,
  tokenUsage,
  users as usersTable,
} from '../db/schema.js';
import type {
  AgentRole,
  AuditEvent,
  AuditKind,
  BetExecution,
  ClientChannel,
  Confirmation,
  Market,
  Suggestion,
  SuggestionStatus,
  TokenUsageRecord,
  TxStatus,
  User,
} from '../domain/types.js';
import type { ContentItem, DailyStakeSummary, Store } from './store.js';

export class PostgresStore implements Store {
  readonly kind = 'postgres' as const;
  private readonly db: Database;

  constructor(db: Database = getDb()) {
    this.db = db;
  }

  // -------------------------------------------------------------------------
  // users
  // -------------------------------------------------------------------------

  async getUser(id: string): Promise<User | null> {
    const [row] = await this.db.select().from(usersTable).where(eq(usersTable.id, id)).limit(1);
    return row ? mapUser(row) : null;
  }

  async getUserByTelegramId(telegramId: string): Promise<User | null> {
    const [row] = await this.db
      .select()
      .from(usersTable)
      .where(eq(usersTable.telegramId, telegramId))
      .limit(1);
    return row ? mapUser(row) : null;
  }

  async upsertUser(user: Omit<User, 'createdAt'> & { createdAt?: Date }): Promise<User> {
    const [row] = await this.db
      .insert(usersTable)
      .values({
        id: user.id,
        displayName: user.displayName,
        walletAddress: user.walletAddress,
        telegramId: user.telegramId,
        limitsOverride: user.limitsOverride,
        ...(user.createdAt ? { createdAt: user.createdAt } : {}),
      })
      .onConflictDoUpdate({
        target: usersTable.id,
        set: {
          displayName: user.displayName,
          walletAddress: user.walletAddress,
          telegramId: user.telegramId,
          limitsOverride: user.limitsOverride,
        },
      })
      .returning();
    return mapUser(row!);
  }

  // -------------------------------------------------------------------------
  // markets
  // -------------------------------------------------------------------------

  async listMarkets(filter?: { sport?: string; competition?: string; query?: string }): Promise<Market[]> {
    const conditions = [];
    if (filter?.sport) conditions.push(eq(marketsTable.sport, filter.sport));
    if (filter?.competition) conditions.push(ilike(marketsTable.competition, `%${filter.competition}%`));
    if (filter?.query) {
      const pattern = `%${filter.query}%`;
      conditions.push(
        or(
          ilike(marketsTable.homeTeam, pattern),
          ilike(marketsTable.awayTeam, pattern),
          ilike(marketsTable.competition, pattern),
          ilike(marketsTable.id, pattern),
        )!,
      );
    }
    const rows = await this.db
      .select()
      .from(marketsTable)
      .where(conditions.length ? and(...conditions) : undefined)
      .orderBy(marketsTable.startsAt)
      .limit(50);
    return rows.map(mapMarket);
  }

  async getMarket(id: string): Promise<Market | null> {
    const [row] = await this.db.select().from(marketsTable).where(eq(marketsTable.id, id)).limit(1);
    return row ? mapMarket(row) : null;
  }

  async upsertMarkets(markets: Market[]): Promise<void> {
    if (markets.length === 0) return;
    await this.db
      .insert(marketsTable)
      .values(
        markets.map((m) => ({
          id: m.id,
          sport: m.sport,
          competition: m.competition,
          homeTeam: m.homeTeam,
          awayTeam: m.awayTeam,
          startsAt: new Date(m.startsAt),
          status: m.status,
          selections: m.selections,
          updatedAt: new Date(),
        })),
      )
      .onConflictDoUpdate({
        target: marketsTable.id,
        set: {
          status: sql`excluded.status`,
          selections: sql`excluded.selections`,
          startsAt: sql`excluded.starts_at`,
          updatedAt: new Date(),
        },
      });
  }

  // -------------------------------------------------------------------------
  // content
  // -------------------------------------------------------------------------

  async listContent(filter?: { marketId?: string; query?: string; limit?: number }): Promise<ContentItem[]> {
    const conditions = [];
    if (filter?.marketId) conditions.push(eq(contentItems.marketId, filter.marketId));
    if (filter?.query) conditions.push(ilike(contentItems.body, `%${filter.query}%`));
    const rows = await this.db
      .select()
      .from(contentItems)
      .where(conditions.length ? and(...conditions) : undefined)
      .orderBy(desc(contentItems.publishedAt))
      .limit(filter?.limit ?? 20);
    return rows.map((r) => ({
      id: r.id,
      source: r.source,
      author: r.author,
      body: r.body,
      marketId: r.marketId,
      sanitised: r.sanitised,
      publishedAt: r.publishedAt,
    }));
  }

  async upsertContent(items: ContentItem[]): Promise<void> {
    if (items.length === 0) return;
    await this.db
      .insert(contentItems)
      .values(
        items.map((c) => ({
          id: c.id,
          source: c.source,
          author: c.author,
          body: c.body,
          marketId: c.marketId,
          sanitised: c.sanitised,
          publishedAt: c.publishedAt,
        })),
      )
      .onConflictDoNothing({ target: contentItems.id });
  }

  // -------------------------------------------------------------------------
  // suggestions
  // -------------------------------------------------------------------------

  async createSuggestion(suggestion: Suggestion): Promise<Suggestion> {
    const [row] = await this.db
      .insert(suggestionsTable)
      .values({
        id: suggestion.id,
        userId: suggestion.userId,
        marketId: suggestion.marketId,
        selectionId: suggestion.selectionId,
        suggestedStake: suggestion.suggestedStake,
        odds: suggestion.odds,
        confidence: suggestion.confidence,
        rationale: suggestion.rationale,
        source: suggestion.source,
        status: suggestion.status,
        traceId: suggestion.traceId,
        createdAt: suggestion.createdAt,
        expiresAt: suggestion.expiresAt,
      })
      .returning();
    return mapSuggestion(row!);
  }

  async getSuggestion(id: string): Promise<Suggestion | null> {
    const [row] = await this.db.select().from(suggestionsTable).where(eq(suggestionsTable.id, id)).limit(1);
    return row ? mapSuggestion(row) : null;
  }

  async listSuggestions(userId: string, opts?: { status?: SuggestionStatus; limit?: number }): Promise<Suggestion[]> {
    const conditions = [eq(suggestionsTable.userId, userId)];
    if (opts?.status) conditions.push(eq(suggestionsTable.status, opts.status));
    const rows = await this.db
      .select()
      .from(suggestionsTable)
      .where(and(...conditions))
      .orderBy(desc(suggestionsTable.createdAt))
      .limit(opts?.limit ?? 20);
    return rows.map(mapSuggestion);
  }

  async updateSuggestionStatus(id: string, status: SuggestionStatus): Promise<void> {
    await this.db.update(suggestionsTable).set({ status }).where(eq(suggestionsTable.id, id));
  }

  // -------------------------------------------------------------------------
  // confirmations
  // -------------------------------------------------------------------------

  async createConfirmation(confirmation: Confirmation): Promise<Confirmation> {
    const [row] = await this.db
      .insert(confirmations)
      .values({
        id: confirmation.id,
        userId: confirmation.userId,
        intentHash: confirmation.intentHash,
        suggestionId: confirmation.suggestionId,
        channel: confirmation.channel,
        createdAt: confirmation.createdAt,
        expiresAt: confirmation.expiresAt,
        consumedAt: confirmation.consumedAt,
        consumedByExecutionId: confirmation.consumedByExecutionId,
      })
      .returning();
    return mapConfirmation(row!);
  }

  async findUsableConfirmation(userId: string, intentHash: string, now: Date): Promise<Confirmation | null> {
    const [row] = await this.db
      .select()
      .from(confirmations)
      .where(
        and(
          eq(confirmations.userId, userId),
          eq(confirmations.intentHash, intentHash),
          isNull(confirmations.consumedAt),
          gte(confirmations.expiresAt, now),
        ),
      )
      .orderBy(confirmations.createdAt)
      .limit(1);
    return row ? mapConfirmation(row) : null;
  }

  /**
   * Atomically claims the confirmation. The `consumed_at IS NULL` predicate in the
   * UPDATE is what makes a double-spend impossible: two concurrent executions race
   * on the same row and exactly one gets a returned row back.
   */
  async consumeConfirmation(id: string, executionId: string, now: Date): Promise<boolean> {
    const rows = await this.db
      .update(confirmations)
      .set({ consumedAt: now, consumedByExecutionId: executionId })
      .where(and(eq(confirmations.id, id), isNull(confirmations.consumedAt)))
      .returning({ id: confirmations.id });
    return rows.length === 1;
  }

  // -------------------------------------------------------------------------
  // executions
  // -------------------------------------------------------------------------

  async createExecution(execution: BetExecution): Promise<BetExecution> {
    const rows = await this.db
      .insert(betExecutions)
      .values(toExecutionRow(execution))
      .onConflictDoNothing({ target: betExecutions.idempotencyKey })
      .returning();
    if (rows[0]) return mapExecution(rows[0]);
    // Idempotency collision — return the winner rather than creating a duplicate bet.
    const existing = await this.getExecutionByIdempotencyKey(execution.idempotencyKey);
    if (!existing) throw new Error('Execution insert conflicted but no existing row was found');
    return existing;
  }

  async getExecution(id: string): Promise<BetExecution | null> {
    const [row] = await this.db.select().from(betExecutions).where(eq(betExecutions.id, id)).limit(1);
    return row ? mapExecution(row) : null;
  }

  async getExecutionByIdempotencyKey(key: string): Promise<BetExecution | null> {
    const [row] = await this.db
      .select()
      .from(betExecutions)
      .where(eq(betExecutions.idempotencyKey, key))
      .limit(1);
    return row ? mapExecution(row) : null;
  }

  async updateExecution(id: string, patch: Partial<BetExecution>): Promise<BetExecution> {
    const set: Record<string, unknown> = { updatedAt: new Date() };
    if (patch.txStatus !== undefined) set.txStatus = patch.txStatus;
    if (patch.txHash !== undefined) set.txHash = patch.txHash;
    if (patch.blockNumber !== undefined) set.blockNumber = patch.blockNumber;
    if (patch.reportedToUserAt !== undefined) set.reportedToUserAt = patch.reportedToUserAt;
    if (patch.failureReason !== undefined) set.failureReason = patch.failureReason;
    if (patch.confirmationId !== undefined) set.confirmationId = patch.confirmationId;
    if (patch.suggestionId !== undefined) set.suggestionId = patch.suggestionId;
    if (patch.traceId !== undefined) set.traceId = patch.traceId;

    const [row] = await this.db.update(betExecutions).set(set).where(eq(betExecutions.id, id)).returning();
    if (!row) throw new Error(`Execution ${id} not found`);
    return mapExecution(row);
  }

  async listExecutions(userId: string, opts?: { limit?: number }): Promise<BetExecution[]> {
    const rows = await this.db
      .select()
      .from(betExecutions)
      .where(eq(betExecutions.userId, userId))
      .orderBy(desc(betExecutions.createdAt))
      .limit(opts?.limit ?? 20);
    return rows.map(mapExecution);
  }

  async listPendingExecutions(limit = 50): Promise<BetExecution[]> {
    const rows = await this.db
      .select()
      .from(betExecutions)
      .where(eq(betExecutions.txStatus, 'pending'))
      .orderBy(betExecutions.updatedAt)
      .limit(limit);
    return rows.map(mapExecution);
  }

  async countOpenExecutions(userId: string): Promise<number> {
    const [row] = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(betExecutions)
      .where(and(eq(betExecutions.userId, userId), eq(betExecutions.txStatus, 'pending')));
    return row?.count ?? 0;
  }

  async sumStakeSince(userId: string, since: Date): Promise<DailyStakeSummary> {
    const [row] = await this.db
      .select({
        totalStake: sql<number>`coalesce(sum(${betExecutions.stake}), 0)::float8`,
        betCount: sql<number>`count(*)::int`,
      })
      .from(betExecutions)
      .where(
        and(
          eq(betExecutions.userId, userId),
          gte(betExecutions.createdAt, since),
          inArray(betExecutions.txStatus, ['pending', 'confirmed']),
        ),
      );
    return { totalStake: row?.totalStake ?? 0, betCount: row?.betCount ?? 0 };
  }

  // -------------------------------------------------------------------------
  // observability
  // -------------------------------------------------------------------------

  async appendAudit(event: AuditEvent): Promise<void> {
    await this.db.insert(auditEvents).values({
      id: event.id,
      userId: event.userId,
      executionId: event.executionId,
      suggestionId: event.suggestionId,
      agentRole: event.agentRole,
      channel: event.channel,
      kind: event.kind,
      detail: event.detail,
      traceId: event.traceId,
      runId: event.runId,
      createdAt: event.createdAt,
    });
  }

  async listAudit(filter: { userId?: string; executionId?: string; limit?: number }): Promise<AuditEvent[]> {
    const conditions = [];
    if (filter.userId) conditions.push(eq(auditEvents.userId, filter.userId));
    if (filter.executionId) conditions.push(eq(auditEvents.executionId, filter.executionId));
    // Ordered by the sequence column, not the timestamp — see schema.ts.
    const rows = await this.db
      .select()
      .from(auditEvents)
      .where(conditions.length ? and(...conditions) : undefined)
      .orderBy(desc(auditEvents.seq))
      .limit(filter.limit ?? 100);
    return rows.map((r) => ({
      id: r.id,
      userId: r.userId,
      executionId: r.executionId,
      suggestionId: r.suggestionId,
      agentRole: r.agentRole as AgentRole | null,
      channel: r.channel as ClientChannel | null,
      kind: r.kind as AuditKind,
      detail: r.detail,
      traceId: r.traceId,
      runId: r.runId,
      createdAt: r.createdAt,
    }));
  }

  async recordTokenUsage(record: TokenUsageRecord): Promise<void> {
    await this.db.insert(tokenUsage).values({
      id: record.id,
      agentRole: record.agentRole,
      model: record.model,
      provider: record.provider,
      inputTokens: record.inputTokens,
      outputTokens: record.outputTokens,
      totalTokens: record.totalTokens,
      toolSchemaTokens: record.toolSchemaTokens,
      userId: record.userId,
      traceId: record.traceId,
      createdAt: record.createdAt,
    });
  }

  async aggregateTokenUsage(filter?: { userId?: string; since?: Date }) {
    const conditions = [];
    if (filter?.userId) conditions.push(eq(tokenUsage.userId, filter.userId));
    if (filter?.since) conditions.push(gte(tokenUsage.createdAt, filter.since));
    const rows = await this.db
      .select({
        agentRole: tokenUsage.agentRole,
        model: tokenUsage.model,
        inputTokens: sql<number>`coalesce(sum(${tokenUsage.inputTokens}), 0)::int`,
        outputTokens: sql<number>`coalesce(sum(${tokenUsage.outputTokens}), 0)::int`,
        totalTokens: sql<number>`coalesce(sum(${tokenUsage.totalTokens}), 0)::int`,
        calls: sql<number>`count(*)::int`,
      })
      .from(tokenUsage)
      .where(conditions.length ? and(...conditions) : undefined)
      .groupBy(tokenUsage.agentRole, tokenUsage.model);
    return rows.sort((a, b) => b.totalTokens - a.totalTokens);
  }
}

// ---------------------------------------------------------------------------
// row mappers
// ---------------------------------------------------------------------------

type Row<T extends { $inferSelect: unknown }> = T['$inferSelect'];

function mapUser(row: Row<typeof usersTable>): User {
  return {
    id: row.id,
    displayName: row.displayName,
    walletAddress: row.walletAddress,
    telegramId: row.telegramId,
    limitsOverride: row.limitsOverride ?? null,
    createdAt: row.createdAt,
  };
}

function mapMarket(row: Row<typeof marketsTable>): Market {
  return {
    id: row.id,
    sport: row.sport,
    competition: row.competition,
    homeTeam: row.homeTeam,
    awayTeam: row.awayTeam,
    startsAt: row.startsAt.toISOString(),
    status: row.status as Market['status'],
    selections: row.selections,
  };
}

function mapSuggestion(row: Row<typeof suggestionsTable>): Suggestion {
  return {
    id: row.id,
    userId: row.userId,
    marketId: row.marketId,
    selectionId: row.selectionId,
    suggestedStake: row.suggestedStake,
    odds: row.odds,
    confidence: row.confidence,
    rationale: row.rationale,
    source: row.source,
    status: row.status as SuggestionStatus,
    traceId: row.traceId,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
  };
}

function mapConfirmation(row: Row<typeof confirmations>): Confirmation {
  return {
    id: row.id,
    userId: row.userId,
    intentHash: row.intentHash,
    suggestionId: row.suggestionId,
    channel: row.channel as ClientChannel,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    consumedAt: row.consumedAt,
    consumedByExecutionId: row.consumedByExecutionId,
  };
}

function mapExecution(row: Row<typeof betExecutions>): BetExecution {
  return {
    id: row.id,
    suggestionId: row.suggestionId,
    userId: row.userId,
    marketId: row.marketId,
    selectionId: row.selectionId,
    stake: row.stake,
    odds: row.odds,
    txStatus: row.txStatus as TxStatus,
    txHash: row.txHash,
    blockNumber: row.blockNumber,
    reportedToUserAt: row.reportedToUserAt,
    failureReason: row.failureReason,
    channel: row.channel as ClientChannel,
    confirmationId: row.confirmationId,
    intentHash: row.intentHash,
    idempotencyKey: row.idempotencyKey,
    traceId: row.traceId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toExecutionRow(e: BetExecution) {
  return {
    id: e.id,
    suggestionId: e.suggestionId,
    userId: e.userId,
    marketId: e.marketId,
    selectionId: e.selectionId,
    stake: e.stake,
    odds: e.odds,
    txStatus: e.txStatus,
    txHash: e.txHash,
    blockNumber: e.blockNumber,
    reportedToUserAt: e.reportedToUserAt,
    failureReason: e.failureReason,
    channel: e.channel,
    confirmationId: e.confirmationId,
    intentHash: e.intentHash,
    idempotencyKey: e.idempotencyKey,
    traceId: e.traceId,
    createdAt: e.createdAt,
    updatedAt: e.updatedAt,
  };
}
