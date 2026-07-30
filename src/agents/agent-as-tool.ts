import { tool, type StructuredToolInterface } from '@langchain/core/tools';
import { z } from 'zod';
import { audit } from '../observability/audit.js';
import type { TraceContext } from '../observability/tracing.js';
import type { BuiltAgent } from './factory.js';
import { registerTool, type Clearance } from './privilege.js';

export interface AgentAsToolOptions {
  name: string;
  description: string;
  /**
   * Clearance the *caller* needs to hold this delegation tool. Always `delegate`:
   * a front-end persona is allowed to hand work to a specialist, but it does not
   * thereby acquire that specialist's clearance. The Bet Placement Agent's
   * `execute` privilege stays inside the Bet Placement Agent.
   */
  clearance?: Clearance;
  inputDescription?: string;
  run: (instruction: string) => Promise<string>;
}

/**
 * Wraps an agent as a tool the front-end personas can call.
 *
 * This is the mechanism that keeps web and Telegram from drifting: neither
 * persona contains betting logic, both call the *same* Bet Placement Agent
 * through the same wrapper. Changing a stake limit or the confirmation flow is
 * a one-place change by construction, not by convention.
 *
 * Privilege does not flow through the wrapper. The persona holds a `delegate`
 * tool; the tool's implementation holds the specialist. A persona cannot reach
 * past the wrapper into the specialist's tool set.
 */
export function agentAsTool(ctx: TraceContext, opts: AgentAsToolOptions): StructuredToolInterface {
  const wrapped = tool(
    async ({ instruction }: { instruction: string }) => {
      await audit({
        kind: 'tool_called',
        userId: ctx.userId,
        channel: ctx.channel,
        traceId: ctx.traceId,
        detail: { tool: opts.name, delegation: true, instruction: instruction.slice(0, 400) },
      });
      try {
        const reply = await opts.run(instruction);
        await audit({
          kind: 'tool_succeeded',
          userId: ctx.userId,
          channel: ctx.channel,
          traceId: ctx.traceId,
          executionId: ctx.executionId ?? null,
          detail: { tool: opts.name, replyChars: reply.length },
        });
        return reply;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await audit({
          kind: 'tool_failed',
          userId: ctx.userId,
          channel: ctx.channel,
          traceId: ctx.traceId,
          detail: { tool: opts.name, error: message },
        });
        return `The ${opts.name} agent could not complete that request: ${message}. Tell the user plainly; do not guess at what it would have said.`;
      }
    },
    {
      name: opts.name,
      description: opts.description,
      schema: z.object({
        instruction: z
          .string()
          .describe(
            opts.inputDescription ??
              'What you need from this agent, in full sentences. Include everything it needs — it does not see the conversation.',
          ),
      }),
    },
  );

  return registerTool(wrapped as unknown as StructuredToolInterface, opts.clearance ?? 'delegate');
}

/** Convenience overload for a {@link BuiltAgent} with a standard runner. */
export function builtAgentAsTool(
  ctx: TraceContext,
  built: BuiltAgent,
  opts: Omit<AgentAsToolOptions, 'run'> & { run: (built: BuiltAgent, instruction: string) => Promise<string> },
): StructuredToolInterface {
  return agentAsTool(ctx, { ...opts, run: (instruction) => opts.run(built, instruction) });
}
