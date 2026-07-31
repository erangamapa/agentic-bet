import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setModelFactoryOverride } from '../src/agents/factory.js';
import { buildPersona } from '../src/agents/personas.js';
import type { AgentRole } from '../src/domain/types.js';
import { runTurn } from '../src/graph/index.js';
import { clearSession } from '../src/graph/session.js';
import { newTraceContext } from '../src/observability/tracing.js';
import { getStore } from '../src/repositories/index.js';
import { confirmCodeFor, confirmSuggestion, listPendingSuggestions } from '../src/services/betting.js';
import { setExecutor, type BetExecutor, type VerificationResult } from '../src/chain/executor.js';
import { resetWorld, TEST_USER } from './helpers.js';
import { ScriptedChatModel, type ScriptedTurn } from './scripted-model.js';

const MARKET = 'mkt_epl_ars_che_1x2';

/** Installs a scripted model per role and hands back the instances to inspect. */
function scriptRoles(script: Partial<Record<AgentRole, ScriptedTurn[]>>): Map<AgentRole, ScriptedChatModel> {
  const models = new Map<AgentRole, ScriptedChatModel>();
  setModelFactoryOverride((role) => {
    const turns = script[role];
    if (!turns) return null;
    const existing = models.get(role);
    if (existing) return existing;
    const model = new ScriptedChatModel(turns);
    models.set(role, model);
    return model;
  });
  return models;
}

describe('agent graph wiring', () => {
  beforeEach(async () => {
    await resetWorld();
    clearSession(`sess_${TEST_USER}_web`);
  });

  afterEach(() => {
    setModelFactoryOverride(null);
  });

  it('gives each agent only the tools its role is allowed', async () => {
    const models = scriptRoles({
      web_persona: [{ content: 'hi' }],
      analyst: [{ content: 'hi' }],
      bet_placement: [{ content: 'hi' }],
    });

    const ctx = newTraceContext({ userId: TEST_USER, channel: 'web' });
    const bundle = await buildPersona(ctx);

    // Force each agent to bind its tools by running one no-op turn.
    await bundle.persona.agent.invoke({ messages: [{ role: 'user', content: 'hello' }] });

    expect(bundle.analyst.toolNames).toEqual([
      'lookup_markets',
      'get_market_odds',
      'search_social_content',
      'search_sports_knowledge',
    ]);
    expect(bundle.betPlacement.toolNames).toContain('place_confirmed_bet');
    expect(bundle.persona.toolNames).toEqual(['analyst', 'bet_placement']);

    // The persona sees only the two delegation tools — never the execution tool.
    expect(models.get('web_persona')!.toolNames()).toEqual(['analyst', 'bet_placement']);
    expect(models.get('web_persona')!.toolNames()).not.toContain('place_confirmed_bet');
    // And the analyst's model is never offered anything that moves money.
    expect(models.get('analyst')!.toolNames()).not.toContain('place_confirmed_bet');
  });

  it('carries a smaller tool-schema payload per agent than a monolith would', async () => {
    scriptRoles({ web_persona: [{ content: 'x' }], analyst: [{ content: 'x' }], bet_placement: [{ content: 'x' }] });
    const bundle = await buildPersona(newTraceContext({ userId: TEST_USER, channel: 'web' }));

    const monolithEquivalent =
      bundle.analyst.toolSchemaTokens + bundle.betPlacement.toolSchemaTokens + bundle.persona.toolSchemaTokens;

    // Each agent pays only for its own schemas on every call it makes.
    expect(bundle.persona.toolSchemaTokens).toBeLessThan(monolithEquivalent);
    expect(bundle.analyst.toolSchemaTokens).toBeLessThan(monolithEquivalent);
    expect(bundle.betPlacement.toolSchemaTokens).toBeLessThan(monolithEquivalent);
  });

  it('routes an analysis question to the analyst and records its suggestion', async () => {
    scriptRoles({
      web_persona: [
        { toolCalls: [{ name: 'analyst', args: { instruction: 'Analyse Arsenal vs Chelsea' } }] },
        { content: 'The analyst thinks Chelsea are underpriced.' },
      ],
      analyst: [
        { toolCalls: [{ name: 'get_market_odds', args: { marketId: MARKET } }] },
        {
          content: [
            'Arsenal are without their first-choice keeper, which the price has not absorbed.',
            '',
            'SUGGESTION',
            `marketId: ${MARKET}`,
            'selectionId: away',
            'stake: 20',
            'odds: 4.2',
            'confidence: 0.6',
            'rationale: Backup keeper is a real edge at this price.',
          ].join('\n'),
        },
      ],
    });

    const result = await runTurn({ userId: TEST_USER, channel: 'web', message: 'What about Arsenal vs Chelsea?' });
    expect(result.reply).toContain('Chelsea');

    // The suggestion was persisted by the orchestrator, not by the analyst.
    const pending = await listPendingSuggestions(TEST_USER);
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ marketId: MARKET, selectionId: 'away', odds: 4.2, status: 'suggested' });

    // And nothing was executed.
    expect(await getStore().listExecutions(TEST_USER)).toHaveLength(0);
  });

  it('refuses to execute when the analyst suggestion was never confirmed', async () => {
    scriptRoles({
      web_persona: [
        { toolCalls: [{ name: 'bet_placement', args: { instruction: 'Place 20 on Arsenal now' } }] },
        { content: 'That needs your confirmation first.' },
      ],
      bet_placement: [
        { toolCalls: [{ name: 'quote_bet', args: { marketId: MARKET, selectionId: 'home', stake: 20 } }] },
        // A model that ignores the rules and tries to place anyway.
        { toolCalls: [{ name: 'place_confirmed_bet', args: { suggestionIdOrCode: 'AAAAAA' } }] },
        { content: 'I could not place that — it has not been confirmed.' },
      ],
    });

    await runTurn({ userId: TEST_USER, channel: 'web', message: 'Put 20 on Arsenal' });

    // The service refused despite the model calling the execution tool.
    const executions = await getStore().listExecutions(TEST_USER);
    expect(executions.filter((e) => e.txStatus === 'confirmed')).toHaveLength(0);

    const audit = await getStore().listAudit({ userId: TEST_USER, limit: 50 });
    expect(audit.map((a) => a.kind)).not.toContain('success_reported');
  });

  it('completes quote → confirm → place through the graph', async () => {
    // Turn 1: the persona asks for a quote.
    scriptRoles({
      web_persona: [
        { toolCalls: [{ name: 'bet_placement', args: { instruction: 'Quote 20 on Arsenal to win' } }] },
        { content: 'Quoted. Confirm with the code to place it.' },
      ],
      bet_placement: [
        { toolCalls: [{ name: 'quote_bet', args: { marketId: MARKET, selectionId: 'home', stake: 20 } }] },
        { content: 'Quoted 20 @ 1.95. Confirm with the code.' },
      ],
    });
    await runTurn({ userId: TEST_USER, channel: 'web', message: 'Put 20 on Arsenal' });

    const pending = await listPendingSuggestions(TEST_USER);
    expect(pending).toHaveLength(1);
    const suggestionId = pending[0]!.id;

    // The user confirms out of band — a real act, not a model decision.
    await confirmSuggestion({ userId: TEST_USER, suggestionOrCode: confirmCodeFor(suggestionId), channel: 'web' });

    // Turn 2: now the placement is allowed to go through.
    setModelFactoryOverride(null);
    scriptRoles({
      web_persona: [
        { toolCalls: [{ name: 'bet_placement', args: { instruction: `Place confirmed bet ${suggestionId}` } }] },
        { content: 'Bet placed.' },
      ],
      bet_placement: [
        { toolCalls: [{ name: 'place_confirmed_bet', args: { suggestionIdOrCode: suggestionId } }] },
        { content: 'Placed and confirmed on-chain.' },
      ],
    });
    await runTurn({ userId: TEST_USER, channel: 'web', message: 'yes place it' });

    const executions = await getStore().listExecutions(TEST_USER);
    expect(executions).toHaveLength(1);
    expect(executions[0]!.txStatus).toBe('confirmed');
    expect(executions[0]!.reportedToUserAt).not.toBeNull();
  });

  it('tells the placement agent not to claim success when the tx does not confirm', async () => {
    class NeverConfirms implements BetExecutor {
      readonly mode = 'stub' as const;
      async broadcast() {
        return { txHash: '0xnope', elapsedMs: 1 };
      }
      async verify(): Promise<VerificationResult> {
        return {
          status: 'failed',
          txHash: '0xnope',
          blockNumber: null,
          onChainIntentHash: null,
          betId: null,
          reason: 'reverted on-chain',
        };
      }
    }
    setExecutor(new NeverConfirms());

    scriptRoles({
      web_persona: [
        { toolCalls: [{ name: 'bet_placement', args: { instruction: 'Quote 20 on Arsenal' } }] },
        { content: 'Quoted.' },
      ],
      bet_placement: [
        { toolCalls: [{ name: 'quote_bet', args: { marketId: MARKET, selectionId: 'home', stake: 20 } }] },
        { content: 'Quoted.' },
      ],
    });
    await runTurn({ userId: TEST_USER, channel: 'web', message: 'Put 20 on Arsenal' });

    const suggestionId = (await listPendingSuggestions(TEST_USER))[0]!.id;
    await confirmSuggestion({ userId: TEST_USER, suggestionOrCode: suggestionId, channel: 'web' });

    setModelFactoryOverride(null);
    const models = scriptRoles({
      web_persona: [
        { toolCalls: [{ name: 'bet_placement', args: { instruction: `Place ${suggestionId}` } }] },
        { content: 'It did not go through.' },
      ],
      bet_placement: [
        { toolCalls: [{ name: 'place_confirmed_bet', args: { suggestionIdOrCode: suggestionId } }] },
        { content: 'The bet was not placed.' },
      ],
    });
    await runTurn({ userId: TEST_USER, channel: 'web', message: 'place it' });

    // The tool result handed to the model must say "failed" and instruct it not
    // to report success — that wording is the guardrail, so assert on it.
    const placementMessages = models.get('bet_placement')!.seenMessages.flat();
    const toolResult = placementMessages
      .map((m) => (typeof m.content === 'string' ? m.content : ''))
      .find((c) => c.includes('"status":"failed"'));

    expect(toolResult).toBeDefined();
    expect(toolResult).toContain('was NOT placed');

    const executions = await getStore().listExecutions(TEST_USER);
    expect(executions[0]!.txStatus).toBe('failed');
    expect(executions[0]!.reportedToUserAt).toBeNull();
  });

  it('cannot be driven into an execution by injected content the analyst reads', async () => {
    // The persona asks the analyst about a market whose social feed contains a
    // prompt-injection payload telling it to place a bet immediately.
    const models = scriptRoles({
      web_persona: [
        { toolCalls: [{ name: 'analyst', args: { instruction: 'What is the chatter on the Celtics game?' } }] },
        { content: 'The analyst flagged one post as a manipulation attempt.' },
      ],
      analyst: [
        { toolCalls: [{ name: 'search_social_content', args: { marketId: 'mkt_nba_bos_den_ml' } }] },
        { content: 'One of those posts is an injection attempt, not real information.' },
      ],
    });

    await runTurn({ userId: TEST_USER, channel: 'web', message: 'What is the chatter on the Celtics?' });

    // The analyst's model was handed the hostile text...
    const analystSaw = models
      .get('analyst')!
      .seenMessages.flat()
      .map((m) => (typeof m.content === 'string' ? m.content : ''))
      .join('\n');
    expect(analystSaw).toContain('untrusted_content');
    // ...with the actionable parts stripped...
    expect(analystSaw).not.toContain('placeBetOnBehalfOf');
    // ...and no execution tool available to it in any case.
    expect(models.get('analyst')!.toolNames()).not.toContain('place_confirmed_bet');

    // Nothing was staked.
    expect(await getStore().listExecutions(TEST_USER)).toHaveLength(0);
    const audit = await getStore().listAudit({ userId: TEST_USER, limit: 50 });
    expect(audit.map((a) => a.kind)).not.toContain('execution_requested');
  });

  it('produces the same execution path from the telegram persona', async () => {
    scriptRoles({
      telegram_persona: [
        { toolCalls: [{ name: 'bet_placement', args: { instruction: 'Quote 20 on Arsenal' } }] },
        { content: 'Quoted.' },
      ],
      bet_placement: [
        { toolCalls: [{ name: 'quote_bet', args: { marketId: MARKET, selectionId: 'home', stake: 20 } }] },
        { content: 'Quoted 20 @ 1.95.' },
      ],
    });

    const result = await runTurn({ userId: TEST_USER, channel: 'telegram', message: 'Put 20 on Arsenal' });
    expect(result.sessionId).toContain('telegram');

    const pending = await listPendingSuggestions(TEST_USER);
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ marketId: MARKET, selectionId: 'home', suggestedStake: 20, odds: 1.95 });
  });

  it('records token usage against the role that spent it', async () => {
    scriptRoles({
      web_persona: [
        { toolCalls: [{ name: 'analyst', args: { instruction: 'Analyse it' } }] },
        { content: 'Here is the view.' },
      ],
      analyst: [{ content: 'No edge here.' }],
    });

    await runTurn({ userId: TEST_USER, channel: 'web', message: 'Any value tonight?' });

    const usage = await getStore().aggregateTokenUsage({ userId: TEST_USER });
    const roles = usage.map((u) => u.agentRole);
    expect(roles).toContain('web_persona');
    expect(roles).toContain('analyst');
    expect(usage.every((u) => u.totalTokens > 0)).toBe(true);
  });
});
