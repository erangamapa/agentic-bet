import { env } from './env.js';

/**
 * Risk rules enforced by the Bet Placement Agent's execution path.
 *
 * These are deliberately *code* constants, not prompt text: an LLM is never the
 * thing that decides whether a stake is within limits. The model may explain a
 * limit to the user, but `assertWithinLimits` is what actually gates execution.
 */
export interface RiskLimits {
  minStake: number;
  maxStakePerBet: number;
  maxStakePerDay: number;
  maxOpenBets: number;
  maxOdds: number;
  /** How long a user confirmation stays valid before it must be re-issued. */
  confirmationTtlSeconds: number;
}

export const defaultRiskLimits: RiskLimits = {
  minStake: env.MIN_STAKE,
  maxStakePerBet: env.MAX_STAKE_PER_BET,
  maxStakePerDay: env.MAX_STAKE_PER_DAY,
  maxOpenBets: env.MAX_OPEN_BETS,
  maxOdds: env.MAX_ODDS,
  confirmationTtlSeconds: env.CONFIRMATION_TTL_SECONDS,
};

/** Per-user overrides layered on top of the global defaults. */
export function resolveLimits(overrides?: Partial<RiskLimits> | null): RiskLimits {
  if (!overrides) return defaultRiskLimits;
  return { ...defaultRiskLimits, ...stripNullish(overrides) };
}

function stripNullish<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== null && v !== undefined)) as Partial<T>;
}
