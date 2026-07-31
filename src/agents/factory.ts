import { createAgent, modelFallbackMiddleware, type ReactAgent } from 'langchain';
import type { StructuredToolInterface } from '@langchain/core/tools';
import type { BaseCallbackHandler } from '@langchain/core/callbacks/base';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { buildModel, resolveModelChain, type ModelSpec } from '../llm/models.js';
import type { AgentRole } from '../domain/types.js';
import { logger } from '../observability/logger.js';
import { estimateSchemaTokens, TokenUsageHandler } from '../observability/token-usage.js';
import { assertToolsAllowedForRole, roleClearance } from './privilege.js';

export interface BuiltAgent {
  role: AgentRole;
  agent: ReactAgent;
  /** Handler attached to this agent's LLM calls, for per-role cost accounting. */
  usageHandler: BaseCallbackHandler;
  /** Approximate token cost of the tool schemas this agent carries per call. */
  toolSchemaTokens: number;
  toolNames: string[];
  modelChain: ModelSpec[];
}

/**
 * Test seam: supplies a chat model per role instead of building a provider
 * client. Null in production. It exists so the graph — delegation, tool calls,
 * privilege checks — can be exercised deterministically and without an API key;
 * the clearance assertions below still run unchanged when it is in use.
 */
type ModelFactoryOverride = (role: AgentRole) => BaseChatModel | null;

let modelFactoryOverride: ModelFactoryOverride | null = null;

export function setModelFactoryOverride(override: ModelFactoryOverride | null): void {
  modelFactoryOverride = override;
}

export interface CreateScopedAgentOptions {
  role: AgentRole;
  systemPrompt: string;
  tools: StructuredToolInterface[];
  /** Overrides PRIMARY_MODEL for this role. */
  preferredModel?: string;
  temperature?: number;
  maxTokens?: number;
  getUserId?: () => string | null;
  getTraceId?: () => string | null;
}

/**
 * The only way an agent is constructed in this system.
 *
 * Two guarantees it provides that a bare `createAgent` call would not:
 *  - every tool is clearance-checked against the role before the agent exists,
 *    so a privilege mistake is a startup crash rather than a runtime incident;
 *  - every LLM call is attributed to the role, with the tool-schema overhead
 *    recorded alongside it, which is what makes the cost argument measurable.
 */
export function createScopedAgent(opts: CreateScopedAgentOptions): BuiltAgent {
  // Runs first, and unconditionally — a privilege mistake must never depend on
  // which model or provider happens to be configured.
  assertToolsAllowedForRole(opts.role, opts.tools);

  const injected = modelFactoryOverride?.(opts.role) ?? null;

  const modelChain = injected ? [{ provider: 'anthropic' as const, model: 'injected', id: 'injected' }] : resolveModelChain(opts.preferredModel);
  const [primary, ...fallbacks] = modelChain;

  const model =
    injected ??
    buildModel(primary!, {
      ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
      ...(opts.maxTokens !== undefined ? { maxTokens: opts.maxTokens } : {}),
    });

  const toolSchemaTokens = estimateSchemaTokens(
    opts.tools.map((t) => ({ name: t.name, description: t.description, schema: t.schema })),
  );

  const usageHandler = new TokenUsageHandler({
    agentRole: opts.role,
    toolSchemaTokens,
    ...(opts.getUserId ? { getUserId: opts.getUserId } : {}),
    ...(opts.getTraceId ? { getTraceId: opts.getTraceId } : {}),
  });

  const middleware = fallbacks.length
    ? [
        modelFallbackMiddleware(
          ...fallbacks.map((spec) =>
            buildModel(spec, {
              ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
              ...(opts.maxTokens !== undefined ? { maxTokens: opts.maxTokens } : {}),
            }),
          ),
        ),
      ]
    : [];

  const agent = createAgent({
    model,
    tools: opts.tools,
    systemPrompt: opts.systemPrompt,
    name: `${opts.role}_agent`,
    middleware,
  }) as unknown as ReactAgent;

  logger.info(
    {
      component: 'agent-factory',
      role: opts.role,
      clearance: roleClearance[opts.role],
      tools: opts.tools.map((t) => t.name),
      toolSchemaTokens,
      model: primary!.id,
      fallbacks: fallbacks.map((f) => f.id),
    },
    'Agent constructed',
  );

  return {
    role: opts.role,
    agent,
    usageHandler,
    toolSchemaTokens,
    toolNames: opts.tools.map((t) => t.name),
    modelChain,
  };
}
