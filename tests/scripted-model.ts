import { BaseChatModel, type BaseChatModelCallOptions } from '@langchain/core/language_models/chat_models';
import type { BindToolsInput } from '@langchain/core/language_models/chat_models';
import { AIMessage, type BaseMessage } from '@langchain/core/messages';
import type { ChatResult } from '@langchain/core/outputs';
import type { Runnable } from '@langchain/core/runnables';

export interface ScriptedTurn {
  /** Tool calls this turn should emit. Empty/omitted means the agent finishes. */
  toolCalls?: { name: string; args: Record<string, unknown> }[];
  /** Text content for the turn. */
  content?: string;
}

/**
 * A chat model whose replies are scripted rather than sampled.
 *
 * This exists so the *graph* can be tested for real — persona delegating to a
 * specialist via agent-as-tool, the specialist calling its tools, results
 * flowing back — without an API key and without the flakiness of asserting on
 * generated prose. What is under test here is the wiring and the privilege
 * boundary, both of which must hold regardless of what any model says.
 */
export class ScriptedChatModel extends BaseChatModel {
  private readonly turns: ScriptedTurn[];
  private cursor = 0;

  /** Tools the agent bound to this model — asserted on in privilege tests. */
  boundTools: BindToolsInput[] = [];
  /** Every message list this model was asked to complete, for inspection. */
  readonly seenMessages: BaseMessage[][] = [];

  constructor(turns: ScriptedTurn[]) {
    super({});
    this.turns = turns;
  }

  _llmType(): string {
    return 'scripted';
  }

  override bindTools(tools: BindToolsInput[], kwargs?: Partial<BaseChatModelCallOptions>): Runnable {
    this.boundTools = tools;
    return this.withConfig({ ...(kwargs ?? {}) }) as unknown as Runnable;
  }

  async _generate(messages: BaseMessage[]): Promise<ChatResult> {
    this.seenMessages.push(messages);

    const turn = this.turns[this.cursor] ?? { content: 'done' };
    this.cursor += 1;

    const message = new AIMessage({
      content: turn.content ?? '',
      tool_calls: (turn.toolCalls ?? []).map((call, index) => ({
        id: `call_${this.cursor}_${index}`,
        name: call.name,
        args: call.args,
        type: 'tool_call' as const,
      })),
      usage_metadata: { input_tokens: 100, output_tokens: 40, total_tokens: 140 },
    });

    return { generations: [{ text: turn.content ?? '', message }], llmOutput: { model_name: 'scripted' } };
  }

  /** Names of the tools this model was given, in binding order. */
  toolNames(): string[] {
    return this.boundTools.map((t) => (t as { name?: string }).name ?? 'unknown');
  }

  reset(): void {
    this.cursor = 0;
    this.seenMessages.length = 0;
  }
}
