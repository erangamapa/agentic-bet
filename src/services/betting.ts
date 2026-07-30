import { resolveLimits, type RiskLimits } from '../config/limits.js';
import { derivedWalletAddress, getExecutor } from '../chain/executor.js';
import {
  ConfirmationRequiredError,
  NotFoundError,
  RiskRuleError,
} from '../domain/errors.js';
import {
  computeIntentHash,
  newId,
  type BetExecution,
  type ClientChannel,
  type Confirmation,
  type Suggestion,
} from '../domain/types.js';
import { audit } from '../observability/audit.js';
import { logger } from '../observability/logger.js';
import type { TraceContext } from '../observability/tracing.js';
import { getStore } from '../repositories/index.js';
import { assertValidGrant, type ExecutionGrant } from '../agents/privilege.js';

/** Maximum tolerated drift between the confirmed odds and the live odds, as a fraction. */
const ODDS_DRIFT_TOLERANCE = 0.05;

export interface QuoteInput {
  userId: string;
  marketId: string;
  selectionId: string;
  stake: number;
  channel: ClientChannel;
  /** Set when the quote comes from an Analyst suggestion rather than a direct request. */
  fromSuggestionId?: string | null;
  rationale?: string;
  source?: string;
}

export interface Quote {
  suggestionId: string;
  confirmCode: string;
  userId: string;
  marketId: string;
  fixture: string;
  selectionId: string;
  selectionLabel: string;
  stake: number;
  odds: number;
  potentialReturn: number;
  intentHash: string;
  limits: RiskLimits;
  expiresAt: Date;
}

/**
 * Validates a proposed bet against live market state and the user's risk rules,
 * then records it as a pending Suggestion the user can confirm.
 *
 * Nothing here moves money. It exists so limits are checked and shown *before*
 * the user is asked to confirm, and so the exact parameters are frozen into a
 * row — the confirmation binds to this row, not to whatever the model says next.
 */
export async function quoteBet(input: QuoteInput): Promise<Quote> {
  const store = getStore();
  const user = await store.getUser(input.userId);
  const limits = resolveLimits(user?.limitsOverride ?? null);

  const market = await store.getMarket(input.marketId);
  if (!market) throw new NotFoundError(`Unknown market "${input.marketId}"`, { marketId: input.marketId });
  if (market.status !== 'open') {
    throw new RiskRuleError(`Market "${input.marketId}" is ${market.status} and cannot be bet on`, {
      marketId: market.id,
      status: market.status,
    });
  }

  const selection = market.selections.find((s) => s.id === input.selectionId);
  if (!selection) {
    throw new NotFoundError(
      `Selection "${input.selectionId}" does not exist on market "${input.marketId}"`,
      { marketId: market.id, available: market.selections.map((s) => s.id) },
    );
  }

  await assertWithinLimits({ userId: input.userId, stake: input.stake, odds: selection.odds, limits });

  const stake = round2(input.stake);
  const intentHash = computeIntentHash({
    userId: input.userId,
    marketId: market.id,
    selectionId: selection.id,
    stake,
    odds: selection.odds,
  });

  const expiresAt = new Date(Date.now() + limits.confirmationTtlSeconds * 1000);
  const suggestion: Suggestion = {
    id: newId('sug'),
    userId: input.userId,
    marketId: market.id,
    selectionId: selection.id,
    suggestedStake: stake,
    odds: selection.odds,
    confidence: 0.5,
    rationale: input.rationale ?? 'Quoted at user request.',
    source: input.source ?? input.fromSuggestionId ?? 'user_request',
    status: 'suggested',
    traceId: null,
    createdAt: new Date(),
    expiresAt,
  };
  await store.createSuggestion(suggestion);

  await audit({
    kind: 'suggestion_created',
    userId: input.userId,
    channel: input.channel,
    suggestionId: suggestion.id,
    agentRole: 'bet_placement',
    detail: {
      marketId: market.id,
      selectionId: selection.id,
      stake,
      odds: selection.odds,
      intentHash,
      origin: input.fromSuggestionId ? 'analyst_suggestion' : 'user_request',
    },
  });

  return {
    suggestionId: suggestion.id,
    confirmCode: confirmCodeFor(suggestion.id),
    userId: input.userId,
    marketId: market.id,
    fixture: `${market.homeTeam} vs ${market.awayTeam}`,
    selectionId: selection.id,
    selectionLabel: selection.label,
    stake,
    odds: selection.odds,
    potentialReturn: round2(stake * selection.odds),
    intentHash,
    limits,
    expiresAt,
  };
}

/**
 * Records an explicit user confirmation. Called only from deterministic
 * front-end paths (an HTTP route the user's client hits, or a Telegram
 * `/confirm` command) — never from inside an agent, and never by an LLM
 * deciding that the user "seemed to agree".
 */
export async function confirmSuggestion(input: {
  userId: string;
  suggestionOrCode: string;
  channel: ClientChannel;
}): Promise<{ confirmation: Confirmation; suggestion: Suggestion }> {
  const store = getStore();
  const suggestion = await resolveSuggestion(input.userId, input.suggestionOrCode);

  if (suggestion.userId !== input.userId) {
    throw new NotFoundError('Suggestion does not belong to this user', { suggestionId: suggestion.id });
  }
  if (suggestion.status === 'executed') {
    throw new RiskRuleError('That bet has already been executed', { suggestionId: suggestion.id });
  }
  if (suggestion.status === 'dismissed') {
    throw new RiskRuleError('That suggestion was dismissed', { suggestionId: suggestion.id });
  }
  if (suggestion.expiresAt && suggestion.expiresAt.getTime() < Date.now()) {
    await store.updateSuggestionStatus(suggestion.id, 'expired');
    throw new RiskRuleError('That suggestion has expired — ask for a fresh quote', {
      suggestionId: suggestion.id,
    });
  }

  const user = await store.getUser(input.userId);
  const limits = resolveLimits(user?.limitsOverride ?? null);

  const intentHash = computeIntentHash({
    userId: suggestion.userId,
    marketId: suggestion.marketId,
    selectionId: suggestion.selectionId,
    stake: suggestion.suggestedStake,
    odds: suggestion.odds,
  });

  const confirmation: Confirmation = {
    id: newId('cnf'),
    userId: input.userId,
    intentHash,
    suggestionId: suggestion.id,
    channel: input.channel,
    createdAt: new Date(),
    expiresAt: new Date(Date.now() + limits.confirmationTtlSeconds * 1000),
    consumedAt: null,
    consumedByExecutionId: null,
  };

  await store.createConfirmation(confirmation);
  await store.updateSuggestionStatus(suggestion.id, 'confirmed');

  await audit({
    kind: 'confirmation_created',
    userId: input.userId,
    channel: input.channel,
    suggestionId: suggestion.id,
    detail: { confirmationId: confirmation.id, intentHash, expiresAt: confirmation.expiresAt.toISOString() },
  });

  return { confirmation, suggestion: { ...suggestion, status: 'confirmed' } };
}

export async function dismissSuggestion(userId: string, suggestionOrCode: string): Promise<void> {
  const suggestion = await resolveSuggestion(userId, suggestionOrCode);
  if (suggestion.userId !== userId) throw new NotFoundError('Suggestion not found');
  await getStore().updateSuggestionStatus(suggestion.id, 'dismissed');
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

export interface ExecutionOutcome {
  executionId: string;
  /**
   * `pending` means broadcast happened but confirmation is still unknown. It is
   * deliberately distinct from `confirmed` — a pending outcome must never be
   * described to the user as a placed bet.
   */
  status: 'confirmed' | 'failed' | 'pending';
  txHash: string | null;
  blockNumber: number | null;
  stake: number;
  odds: number;
  marketId: string;
  selectionId: string;
  potentialReturn: number;
  /** Only ever non-null when status === 'confirmed'. */
  reportedToUserAt: string | null;
  failureReason: string | null;
  traceId: string | null;
}

/**
 * THE money-moving function. Reachable only with a valid {@link ExecutionGrant},
 * which only the Bet Placement Agent can obtain.
 *
 * Order of operations is load-bearing:
 *   1. re-derive the bet from the stored suggestion (the model supplies an id, never amounts)
 *   2. re-check live market state and risk limits
 *   3. require a matching, unconsumed, unexpired user confirmation
 *   4. create the execution row as `pending`
 *   5. atomically consume the confirmation (a double-submit loses the race here)
 *   6. broadcast
 *   7. VERIFY on-chain, and only then mark confirmed / set reportedToUserAt
 *
 * Steps 6 and 7 are separate on purpose. `broadcast` succeeding is not a placed
 * bet, and this function never returns `status: 'confirmed'` off the back of it.
 */
export async function placeConfirmedBet(
  grant: ExecutionGrant,
  input: { userId: string; suggestionOrCode: string; channel: ClientChannel; ctx: TraceContext },
): Promise<ExecutionOutcome> {
  assertValidGrant(grant, 'place_confirmed_bet');

  const store = getStore();
  const executor = getExecutor();
  const suggestion = await resolveSuggestion(input.userId, input.suggestionOrCode);

  if (suggestion.userId !== input.userId) {
    throw new NotFoundError('Suggestion does not belong to this user', { suggestionId: suggestion.id });
  }

  await audit({
    kind: 'execution_requested',
    userId: input.userId,
    channel: input.channel,
    suggestionId: suggestion.id,
    agentRole: 'bet_placement',
    traceId: input.ctx.traceId,
    detail: {
      marketId: suggestion.marketId,
      selectionId: suggestion.selectionId,
      stake: suggestion.suggestedStake,
      odds: suggestion.odds,
      executionMode: executor.mode,
    },
  });

  // --- 2. live market re-check -------------------------------------------
  const market = await store.getMarket(suggestion.marketId);
  if (!market) throw new NotFoundError(`Unknown market "${suggestion.marketId}"`);
  if (market.status !== 'open') {
    await reject(input, suggestion.id, `Market is ${market.status}`);
    throw new RiskRuleError(`Market "${market.id}" is ${market.status} — bet refused`, { marketId: market.id });
  }
  const selection = market.selections.find((s) => s.id === suggestion.selectionId);
  if (!selection) {
    await reject(input, suggestion.id, 'Selection no longer exists');
    throw new NotFoundError(`Selection "${suggestion.selectionId}" no longer exists on this market`);
  }
  const drift = Math.abs(selection.odds - suggestion.odds) / suggestion.odds;
  if (drift > ODDS_DRIFT_TOLERANCE) {
    await reject(input, suggestion.id, `Odds moved ${(drift * 100).toFixed(1)}%`);
    throw new RiskRuleError(
      `Odds moved from ${suggestion.odds} to ${selection.odds} since confirmation — re-confirm at the new price`,
      { confirmedOdds: suggestion.odds, currentOdds: selection.odds },
    );
  }

  const user = await store.getUser(input.userId);
  const limits = resolveLimits(user?.limitsOverride ?? null);
  try {
    await assertWithinLimits({
      userId: input.userId,
      stake: suggestion.suggestedStake,
      odds: suggestion.odds,
      limits,
    });
  } catch (err) {
    await reject(input, suggestion.id, err instanceof Error ? err.message : 'Risk rule violation');
    throw err;
  }

  // --- 3. confirmation gate ----------------------------------------------
  const intentHash = computeIntentHash({
    userId: suggestion.userId,
    marketId: suggestion.marketId,
    selectionId: suggestion.selectionId,
    stake: suggestion.suggestedStake,
    odds: suggestion.odds,
  });

  const confirmation = await store.findUsableConfirmation(input.userId, intentHash, new Date());
  if (!confirmation) {
    await reject(input, suggestion.id, 'No valid user confirmation');
    throw new ConfirmationRequiredError(
      'This bet has not been confirmed by the user (or the confirmation expired or was already used). Ask the user to confirm before it can be placed.',
      { suggestionId: suggestion.id, confirmCode: confirmCodeFor(suggestion.id) },
    );
  }

  // --- 4. execution row ---------------------------------------------------
  const executionId = newId('exe');
  const idempotencyKey = `${intentHash}:${confirmation.id}`;

  const existing = await store.getExecutionByIdempotencyKey(idempotencyKey);
  if (existing) {
    logger.warn(
      { component: 'betting', executionId: existing.id, idempotencyKey },
      'Duplicate execution attempt short-circuited by idempotency key',
    );
    return toOutcome(existing);
  }

  const now = new Date();
  const execution = await store.createExecution({
    id: executionId,
    suggestionId: suggestion.id,
    userId: input.userId,
    marketId: suggestion.marketId,
    selectionId: suggestion.selectionId,
    stake: suggestion.suggestedStake,
    odds: suggestion.odds,
    txStatus: 'pending',
    txHash: null,
    blockNumber: null,
    reportedToUserAt: null,
    failureReason: null,
    channel: input.channel,
    confirmationId: confirmation.id,
    intentHash,
    idempotencyKey,
    traceId: input.ctx.traceId,
    createdAt: now,
    updatedAt: now,
  });
  input.ctx.executionId = execution.id;

  // --- 5. atomically claim the confirmation -------------------------------
  const claimed = await store.consumeConfirmation(confirmation.id, execution.id, new Date());
  if (!claimed) {
    await store.updateExecution(execution.id, {
      txStatus: 'rejected',
      failureReason: 'Confirmation was already consumed by another execution',
    });
    await audit({
      kind: 'execution_rejected',
      userId: input.userId,
      channel: input.channel,
      executionId: execution.id,
      suggestionId: suggestion.id,
      agentRole: 'bet_placement',
      traceId: input.ctx.traceId,
      detail: { reason: 'confirmation_race_lost', confirmationId: confirmation.id },
    });
    throw new ConfirmationRequiredError('That confirmation was already used for another bet', {
      confirmationId: confirmation.id,
    });
  }

  await audit({
    kind: 'confirmation_consumed',
    userId: input.userId,
    channel: input.channel,
    executionId: execution.id,
    suggestionId: suggestion.id,
    traceId: input.ctx.traceId,
    detail: { confirmationId: confirmation.id, intentHash },
  });

  // --- 6. broadcast -------------------------------------------------------
  const request = {
    executionId: execution.id,
    userId: input.userId,
    bettor: (user?.walletAddress as `0x${string}` | undefined) ?? derivedWalletAddress(input.userId),
    marketId: suggestion.marketId,
    selectionId: suggestion.selectionId,
    stake: suggestion.suggestedStake,
    odds: suggestion.odds,
    intentHash,
  };

  let txHash: string;
  try {
    const broadcast = await executor.broadcast(request);
    txHash = broadcast.txHash;
    await store.updateExecution(execution.id, { txHash });
    await audit({
      kind: 'execution_broadcast',
      userId: input.userId,
      channel: input.channel,
      executionId: execution.id,
      suggestionId: suggestion.id,
      agentRole: 'bet_placement',
      traceId: input.ctx.traceId,
      detail: { txHash, elapsedMs: broadcast.elapsedMs, mode: executor.mode },
    });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    const failed = await store.updateExecution(execution.id, { txStatus: 'failed', failureReason: reason });
    await audit({
      kind: 'execution_failed',
      userId: input.userId,
      channel: input.channel,
      executionId: execution.id,
      suggestionId: suggestion.id,
      agentRole: 'bet_placement',
      traceId: input.ctx.traceId,
      detail: { stage: 'broadcast', reason },
    });
    return toOutcome(failed);
  }

  // --- 7. verify before reporting anything as placed ----------------------
  let verification;
  try {
    verification = await executor.verify(request, txHash);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    // Broadcast happened but confirmation is unknown. This stays `pending`,
    // NOT failed and certainly not confirmed — the reconciler resolves it later.
    await store.updateExecution(execution.id, { failureReason: reason });
    await audit({
      kind: 'execution_failed',
      userId: input.userId,
      channel: input.channel,
      executionId: execution.id,
      suggestionId: suggestion.id,
      agentRole: 'bet_placement',
      traceId: input.ctx.traceId,
      detail: { stage: 'verify', reason, txHash, resolution: 'left_pending_for_reconciliation' },
    });
    const pending = await store.getExecution(execution.id);
    return toOutcome(pending!);
  }

  if (verification.status !== 'confirmed') {
    const failed = await store.updateExecution(execution.id, {
      txStatus: 'failed',
      txHash: verification.txHash,
      blockNumber: verification.blockNumber,
      failureReason: verification.reason ?? 'Transaction did not confirm',
    });
    await audit({
      kind: 'execution_failed',
      userId: input.userId,
      channel: input.channel,
      executionId: execution.id,
      suggestionId: suggestion.id,
      agentRole: 'bet_placement',
      traceId: input.ctx.traceId,
      detail: { stage: 'verification', reason: verification.reason, txHash: verification.txHash },
    });
    return toOutcome(failed);
  }

  const confirmedAt = new Date();
  const confirmed = await store.updateExecution(execution.id, {
    txStatus: 'confirmed',
    txHash: verification.txHash,
    blockNumber: verification.blockNumber,
    reportedToUserAt: confirmedAt,
    failureReason: null,
  });
  await store.updateSuggestionStatus(suggestion.id, 'executed');

  await audit({
    kind: 'execution_confirmed',
    userId: input.userId,
    channel: input.channel,
    executionId: execution.id,
    suggestionId: suggestion.id,
    agentRole: 'bet_placement',
    traceId: input.ctx.traceId,
    detail: {
      txHash: verification.txHash,
      blockNumber: verification.blockNumber,
      betId: verification.betId,
      onChainIntentHash: verification.onChainIntentHash,
    },
  });
  await audit({
    kind: 'success_reported',
    userId: input.userId,
    channel: input.channel,
    executionId: execution.id,
    suggestionId: suggestion.id,
    agentRole: 'bet_placement',
    traceId: input.ctx.traceId,
    detail: { reportedToUserAt: confirmedAt.toISOString(), txHash: verification.txHash },
  });

  return toOutcome(confirmed);
}

// ---------------------------------------------------------------------------
// Risk rules
// ---------------------------------------------------------------------------

export async function assertWithinLimits(input: {
  userId: string;
  stake: number;
  odds: number;
  limits: RiskLimits;
}): Promise<void> {
  const { limits, stake, odds } = input;

  if (!Number.isFinite(stake) || stake <= 0) {
    throw new RiskRuleError('Stake must be a positive number', { stake });
  }
  if (stake < limits.minStake) {
    throw new RiskRuleError(`Stake ${stake} is below the minimum of ${limits.minStake}`, {
      stake,
      minStake: limits.minStake,
    });
  }
  if (stake > limits.maxStakePerBet) {
    throw new RiskRuleError(`Stake ${stake} exceeds the per-bet limit of ${limits.maxStakePerBet}`, {
      stake,
      maxStakePerBet: limits.maxStakePerBet,
    });
  }
  if (!Number.isFinite(odds) || odds <= 1) {
    throw new RiskRuleError('Decimal odds must be greater than 1', { odds });
  }
  if (odds > limits.maxOdds) {
    throw new RiskRuleError(`Odds ${odds} exceed the maximum allowed of ${limits.maxOdds}`, {
      odds,
      maxOdds: limits.maxOdds,
    });
  }

  const store = getStore();
  const since = startOfUtcDay();
  const [{ totalStake }, openBets] = await Promise.all([
    store.sumStakeSince(input.userId, since),
    store.countOpenExecutions(input.userId),
  ]);

  if (totalStake + stake > limits.maxStakePerDay) {
    throw new RiskRuleError(
      `This bet would take today's staked total to ${round2(totalStake + stake)}, above the daily cap of ${limits.maxStakePerDay}`,
      { stakedToday: round2(totalStake), attemptedStake: stake, maxStakePerDay: limits.maxStakePerDay },
    );
  }
  if (openBets >= limits.maxOpenBets) {
    throw new RiskRuleError(`You already have ${openBets} bets pending, the limit is ${limits.maxOpenBets}`, {
      openBets,
      maxOpenBets: limits.maxOpenBets,
    });
  }
}

// ---------------------------------------------------------------------------
// Queries used by front-ends and by the Bet Placement Agent's read tools
// ---------------------------------------------------------------------------

export async function getExecutionStatus(userId: string, executionId: string): Promise<BetExecution> {
  const execution = await getStore().getExecution(executionId);
  if (!execution || execution.userId !== userId) {
    throw new NotFoundError(`No bet found with id "${executionId}"`, { executionId });
  }
  return execution;
}

export async function listUserExecutions(userId: string, limit = 10): Promise<BetExecution[]> {
  return getStore().listExecutions(userId, { limit });
}

export async function listPendingSuggestions(userId: string, limit = 10): Promise<Suggestion[]> {
  const store = getStore();
  const [suggested, confirmed] = await Promise.all([
    store.listSuggestions(userId, { status: 'suggested', limit }),
    store.listSuggestions(userId, { status: 'confirmed', limit }),
  ]);
  return [...suggested, ...confirmed]
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
    .slice(0, limit);
}

/**
 * Persists an Analyst suggestion. Called by the graph after the Analyst returns,
 * never by the Analyst itself — the Analyst produces data, the orchestrator
 * decides what to store.
 */
export async function recordAnalystSuggestion(input: {
  userId: string;
  marketId: string;
  selectionId: string;
  suggestedStake: number;
  odds: number;
  confidence: number;
  rationale: string;
  source: string;
  traceId: string | null;
  channel: ClientChannel;
}): Promise<Suggestion> {
  const store = getStore();
  const user = await store.getUser(input.userId);
  const limits = resolveLimits(user?.limitsOverride ?? null);

  const suggestion: Suggestion = {
    id: newId('sug'),
    userId: input.userId,
    marketId: input.marketId,
    selectionId: input.selectionId,
    // Clamp rather than reject: the Analyst is advisory, and a suggestion above
    // the user's limit should still be shown, capped, not silently dropped.
    suggestedStake: round2(Math.min(Math.max(input.suggestedStake, limits.minStake), limits.maxStakePerBet)),
    odds: input.odds,
    confidence: input.confidence,
    rationale: input.rationale,
    source: input.source,
    status: 'suggested',
    traceId: input.traceId,
    createdAt: new Date(),
    expiresAt: new Date(Date.now() + limits.confirmationTtlSeconds * 1000),
  };

  await store.createSuggestion(suggestion);
  await audit({
    kind: 'suggestion_created',
    userId: input.userId,
    channel: input.channel,
    suggestionId: suggestion.id,
    agentRole: 'analyst',
    traceId: input.traceId,
    detail: {
      marketId: suggestion.marketId,
      selectionId: suggestion.selectionId,
      stake: suggestion.suggestedStake,
      odds: suggestion.odds,
      confidence: suggestion.confidence,
      clamped: suggestion.suggestedStake !== round2(input.suggestedStake),
    },
  });
  return suggestion;
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** Short, user-typeable handle for a suggestion (Telegram `/confirm A1B2C3`). */
export function confirmCodeFor(suggestionId: string): string {
  return suggestionId.slice(-6).toUpperCase();
}

async function resolveSuggestion(userId: string, suggestionOrCode: string): Promise<Suggestion> {
  const store = getStore();
  const direct = await store.getSuggestion(suggestionOrCode);
  if (direct) return direct;

  const code = suggestionOrCode.trim().toUpperCase();
  const recent = await store.listSuggestions(userId, { limit: 50 });
  const match = recent.find((s) => confirmCodeFor(s.id) === code);
  if (!match) {
    throw new NotFoundError(`No pending bet matches "${suggestionOrCode}"`, { reference: suggestionOrCode });
  }
  return match;
}

async function reject(
  input: { userId: string; channel: ClientChannel; ctx: TraceContext },
  suggestionId: string,
  reason: string,
): Promise<void> {
  await audit({
    kind: 'execution_rejected',
    userId: input.userId,
    channel: input.channel,
    suggestionId,
    agentRole: 'bet_placement',
    traceId: input.ctx.traceId,
    detail: { reason },
  });
}

function toOutcome(execution: BetExecution): ExecutionOutcome {
  return {
    executionId: execution.id,
    status: execution.txStatus === 'confirmed' ? 'confirmed' : execution.txStatus === 'pending' ? 'pending' : 'failed',
    txHash: execution.txHash,
    blockNumber: execution.blockNumber,
    stake: execution.stake,
    odds: execution.odds,
    marketId: execution.marketId,
    selectionId: execution.selectionId,
    potentialReturn: round2(execution.stake * execution.odds),
    reportedToUserAt: execution.reportedToUserAt ? execution.reportedToUserAt.toISOString() : null,
    failureReason: execution.failureReason,
    traceId: execution.traceId,
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function startOfUtcDay(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}
