import type { StructuredToolInterface } from '@langchain/core/tools';
import { PrivilegeViolationError } from '../domain/errors.js';
import type { AgentRole } from '../domain/types.js';
import { logger } from '../observability/logger.js';

/**
 * Clearance levels, ordered. A tool is registered at the clearance it *requires*;
 * an agent is created at the clearance it *has*. An agent may only hold tools
 * whose required clearance is <= its own.
 *
 *   read      — reads data. May read untrusted third-party content.
 *   delegate  — invokes another agent (agent-as-tool). Moves no money itself.
 *   execute   — moves real money. Exactly one agent role may hold these.
 */
export const clearanceLevels = ['read', 'delegate', 'execute'] as const;
export type Clearance = (typeof clearanceLevels)[number];

const clearanceRank: Record<Clearance, number> = { read: 0, delegate: 1, execute: 2 };

/**
 * The privilege ceiling for each agent role. This table is the single normative
 * statement of the security boundary in Section 2 of the spec:
 * the Analyst — the only agent that reads untrusted content — tops out at `read`,
 * so it is structurally incapable of holding the bet-execution tool. Not "is
 * instructed not to": cannot.
 */
export const roleClearance: Record<AgentRole, Clearance> = {
  analyst: 'read',
  bet_placement: 'execute',
  web_persona: 'delegate',
  telegram_persona: 'delegate',
};

/** Roles allowed to read untrusted external content (news, social, chat text). */
export const rolesReadingUntrustedContent: ReadonlySet<AgentRole> = new Set<AgentRole>(['analyst']);

/**
 * Roles permitted to hold `execute`-clearance tools. Kept separate from the
 * clearance table so that widening it requires an explicit, reviewable edit.
 */
export const executionRoles: ReadonlySet<AgentRole> = new Set<AgentRole>(['bet_placement']);

// ---------------------------------------------------------------------------
// Tool registry
// ---------------------------------------------------------------------------

const toolClearance = new WeakMap<object, Clearance>();
const registeredNames = new Map<string, Clearance>();

/**
 * Tags a tool with the clearance it requires. Every tool in the system goes
 * through here; anything untagged is rejected at agent-construction time, so a
 * tool cannot be smuggled in by forgetting to classify it.
 */
export function registerTool<T extends StructuredToolInterface>(tool: T, clearance: Clearance): T {
  toolClearance.set(tool, clearance);
  const previous = registeredNames.get(tool.name);
  if (previous && previous !== clearance) {
    throw new PrivilegeViolationError(
      `Tool "${tool.name}" is registered at two different clearances ("${previous}" and "${clearance}")`,
      { tool: tool.name },
    );
  }
  registeredNames.set(tool.name, clearance);
  return tool;
}

export function clearanceOf(tool: StructuredToolInterface): Clearance | undefined {
  return toolClearance.get(tool);
}

/** Clearance of every tool name seen so far — used by the boundary self-test. */
export function registeredToolClearances(): ReadonlyMap<string, Clearance> {
  return registeredNames;
}

/**
 * Throws unless every tool is allowed for the role. Called from the agent
 * factory, so a mis-wired agent fails at construction (process start), never at
 * request time with real money in flight.
 */
export function assertToolsAllowedForRole(role: AgentRole, tools: StructuredToolInterface[]): void {
  const ceiling = roleClearance[role];
  if (!ceiling) throw new PrivilegeViolationError(`Unknown agent role "${role}"`, { role });

  for (const tool of tools) {
    const required = toolClearance.get(tool);
    if (!required) {
      throw new PrivilegeViolationError(
        `Tool "${tool.name}" was never registered with a clearance. Wrap it in registerTool().`,
        { role, tool: tool.name },
      );
    }
    if (clearanceRank[required] > clearanceRank[ceiling]) {
      throw new PrivilegeViolationError(
        `Agent role "${role}" (clearance "${ceiling}") may not hold tool "${tool.name}" (requires "${required}")`,
        { role, tool: tool.name, required, ceiling },
      );
    }
    if (required === 'execute' && !executionRoles.has(role)) {
      throw new PrivilegeViolationError(
        `Only ${[...executionRoles].join(', ')} may hold execution tools; "${role}" attempted to hold "${tool.name}"`,
        { role, tool: tool.name },
      );
    }
  }

  logger.debug(
    { component: 'privilege', role, ceiling, tools: tools.map((t) => `${t.name}:${toolClearance.get(t)}`) },
    'Tool clearance check passed',
  );
}

// ---------------------------------------------------------------------------
// Execution grant — a capability token for constructing money-moving tools.
// ---------------------------------------------------------------------------

/**
 * Opaque capability required to construct the bet-execution tool. The brand is a
 * module-private symbol, so a grant cannot be forged from outside this module:
 * `{ role: 'bet_placement' }` does not type-check and does not pass the runtime
 * check either. The only way to obtain one is `requestExecutionGrant`, which
 * refuses every role except the Bet Placement Agent.
 */
const grantBrand = Symbol('agentic-bet.execution-grant');

export interface ExecutionGrant {
  readonly [grantBrand]: true;
  readonly role: AgentRole;
  readonly issuedAt: Date;
}

export function requestExecutionGrant(role: AgentRole): ExecutionGrant {
  if (!executionRoles.has(role)) {
    throw new PrivilegeViolationError(
      `Role "${role}" requested an execution grant. Only ${[...executionRoles].join(', ')} may hold one.`,
      { role },
    );
  }
  return Object.freeze({ [grantBrand]: true as const, role, issuedAt: new Date() });
}

/** Runtime validation for factories that build execute-clearance tools. */
export function assertValidGrant(grant: unknown, toolName: string): asserts grant is ExecutionGrant {
  const candidate = grant as Partial<ExecutionGrant> | null | undefined;
  if (!candidate || candidate[grantBrand] !== true || !candidate.role || !executionRoles.has(candidate.role)) {
    throw new PrivilegeViolationError(
      `Tool "${toolName}" was constructed without a valid execution grant`,
      { tool: toolName },
    );
  }
}
