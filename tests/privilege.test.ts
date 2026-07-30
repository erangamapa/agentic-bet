import { tool, type StructuredToolInterface } from '@langchain/core/tools';
import { beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  assertToolsAllowedForRole,
  assertValidGrant,
  registerTool,
  requestExecutionGrant,
  roleClearance,
} from '../src/agents/privilege.js';
import { describeToolCatalog } from '../src/agents/tool-catalog.js';
import { PrivilegeViolationError } from '../src/domain/errors.js';
import { newTraceContext } from '../src/observability/tracing.js';
import { buildAnalystTools } from '../src/tools/analyst-tools.js';
import { resetWorld, TEST_USER } from './helpers.js';

const makeTool = (name: string) =>
  tool(async () => 'ok', { name, description: 'test tool', schema: z.object({}) }) as unknown as StructuredToolInterface;

describe('privilege boundary', () => {
  beforeEach(async () => {
    await resetWorld();
  });

  it('caps the untrusted-content agent below execute clearance', () => {
    expect(roleClearance.analyst).toBe('read');
    expect(roleClearance.bet_placement).toBe('execute');
    expect(roleClearance.web_persona).toBe('delegate');
    expect(roleClearance.telegram_persona).toBe('delegate');
  });

  it('accepts a read tool for the analyst', () => {
    const t = registerTool(makeTool('read_something'), 'read');
    expect(() => assertToolsAllowedForRole('analyst', [t])).not.toThrow();
  });

  it('refuses an execute tool for the analyst', () => {
    const t = registerTool(makeTool('execute_something'), 'execute');
    expect(() => assertToolsAllowedForRole('analyst', [t])).toThrow(PrivilegeViolationError);
  });

  it('refuses an execute tool for a front-end persona', () => {
    const t = registerTool(makeTool('execute_something_else'), 'execute');
    expect(() => assertToolsAllowedForRole('web_persona', [t])).toThrow(PrivilegeViolationError);
    expect(() => assertToolsAllowedForRole('telegram_persona', [t])).toThrow(PrivilegeViolationError);
  });

  it('refuses a tool that was never classified', () => {
    expect(() => assertToolsAllowedForRole('analyst', [makeTool('unclassified')])).toThrow(
      /never registered with a clearance/,
    );
  });

  it('refuses to register the same tool name at two clearances', () => {
    registerTool(makeTool('ambiguous_tool'), 'read');
    expect(() => registerTool(makeTool('ambiguous_tool'), 'execute')).toThrow(PrivilegeViolationError);
  });

  it('only issues execution grants to the bet placement role', () => {
    expect(() => requestExecutionGrant('bet_placement')).not.toThrow();
    expect(() => requestExecutionGrant('analyst')).toThrow(PrivilegeViolationError);
    expect(() => requestExecutionGrant('web_persona')).toThrow(PrivilegeViolationError);
    expect(() => requestExecutionGrant('telegram_persona')).toThrow(PrivilegeViolationError);
  });

  it('rejects a forged grant', () => {
    expect(() => assertValidGrant({ role: 'bet_placement', issuedAt: new Date() }, 'probe')).toThrow(
      PrivilegeViolationError,
    );
    expect(() => assertValidGrant(null, 'probe')).toThrow(PrivilegeViolationError);
    expect(() => assertValidGrant({}, 'probe')).toThrow(PrivilegeViolationError);
  });

  it('gives the analyst only read tools', () => {
    const ctx = newTraceContext({ userId: TEST_USER, channel: 'web' });
    const tools = buildAnalystTools(ctx);
    expect(tools.length).toBeGreaterThan(0);
    expect(() => assertToolsAllowedForRole('analyst', tools)).not.toThrow();
    expect(() => assertToolsAllowedForRole('bet_placement', tools)).not.toThrow();
  });

  it('exposes exactly one execute-clearance tool across the whole system', () => {
    const catalog = describeToolCatalog();
    const executeTools = catalog.filter((t) => t.clearance === 'execute');
    expect(executeTools).toHaveLength(1);
    expect(executeTools[0]!.name).toBe('place_confirmed_bet');
    expect(executeTools[0]!.heldBy).toEqual(['bet_placement']);
  });

  it('never lets the analyst appear as a holder of an execute tool', () => {
    for (const t of describeToolCatalog()) {
      if (t.clearance === 'execute') expect(t.heldBy).not.toContain('analyst');
    }
  });
});
