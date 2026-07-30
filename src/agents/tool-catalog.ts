import type { AgentRole } from '../domain/types.js';
import { newTraceContext } from '../observability/tracing.js';
import { buildAnalystTools } from '../tools/analyst-tools.js';
import { buildBetPlacementTools } from './bet-placement.js';
import { assertToolsAllowedForRole, clearanceOf, requestExecutionGrant, type Clearance } from './privilege.js';

export interface ToolDescriptor {
  name: string;
  clearance: Clearance;
  heldBy: AgentRole[];
  descriptionChars: number;
}

/**
 * Instantiates every tool set once, without any LLM, so the full privilege map
 * can be inspected at startup rather than only after a user happens to trigger
 * the code path. Doubles as a boot-time assertion: if a tool were ever wired to
 * the wrong role, the process fails here instead of mid-conversation.
 */
export function describeToolCatalog(): ToolDescriptor[] {
  const ctx = newTraceContext({ userId: '__catalog__', channel: 'system' });

  const analystTools = buildAnalystTools(ctx);
  assertToolsAllowedForRole('analyst', analystTools);

  const betTools = buildBetPlacementTools(ctx, requestExecutionGrant('bet_placement'));
  assertToolsAllowedForRole('bet_placement', betTools);

  const byName = new Map<string, ToolDescriptor>();

  const add = (tools: typeof analystTools, role: AgentRole) => {
    for (const t of tools) {
      const existing = byName.get(t.name);
      if (existing) {
        if (!existing.heldBy.includes(role)) existing.heldBy.push(role);
        continue;
      }
      byName.set(t.name, {
        name: t.name,
        clearance: clearanceOf(t) ?? 'read',
        heldBy: [role],
        descriptionChars: t.description?.length ?? 0,
      });
    }
  };

  add(analystTools, 'analyst');
  add(betTools, 'bet_placement');

  // The delegation wrappers the personas hold are named here rather than
  // instantiated: constructing them requires live specialist agents, and their
  // clearance is fixed by agentAsTool regardless.
  byName.set('analyst', {
    name: 'analyst',
    clearance: 'delegate',
    heldBy: ['web_persona', 'telegram_persona'],
    descriptionChars: 0,
  });
  byName.set('bet_placement', {
    name: 'bet_placement',
    clearance: 'delegate',
    heldBy: ['web_persona', 'telegram_persona'],
    descriptionChars: 0,
  });

  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}
