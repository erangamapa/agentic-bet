import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';

// ---------------------------------------------------------------------------
// Agent roles — used for privilege enforcement, tracing tags and token accounting.
// ---------------------------------------------------------------------------

export const agentRoles = ['analyst', 'bet_placement', 'web_persona', 'telegram_persona'] as const;
export type AgentRole = (typeof agentRoles)[number];

export const clientChannels = ['web', 'telegram', 'cli', 'system'] as const;
export type ClientChannel = (typeof clientChannels)[number];

// ---------------------------------------------------------------------------
// Markets
// ---------------------------------------------------------------------------

export const marketSchema = z.object({
  id: z.string(),
  sport: z.string(),
  competition: z.string(),
  homeTeam: z.string(),
  awayTeam: z.string(),
  startsAt: z.string(),
  status: z.enum(['open', 'suspended', 'settled']),
  selections: z.array(
    z.object({
      id: z.string(),
      label: z.string(),
      odds: z.number().positive(),
    }),
  ),
});
export type Market = z.infer<typeof marketSchema>;

// ---------------------------------------------------------------------------
// Suggestion — the Analyst Agent's *only* output. Structured data, never an action.
// ---------------------------------------------------------------------------

export const suggestionStatuses = ['suggested', 'confirmed', 'dismissed', 'expired', 'executed'] as const;
export type SuggestionStatus = (typeof suggestionStatuses)[number];

/** Shape the Analyst is allowed to emit. Note: no wallet, no amount-in-wei, no tx fields. */
export const betSuggestionSchema = z.object({
  marketId: z.string().min(1).describe('Market identifier from the odds feed, e.g. "mkt_epl_ars_che_1x2"'),
  selectionId: z.string().min(1).describe('Which selection within the market, e.g. "home" / "draw" / "away"'),
  suggestedStake: z.number().positive().describe('Stake in account currency units the analyst proposes'),
  odds: z.number().positive().describe('Decimal odds observed for the selection at analysis time'),
  confidence: z.number().min(0).max(1).describe('Analyst confidence, 0-1'),
  rationale: z.string().min(1).describe('Reasoning shown to the user. Plain language, no instructions to the system.'),
  source: z.string().min(1).describe('Which content triggered this suggestion (feed id, post id, chat message id)'),
});
export type BetSuggestionInput = z.infer<typeof betSuggestionSchema>;

export interface Suggestion extends BetSuggestionInput {
  id: string;
  userId: string;
  status: SuggestionStatus;
  createdAt: Date;
  expiresAt: Date | null;
  /** Trace identifier of the analyst run that produced it. */
  traceId: string | null;
}

// ---------------------------------------------------------------------------
// Confirmation — an explicit, out-of-band user act. Never produced by an LLM.
// ---------------------------------------------------------------------------

export interface Confirmation {
  id: string;
  userId: string;
  /** Hash of the exact bet parameters the user agreed to. */
  intentHash: string;
  suggestionId: string | null;
  channel: ClientChannel;
  createdAt: Date;
  expiresAt: Date;
  consumedAt: Date | null;
  consumedByExecutionId: string | null;
}

/**
 * Binds a confirmation to exact parameters. If any parameter changes between
 * the confirmation and the execution, the hash no longer matches and the
 * execution is refused — so a manipulated agent cannot re-point a confirmed
 * bet at a different market or a larger stake.
 */
export function computeIntentHash(input: {
  userId: string;
  marketId: string;
  selectionId: string;
  stake: number;
  odds: number;
}): string {
  const canonical = [
    input.userId,
    input.marketId,
    input.selectionId,
    input.stake.toFixed(6),
    input.odds.toFixed(6),
  ].join('|');
  return createHash('sha256').update(canonical).digest('hex');
}

// ---------------------------------------------------------------------------
// BetExecution — the record of a real money movement.
// ---------------------------------------------------------------------------

export const txStatuses = ['pending', 'confirmed', 'failed', 'rejected'] as const;
export type TxStatus = (typeof txStatuses)[number];

export interface BetExecution {
  id: string;
  suggestionId: string | null;
  userId: string;
  marketId: string;
  selectionId: string;
  stake: number;
  odds: number;
  txStatus: TxStatus;
  txHash: string | null;
  blockNumber: number | null;
  /**
   * MUST only be set after txStatus === 'confirmed'. This is the field the
   * "never report success without a confirmed transaction" rule hangs off.
   */
  reportedToUserAt: Date | null;
  failureReason: string | null;
  channel: ClientChannel;
  confirmationId: string | null;
  intentHash: string;
  idempotencyKey: string;
  traceId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

// ---------------------------------------------------------------------------
// Audit log — every agent decision, tool call and outcome.
// ---------------------------------------------------------------------------

export const auditKinds = [
  'agent_invoked',
  'agent_completed',
  'agent_failed',
  'tool_called',
  'tool_succeeded',
  'tool_failed',
  'suggestion_created',
  'confirmation_created',
  'confirmation_consumed',
  'execution_requested',
  'execution_rejected',
  'execution_broadcast',
  'execution_confirmed',
  'execution_failed',
  'success_reported',
  'privilege_violation',
  'token_usage',
] as const;
export type AuditKind = (typeof auditKinds)[number];

export interface AuditEvent {
  id: string;
  userId: string | null;
  executionId: string | null;
  suggestionId: string | null;
  agentRole: AgentRole | null;
  channel: ClientChannel | null;
  kind: AuditKind;
  detail: Record<string, unknown>;
  traceId: string | null;
  runId: string | null;
  createdAt: Date;
}

// ---------------------------------------------------------------------------
// Token usage — per agent role, for the cost-control requirement.
// ---------------------------------------------------------------------------

export interface TokenUsageRecord {
  id: string;
  agentRole: AgentRole;
  model: string;
  provider: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  /** Approximate token cost of the tool schemas this agent carries per call. */
  toolSchemaTokens: number;
  userId: string | null;
  traceId: string | null;
  createdAt: Date;
}

export interface User {
  id: string;
  displayName: string;
  walletAddress: string | null;
  telegramId: string | null;
  limitsOverride: Record<string, number> | null;
  createdAt: Date;
}

export const newId = (prefix: string): string => `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 24)}`;
