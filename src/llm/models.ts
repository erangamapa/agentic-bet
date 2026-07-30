import { ChatAnthropic } from '@langchain/anthropic';
import { ChatOpenAI } from '@langchain/openai';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { env, hasLlm } from '../config/env.js';
import { ConfigurationError } from '../domain/errors.js';
import { logger } from '../observability/logger.js';

export type ProviderId = 'anthropic' | 'openai';

export interface ModelSpec {
  provider: ProviderId;
  model: string;
  /** `provider:model`, the canonical form used in env config and logs. */
  id: string;
}

/** Parses `anthropic:claude-sonnet-5` into a spec. Bare ids are inferred by prefix. */
export function parseModelId(id: string): ModelSpec {
  const [maybeProvider, ...rest] = id.split(':');
  if (rest.length > 0 && (maybeProvider === 'anthropic' || maybeProvider === 'openai')) {
    const model = rest.join(':');
    return { provider: maybeProvider, model, id: `${maybeProvider}:${model}` };
  }
  const provider: ProviderId = id.toLowerCase().startsWith('claude') ? 'anthropic' : 'openai';
  return { provider, model: id, id: `${provider}:${id}` };
}

export function isProviderConfigured(provider: ProviderId): boolean {
  return provider === 'anthropic' ? Boolean(env.ANTHROPIC_API_KEY) : Boolean(env.OPENAI_API_KEY);
}

export interface BuildModelOptions {
  temperature?: number;
  maxTokens?: number;
  /** Fail fast per attempt so the fallback model gets a chance within the request budget. */
  timeoutMs?: number;
}

export function buildModel(spec: ModelSpec, opts: BuildModelOptions = {}): BaseChatModel {
  const temperature = opts.temperature ?? 0.2;
  const maxTokens = opts.maxTokens ?? 2048;
  const timeout = opts.timeoutMs ?? 60_000;

  if (spec.provider === 'anthropic') {
    if (!env.ANTHROPIC_API_KEY) throw new ConfigurationError('ANTHROPIC_API_KEY is not configured');
    return new ChatAnthropic({
      model: spec.model,
      apiKey: env.ANTHROPIC_API_KEY,
      temperature,
      maxTokens,
      // One in-provider retry; cross-provider failover is handled by middleware.
      maxRetries: 1,
      ...({ timeout } as Record<string, unknown>),
    });
  }

  if (!env.OPENAI_API_KEY) throw new ConfigurationError('OPENAI_API_KEY is not configured');
  return new ChatOpenAI({
    model: spec.model,
    apiKey: env.OPENAI_API_KEY,
    temperature,
    maxTokens,
    maxRetries: 1,
    timeout,
  });
}

/**
 * Resolves the model chain for an agent: `[primary, ...fallbacks]`, filtered to
 * providers that are actually credentialed. Production reliability requirement
 * from the spec — no single hardcoded provider.
 *
 * Returns model *ids*; the caller turns the head into a model instance and the
 * tail into `modelFallbackMiddleware` arguments.
 */
export function resolveModelChain(preferred?: string): ModelSpec[] {
  if (!hasLlm) {
    throw new ConfigurationError(
      'No LLM provider configured. Set ANTHROPIC_API_KEY and/or OPENAI_API_KEY.',
    );
  }

  const candidates = [preferred, env.PRIMARY_MODEL, env.FALLBACK_MODEL]
    .filter((v): v is string => Boolean(v))
    .map(parseModelId);

  // De-duplicate while preserving order, and drop providers without credentials.
  const seen = new Set<string>();
  const chain: ModelSpec[] = [];
  for (const spec of candidates) {
    if (seen.has(spec.id)) continue;
    if (!isProviderConfigured(spec.provider)) {
      logger.debug({ component: 'llm', model: spec.id }, 'Skipping model — provider not configured');
      continue;
    }
    seen.add(spec.id);
    chain.push(spec);
  }

  if (chain.length === 0) {
    // Configured keys exist but none matched the requested models — fall back to
    // a sane default per available provider rather than failing the request.
    const defaults: ModelSpec[] = [];
    if (env.ANTHROPIC_API_KEY) defaults.push(parseModelId('anthropic:claude-sonnet-5'));
    if (env.OPENAI_API_KEY) defaults.push(parseModelId('openai:gpt-4.1'));
    if (defaults.length === 0) throw new ConfigurationError('No usable LLM provider found');
    logger.warn(
      { component: 'llm', chain: defaults.map((d) => d.id) },
      'Configured model ids had no credentialed provider — using provider defaults',
    );
    return defaults;
  }

  return chain;
}

/** Human-readable summary used by /health and startup logs. */
export function describeModelChain(preferred?: string): { primary: string; fallbacks: string[] } | null {
  try {
    const chain = resolveModelChain(preferred);
    return { primary: chain[0]!.id, fallbacks: chain.slice(1).map((c) => c.id) };
  } catch {
    return null;
  }
}
