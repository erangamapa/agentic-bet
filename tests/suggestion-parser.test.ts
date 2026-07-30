import { describe, expect, it } from 'vitest';
import { extractSuggestion, stripSuggestionBlock } from '../src/agents/suggestion-parser.js';

const validBlock = `Arsenal's keeper situation matters more than the price implies.

SUGGESTION
marketId: mkt_epl_ars_che_1x2
selectionId: away
stake: 25
odds: 4.2
confidence: 0.62
rationale: Backup keeper plus Chelsea's improved away form is not in the price.`;

describe('analyst suggestion parsing', () => {
  it('extracts a well-formed suggestion', () => {
    const suggestion = extractSuggestion(validBlock);
    expect(suggestion).toMatchObject({
      marketId: 'mkt_epl_ars_che_1x2',
      selectionId: 'away',
      suggestedStake: 25,
      odds: 4.2,
      confidence: 0.62,
    });
  });

  it('returns null when the analyst declines to suggest', () => {
    expect(extractSuggestion('No edge here — the price already reflects the team news.')).toBeNull();
  });

  it('rejects a block with a non-numeric stake rather than half-populating it', () => {
    const broken = validBlock.replace('stake: 25', 'stake: whatever');
    expect(extractSuggestion(broken)).toBeNull();
  });

  it('rejects a negative stake', () => {
    expect(extractSuggestion(validBlock.replace('stake: 25', 'stake: -25'))).toBeNull();
  });

  it('rejects a confidence outside 0-1', () => {
    expect(extractSuggestion(validBlock.replace('confidence: 0.62', 'confidence: 7'))).toBeNull();
  });

  it('rejects a block missing the market id', () => {
    expect(extractSuggestion(validBlock.replace('marketId: mkt_epl_ars_che_1x2\n', ''))).toBeNull();
  });

  it('takes the last block when the model emits more than one', () => {
    const doubled = `${validBlock}\n\nSUGGESTION\nmarketId: mkt_nba_bos_den_ml\nselectionId: home\nstake: 10\nodds: 1.72\nconfidence: 0.55\nrationale: Rest advantage.`;
    expect(extractSuggestion(doubled)?.marketId).toBe('mkt_nba_bos_den_ml');
  });

  it('strips the machine block from the user-facing prose', () => {
    const prose = stripSuggestionBlock(validBlock);
    expect(prose).not.toContain('SUGGESTION');
    expect(prose).toContain("Arsenal's keeper situation");
  });

  it('leaves prose untouched when there is no block', () => {
    const text = 'Nothing worth backing here.';
    expect(stripSuggestionBlock(text)).toBe(text);
  });
});
