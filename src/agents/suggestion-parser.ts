import { betSuggestionSchema, type BetSuggestionInput } from '../domain/types.js';
import { logger } from '../observability/logger.js';

/**
 * Pulls the SUGGESTION block out of the Analyst's reply.
 *
 * A block-in-text format is used rather than a structured-output constraint on
 * purpose: the Analyst must be free to answer "there is no edge here" in plain
 * prose, which a forced response schema makes awkward. Parsing is strict — a
 * malformed block yields no suggestion rather than a half-populated one, and
 * the values are validated before anything downstream sees them.
 */
export function extractSuggestion(text: string): BetSuggestionInput | null {
  const start = text.lastIndexOf('SUGGESTION');
  if (start === -1) return null;

  const block = text.slice(start + 'SUGGESTION'.length);
  const fields: Record<string, string> = {};

  for (const rawLine of block.split('\n')) {
    const line = rawLine.trim();
    if (!line) {
      // A blank line ends the block only once at least one field was captured,
      // so a leading newline after the marker is tolerated.
      if (Object.keys(fields).length > 0) break;
      continue;
    }
    const colon = line.indexOf(':');
    if (colon === -1) break;
    const key = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (!/^[a-z]+$/.test(key)) break;
    fields[key] = value;
  }

  const candidate = {
    marketId: fields.marketid ?? '',
    selectionId: fields.selectionid ?? '',
    suggestedStake: Number(fields.stake),
    odds: Number(fields.odds),
    confidence: Number(fields.confidence),
    rationale: fields.rationale ?? '',
    source: fields.source ?? 'analyst',
  };

  const parsed = betSuggestionSchema.safeParse(candidate);
  if (!parsed.success) {
    logger.debug(
      { component: 'suggestion-parser', issues: parsed.error.issues.map((i) => i.path.join('.')) },
      'Analyst emitted a SUGGESTION block that failed validation — treating as no suggestion',
    );
    return null;
  }
  return parsed.data;
}

/** Removes the machine-readable block so the user sees only the prose. */
export function stripSuggestionBlock(text: string): string {
  const start = text.lastIndexOf('SUGGESTION');
  if (start === -1) return text.trim();
  return text.slice(0, start).trim();
}
