import type {
  AuditEvent,
  BetExecution,
  Confirmation,
  Market,
  Suggestion,
  TokenUsageRecord,
  User,
} from '../domain/types.js';
import type { ContentItem, DailyStakeSummary, Store } from './store.js';

/**
 * In-memory implementation of {@link Store}. Used when DATABASE_URL is absent so
 * the system boots and can be driven end-to-end without provisioning Neon.
 * Deliberately not concurrency-safe beyond Node's single-threaded model — the
 * Postgres store is the one that matters for correctness under load.
 */
export class MemoryStore implements Store {
  readonly kind = 'memory' as const;

  private readonly users = new Map<string, User>();
  private readonly markets = new Map<string, Market>();
  private readonly content = new Map<string, ContentItem>();
  private readonly suggestions = new Map<string, Suggestion>();
  private readonly confirmations = new Map<string, Confirmation>();
  private readonly executions = new Map<string, BetExecution>();
  private readonly audit: AuditEvent[] = [];
  private readonly usage: TokenUsageRecord[] = [];

  async getUser(id: string): Promise<User | null> {
    return this.users.get(id) ?? null;
  }

  async getUserByTelegramId(telegramId: string): Promise<User | null> {
    for (const u of this.users.values()) if (u.telegramId === telegramId) return u;
    return null;
  }

  async upsertUser(user: Omit<User, 'createdAt'> & { createdAt?: Date }): Promise<User> {
    const existing = this.users.get(user.id);
    const merged: User = { ...user, createdAt: existing?.createdAt ?? user.createdAt ?? new Date() };
    this.users.set(user.id, merged);
    return merged;
  }

  async listMarkets(filter?: { sport?: string; competition?: string; query?: string }): Promise<Market[]> {
    let all = [...this.markets.values()];
    if (filter?.sport) all = all.filter((m) => m.sport.toLowerCase() === filter.sport!.toLowerCase());
    if (filter?.competition)
      all = all.filter((m) => m.competition.toLowerCase().includes(filter.competition!.toLowerCase()));
    if (filter?.query) {
      const q = filter.query.toLowerCase();
      all = all.filter((m) =>
        [m.homeTeam, m.awayTeam, m.competition, m.sport, m.id].some((f) => f.toLowerCase().includes(q)),
      );
    }
    return all.sort((a, b) => a.startsAt.localeCompare(b.startsAt));
  }

  async getMarket(id: string): Promise<Market | null> {
    return this.markets.get(id) ?? null;
  }

  async upsertMarkets(markets: Market[]): Promise<void> {
    for (const m of markets) this.markets.set(m.id, m);
  }

  async listContent(filter?: { marketId?: string; query?: string; limit?: number }): Promise<ContentItem[]> {
    let all = [...this.content.values()];
    if (filter?.marketId) all = all.filter((c) => c.marketId === filter.marketId);
    if (filter?.query) {
      const q = filter.query.toLowerCase();
      all = all.filter((c) => c.body.toLowerCase().includes(q) || (c.author ?? '').toLowerCase().includes(q));
    }
    all.sort((a, b) => b.publishedAt.getTime() - a.publishedAt.getTime());
    return all.slice(0, filter?.limit ?? 20);
  }

  async upsertContent(items: ContentItem[]): Promise<void> {
    for (const c of items) this.content.set(c.id, c);
  }

  async createSuggestion(suggestion: Suggestion): Promise<Suggestion> {
    this.suggestions.set(suggestion.id, suggestion);
    return suggestion;
  }

  async getSuggestion(id: string): Promise<Suggestion | null> {
    return this.suggestions.get(id) ?? null;
  }

  async listSuggestions(userId: string, opts?: { status?: Suggestion['status']; limit?: number }): Promise<Suggestion[]> {
    return [...this.suggestions.values()]
      .filter((s) => s.userId === userId && (!opts?.status || s.status === opts.status))
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, opts?.limit ?? 20);
  }

  async updateSuggestionStatus(id: string, status: Suggestion['status']): Promise<void> {
    const s = this.suggestions.get(id);
    if (s) this.suggestions.set(id, { ...s, status });
  }

  async createConfirmation(confirmation: Confirmation): Promise<Confirmation> {
    this.confirmations.set(confirmation.id, confirmation);
    return confirmation;
  }

  async findUsableConfirmation(userId: string, intentHash: string, now: Date): Promise<Confirmation | null> {
    const candidates = [...this.confirmations.values()]
      .filter(
        (c) =>
          c.userId === userId &&
          c.intentHash === intentHash &&
          c.consumedAt === null &&
          c.expiresAt.getTime() > now.getTime(),
      )
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    return candidates[0] ?? null;
  }

  async consumeConfirmation(id: string, executionId: string, now: Date): Promise<boolean> {
    const c = this.confirmations.get(id);
    if (!c || c.consumedAt !== null) return false;
    this.confirmations.set(id, { ...c, consumedAt: now, consumedByExecutionId: executionId });
    return true;
  }

  async createExecution(execution: BetExecution): Promise<BetExecution> {
    for (const e of this.executions.values()) {
      if (e.idempotencyKey === execution.idempotencyKey) return e;
    }
    this.executions.set(execution.id, execution);
    return execution;
  }

  async getExecution(id: string): Promise<BetExecution | null> {
    return this.executions.get(id) ?? null;
  }

  async getExecutionByIdempotencyKey(key: string): Promise<BetExecution | null> {
    for (const e of this.executions.values()) if (e.idempotencyKey === key) return e;
    return null;
  }

  async updateExecution(id: string, patch: Partial<BetExecution>): Promise<BetExecution> {
    const current = this.executions.get(id);
    if (!current) throw new Error(`Execution ${id} not found`);
    const next: BetExecution = { ...current, ...patch, updatedAt: new Date() };
    this.executions.set(id, next);
    return next;
  }

  async listExecutions(userId: string, opts?: { limit?: number }): Promise<BetExecution[]> {
    return [...this.executions.values()]
      .filter((e) => e.userId === userId)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, opts?.limit ?? 20);
  }

  async listPendingExecutions(limit = 50): Promise<BetExecution[]> {
    return [...this.executions.values()]
      .filter((e) => e.txStatus === 'pending')
      .sort((a, b) => a.updatedAt.getTime() - b.updatedAt.getTime())
      .slice(0, limit);
  }

  async countOpenExecutions(userId: string): Promise<number> {
    return [...this.executions.values()].filter((e) => e.userId === userId && e.txStatus === 'pending').length;
  }

  async sumStakeSince(userId: string, since: Date): Promise<DailyStakeSummary> {
    const relevant = [...this.executions.values()].filter(
      (e) =>
        e.userId === userId &&
        e.createdAt.getTime() >= since.getTime() &&
        (e.txStatus === 'pending' || e.txStatus === 'confirmed'),
    );
    return {
      totalStake: relevant.reduce((sum, e) => sum + e.stake, 0),
      betCount: relevant.length,
    };
  }

  async appendAudit(event: AuditEvent): Promise<void> {
    this.audit.push(event);
  }

  async listAudit(filter: { userId?: string; executionId?: string; limit?: number }): Promise<AuditEvent[]> {
    // `this.audit` is already in append order. Reversing it (rather than sorting
    // by createdAt) preserves the true sequence when several events land in the
    // same millisecond — the ordering is what answers a dispute.
    const matching = this.audit.filter(
      (a) =>
        (!filter.userId || a.userId === filter.userId) &&
        (!filter.executionId || a.executionId === filter.executionId),
    );
    return matching.slice(-(filter.limit ?? 100)).reverse();
  }

  async recordTokenUsage(record: TokenUsageRecord): Promise<void> {
    this.usage.push(record);
  }

  async aggregateTokenUsage(filter?: { userId?: string; since?: Date }) {
    const rows = this.usage.filter(
      (u) =>
        (!filter?.userId || u.userId === filter.userId) &&
        (!filter?.since || u.createdAt.getTime() >= filter.since.getTime()),
    );
    const byKey = new Map<string, { agentRole: string; model: string; inputTokens: number; outputTokens: number; totalTokens: number; calls: number }>();
    for (const r of rows) {
      const key = `${r.agentRole}::${r.model}`;
      const acc =
        byKey.get(key) ?? { agentRole: r.agentRole, model: r.model, inputTokens: 0, outputTokens: 0, totalTokens: 0, calls: 0 };
      acc.inputTokens += r.inputTokens;
      acc.outputTokens += r.outputTokens;
      acc.totalTokens += r.totalTokens;
      acc.calls += 1;
      byKey.set(key, acc);
    }
    return [...byKey.values()].sort((a, b) => b.totalTokens - a.totalTokens);
  }
}
