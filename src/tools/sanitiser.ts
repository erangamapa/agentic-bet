/**
 * Defence-in-depth for untrusted content.
 *
 * The *structural* protection is the privilege boundary: the Analyst has no
 * execution tool, so an injected instruction has nothing to reach for. This
 * module is the second layer — it reduces the chance that injected text even
 * confuses the Analyst's own output, and it flags injection attempts so they
 * show up in the audit log rather than passing silently.
 */

const injectionPatterns: { name: string; pattern: RegExp }[] = [
  { name: 'instruction_override', pattern: /\b(ignore|disregard|forget)\s+(all\s+)?(previous|prior|above|earlier)\s+(instructions?|rules?|prompts?)/gi },
  { name: 'role_switch', pattern: /\b(you\s+are\s+now|from\s+now\s+on\s+you|act\s+as|pretend\s+to\s+be)\b/gi },
  { name: 'system_prompt_spoof', pattern: /<\/?(system|assistant|user|tool)[^>]*>/gi },
  { name: 'tool_invocation', pattern: /\b(place[_\s-]?bet|placeBetOnBehalfOf|execute[_\s-]?bet|transfer[_\s-]?funds|send[_\s-]?(eth|usdc|funds))\b/gi },
  { name: 'urgency_escalation', pattern: /\b(immediately|without\s+asking|do\s+not\s+ask|skip\s+confirmation|no\s+confirmation\s+needed)\b/gi },
  { name: 'credential_probe', pattern: /\b(private\s*key|seed\s*phrase|api[_\s-]?key|mnemonic)\b/gi },
  { name: 'delimiter_escape', pattern: /(```|<\|.*?\|>|\[\/?INST\])/g },
];

export interface SanitisedContent {
  text: string;
  sanitised: boolean;
  flags: string[];
}

const REDACTION = '[redacted-instruction]';

export function sanitiseUntrustedText(input: string): SanitisedContent {
  let text = input;
  const flags: string[] = [];

  for (const { name, pattern } of injectionPatterns) {
    pattern.lastIndex = 0;
    if (pattern.test(text)) {
      flags.push(name);
      pattern.lastIndex = 0;
      text = text.replace(pattern, REDACTION);
    }
  }

  // Collapse runaway whitespace so a wall of newlines cannot push the real
  // instructions out of the model's attention.
  text = text.replace(/\n{3,}/g, '\n\n').trim();

  return { text, sanitised: flags.length > 0, flags: [...new Set(flags)] };
}

/**
 * Wraps untrusted content in an explicit, non-forgeable envelope. The Analyst's
 * system prompt tells it that anything inside this envelope is data to analyse,
 * never instructions to follow.
 */
export function wrapUntrusted(label: string, body: string): string {
  return [
    `<untrusted_content source="${label.replace(/"/g, "'")}">`,
    body,
    '</untrusted_content>',
  ].join('\n');
}
