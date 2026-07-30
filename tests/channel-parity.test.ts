import { beforeEach, describe, expect, it } from 'vitest';
import { requestExecutionGrant } from '../src/agents/privilege.js';
import { newTraceContext } from '../src/observability/tracing.js';
import { getStore } from '../src/repositories/index.js';
import { confirmSuggestion, placeConfirmedBet, quoteBet } from '../src/services/betting.js';
import { TELEGRAM_PERSONA_PROMPT, WEB_PERSONA_PROMPT } from '../src/agents/prompts.js';
import { resetWorld, TEST_USER } from './helpers.js';

const MARKET = 'mkt_epl_liv_mci_1x2';
const SELECTION = 'away';

/**
 * Spec requirement: web and Telegram must produce identical betting behaviour
 * for equivalent input. These tests assert that at the layer where it matters —
 * the shared privileged service — rather than by comparing two LLM transcripts.
 */
describe('web/telegram parity', () => {
  beforeEach(async () => {
    await resetWorld();
  });

  it('produces identical quotes for identical input', async () => {
    const web = await quoteBet({
      userId: TEST_USER,
      marketId: MARKET,
      selectionId: SELECTION,
      stake: 40,
      channel: 'web',
    });
    const telegram = await quoteBet({
      userId: TEST_USER,
      marketId: MARKET,
      selectionId: SELECTION,
      stake: 40,
      channel: 'telegram',
    });

    expect(telegram.intentHash).toBe(web.intentHash);
    expect(telegram.stake).toBe(web.stake);
    expect(telegram.odds).toBe(web.odds);
    expect(telegram.potentialReturn).toBe(web.potentialReturn);
    expect(telegram.limits).toEqual(web.limits);
  });

  it('refuses an over-limit stake with the same message on both channels', async () => {
    const errors: string[] = [];
    for (const channel of ['web', 'telegram'] as const) {
      await quoteBet({ userId: TEST_USER, marketId: MARKET, selectionId: SELECTION, stake: 9999, channel }).catch(
        (err: Error) => errors.push(err.message),
      );
    }
    expect(errors).toHaveLength(2);
    expect(errors[0]).toBe(errors[1]);
  });

  it('honours a Telegram confirmation when the bet is placed from the web', async () => {
    const quote = await quoteBet({
      userId: TEST_USER,
      marketId: MARKET,
      selectionId: SELECTION,
      stake: 30,
      channel: 'telegram',
    });
    await confirmSuggestion({ userId: TEST_USER, suggestionOrCode: quote.confirmCode, channel: 'telegram' });

    const outcome = await placeConfirmedBet(requestExecutionGrant('bet_placement'), {
      userId: TEST_USER,
      suggestionOrCode: quote.suggestionId,
      channel: 'web',
      ctx: newTraceContext({ userId: TEST_USER, channel: 'web' }),
    });

    expect(outcome.status).toBe('confirmed');
  });

  it('records the originating channel on the execution without changing the outcome', async () => {
    const outcomes = [];
    for (const channel of ['web', 'telegram'] as const) {
      const quote = await quoteBet({
        userId: TEST_USER,
        marketId: MARKET,
        selectionId: SELECTION,
        stake: 20,
        channel,
      });
      await confirmSuggestion({ userId: TEST_USER, suggestionOrCode: quote.suggestionId, channel });
      outcomes.push(
        await placeConfirmedBet(requestExecutionGrant('bet_placement'), {
          userId: TEST_USER,
          suggestionOrCode: quote.suggestionId,
          channel,
          ctx: newTraceContext({ userId: TEST_USER, channel }),
        }),
      );
    }

    expect(outcomes.map((o) => o.status)).toEqual(['confirmed', 'confirmed']);
    expect(outcomes[0]!.stake).toBe(outcomes[1]!.stake);
    expect(outcomes[0]!.odds).toBe(outcomes[1]!.odds);

    const stored = await getStore().listExecutions(TEST_USER, { limit: 10 });
    expect(new Set(stored.map((e) => e.channel))).toEqual(new Set(['web', 'telegram']));
  });

  it('gives both personas the same delegation instructions, differing only in presentation', () => {
    for (const prompt of [WEB_PERSONA_PROMPT, TELEGRAM_PERSONA_PROMPT]) {
      // Both must delegate all money handling and never invent limits.
      expect(prompt).toMatch(/single execution path/i);
      expect(prompt).toMatch(/never implement your own stake limits/i);
      expect(prompt).toMatch(/never state or imply a bet was placed/i);
    }
    // The only intended difference is style.
    expect(WEB_PERSONA_PROMPT).toMatch(/markdown/i);
    expect(TELEGRAM_PERSONA_PROMPT).toMatch(/telegram/i);
  });
});
