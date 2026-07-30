import { BaseCallbackHandler } from '@langchain/core/callbacks/base';
import type { LLMResult } from '@langchain/core/outputs';
import type { Serialized } from '@langchain/core/load/serializable';
import { newId, type AgentRole, type TokenUsageRecord } from '../domain/types.js';
import { getStore } from '../repositories/index.js';
import { logger } from './logger.js';

/**
 * Rough token estimate for a JSON tool schema. Good enough for the cost-control
 * goal: we care about the *relative* overhead each agent carries, not an exact
 * provider-billed number. ~4 characters per token is the usual approximation.
 */
export function estimateSchemaTokens(schemas: unknown[]): number {
  if (schemas.length === 0) return 0;
  const json = JSON.stringify(schemas);
  return Math.ceil(json.length / 4);
}

interface UsageCounts {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

function extractUsage(output: LLMResult): UsageCounts {
  // Providers report usage in a few different shapes; check them in order of preference.
  const generation = output.generations?.[0]?.[0] as
    | { message?: { usage_metadata?: { input_tokens?: number; output_tokens?: number; total_tokens?: number } } }
    | undefined;
  const meta = generation?.message?.usage_metadata;
  if (meta) {
    const input = meta.input_tokens ?? 0;
    const outputTokens = meta.output_tokens ?? 0;
    return { inputTokens: input, outputTokens, totalTokens: meta.total_tokens ?? input + outputTokens };
  }

  const llmOutput = output.llmOutput as
    | {
        tokenUsage?: { promptTokens?: number; completionTokens?: number; totalTokens?: number };
        usage?: { input_tokens?: number; output_tokens?: number };
      }
    | undefined;

  if (llmOutput?.tokenUsage) {
    const input = llmOutput.tokenUsage.promptTokens ?? 0;
    const outputTokens = llmOutput.tokenUsage.completionTokens ?? 0;
    return { inputTokens: input, outputTokens, totalTokens: llmOutput.tokenUsage.totalTokens ?? input + outputTokens };
  }
  if (llmOutput?.usage) {
    const input = llmOutput.usage.input_tokens ?? 0;
    const outputTokens = llmOutput.usage.output_tokens ?? 0;
    return { inputTokens: input, outputTokens, totalTokens: input + outputTokens };
  }
  return { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
}

/**
 * Attributes every LLM call to the agent role that made it. Attached per-agent
 * rather than globally, which is what makes "cost per role" answerable — and by
 * extension what makes the "don't build one monolithic agent" argument
 * measurable instead of theoretical.
 */
export class TokenUsageHandler extends BaseCallbackHandler {
  name = 'token_usage_handler';
  override awaitHandlers = false;

  private readonly agentRole: AgentRole;
  private readonly toolSchemaTokens: number;
  private readonly getUserId: () => string | null;
  private readonly getTraceId: () => string | null;

  constructor(opts: {
    agentRole: AgentRole;
    toolSchemaTokens: number;
    getUserId?: () => string | null;
    getTraceId?: () => string | null;
  }) {
    super();
    this.agentRole = opts.agentRole;
    this.toolSchemaTokens = opts.toolSchemaTokens;
    this.getUserId = opts.getUserId ?? (() => null);
    this.getTraceId = opts.getTraceId ?? (() => null);
  }

  override async handleLLMEnd(output: LLMResult, _runId: string, _parentRunId?: string, _tags?: string[]): Promise<void> {
    const usage = extractUsage(output);
    if (usage.totalTokens === 0) return;

    const modelName =
      ((output.llmOutput as { model_name?: string; model?: string } | undefined)?.model_name ??
        (output.llmOutput as { model?: string } | undefined)?.model) ||
      'unknown';

    const record: TokenUsageRecord = {
      id: newId('tok'),
      agentRole: this.agentRole,
      model: modelName,
      provider: providerOf(modelName),
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      totalTokens: usage.totalTokens,
      toolSchemaTokens: this.toolSchemaTokens,
      userId: this.getUserId(),
      traceId: this.getTraceId(),
      createdAt: new Date(),
    };

    try {
      await getStore().recordTokenUsage(record);
    } catch (err) {
      logger.error({ component: 'token-usage', err }, 'Failed to persist token usage');
    }

    logger.debug(
      {
        component: 'token-usage',
        agentRole: record.agentRole,
        model: record.model,
        inputTokens: record.inputTokens,
        outputTokens: record.outputTokens,
        toolSchemaTokens: record.toolSchemaTokens,
      },
      'LLM call accounted',
    );
  }

  override async handleLLMError(err: Error, _runId: string, _parentRunId?: string): Promise<void> {
    logger.warn({ component: 'token-usage', agentRole: this.agentRole, err: err.message }, 'LLM call failed');
  }

  // Present so the handler is a valid CallbackHandler for chain-level events too.
  override async handleChainStart(_chain: Serialized): Promise<void> {
    /* no-op */
  }
}

function providerOf(model: string): string {
  const lower = model.toLowerCase();
  if (lower.includes('claude')) return 'anthropic';
  if (lower.startsWith('gpt') || lower.startsWith('o1') || lower.startsWith('o3')) return 'openai';
  return 'unknown';
}
