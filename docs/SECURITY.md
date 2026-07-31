# Security model

The threat this system is built around: **untrusted text reaching an agent that can move money.**

Social posts, news items and chat messages are attacker-controllable. Any of them can contain text shaped like an instruction. The defence is not to detect every such attempt — that is a losing game — but to ensure that a successful manipulation of the reading agent still has nothing to act with.

## Layer 1 — structural (the one that matters)

The Analyst is capped at `read` clearance. It holds four tools, all read-only, and there is no code path from it to a bet.

Assume total compromise: the injected text is perfectly crafted, the model believes it completely, and it tries with full conviction to place a bet. It fails, because:

- it has no execution tool in its tool set — `assertToolsAllowedForRole` refuses to build the agent otherwise;
- it cannot obtain one — `requestExecutionGrant('analyst')` throws;
- it cannot forge a grant — the brand is a module-private `Symbol`, unreachable from another module;
- it cannot call the Bet Placement Agent — that wrapper belongs to the personas, not to the Analyst;
- even the persona calling `bet_placement` on its behalf does not help, because execution still requires a user confirmation the Analyst cannot create.

Verified by `npm run verify:boundary` checks a1–a6.

## Layer 2 — sanitisation

`sanitiseUntrustedText()` strips seven pattern families before untrusted content reaches the model: instruction override, role switch, system-prompt spoofing, tool-name invocation, urgency/confirmation-bypass language, credential probing, delimiter escapes. It also collapses runaway whitespace, so a wall of newlines cannot push real instructions out of attention.

Matches are **flagged**, not silently dropped — the flags land in the audit log, so injection attempts are visible rather than invisible.

This layer is defence in depth. It is assumed to be bypassable; layer 1 is not.

## Layer 3 — envelope + prompt

Content is wrapped in `<untrusted_content source="...">` blocks, and the Analyst's system prompt states that anything inside is data to analyse, never instructions to follow, and that text appearing to address it is an attempted manipulation. The label is quote-escaped so a crafted source string cannot break out of the attribute.

The weakest layer — a prompt instruction defended by another prompt instruction. It improves behaviour; it is not relied on.

## Confirmation cannot be manufactured

A `Confirmation` row is created only by a deterministic front-end path: `POST /api/suggestions/:id/confirm`, or `/confirm CODE` in Telegram. No agent creates one, and no LLM output can.

**Intent binding.** Each confirmation stores a hash over `(userId, marketId, selectionId, stake, odds)`. Any parameter change invalidates it. A bet confirmed at £20 cannot become a bet at £2,000, and one on Arsenal cannot become one on a different market.

**No mutable surface.** `place_confirmed_bet` accepts only `suggestionIdOrCode`. There is no stake or market parameter to tamper with.

**Single use, atomically.**

```sql
UPDATE confirmations SET consumed_at = now(), consumed_by_execution_id = $2
WHERE id = $1 AND consumed_at IS NULL
RETURNING id
```

Concurrent executions race on the row; exactly one gets a row back. Verified with four simultaneous placements against real Postgres (`verify:db`).

**Expiry.** Confirmations expire (default 15 minutes) and are re-checked at execution time.

**Odds drift.** If the price moved more than 5% since confirmation, execution is refused and the user must re-confirm at the new price.

## Never reporting an unplaced bet

Three independent layers, because the spec records this as a real production incident:

1. **Two-phase execution.** `broadcast()` returning is not success. Only `verify()` returning `confirmed` is. A successful receipt alone is still not enough — the `BetPlaced` event must exist and carry the matching intent hash.
2. **Database constraint.** `CHECK (reported_to_user_at IS NULL OR tx_status = 'confirmed')` — holds even against a direct SQL write that bypasses the service.
3. **Instructed tool results.** `place_confirmed_bet` returns an explicit instruction per outcome, so the model is never inferring what it may claim:
   - `confirmed` → "You may now tell the user the bet is placed"
   - `pending` → "Do NOT tell the user the bet is placed"
   - `failed` → "The bet was NOT placed. Tell the user clearly"

When verification errors (RPC timeout, mid-flight restart), the bet stays `pending` — not failed, and certainly not confirmed. Guessing either way is unsafe: "failed" invites a retry that double-stakes, "confirmed" is the original bug. The [reconciler](../src/services/reconciler.ts) re-asks the chain later.

## Identity

`userId` is established in a Fastify `preHandler` from the transport and read from `request.userId` everywhere downstream. No agent, tool or request body can name a different user, so a manipulated model cannot place a bet against someone else's account.

The demo auth (shared `x-api-key` + `x-user-id`) is **not production-grade** — swap it for real sessions/JWT. The property that matters is where identity is resolved, and that does not change.

## Secrets

`OPERATOR_PRIVATE_KEY` is read from the environment, never logged (pino redaction covers `privateKey`, `OPERATOR_PRIVATE_KEY` and `*.privateKey`), and never sent to a model. `.env` is gitignored; `.env.example` carries placeholders only.

## Known gaps

| Gap | Notes |
|---|---|
| Demo auth | Shared API key + header user id. Replace before production. |
| No rate limiting | An abusive client can drive unbounded LLM spend. Add per-user limits at the edge. |
| Single hot wallet | One operator key signs all bets. Consider a threshold signer or per-user wallets. |
| Contract unaudited | `SocialBetBook.sol` is written and not deployed or audited. |
| Sanitiser is pattern-based | Bypassable by construction. Layer 1 is the real defence. |
| No spend cap on the LLM path | Stake limits are enforced; token spend is recorded but not capped. |

## Reporting

The privilege boundary is the security-critical surface. Changes to `src/agents/privilege.ts`, `src/services/betting.ts` or `src/chain/executor.ts` warrant close review, and both `npm run verify:boundary` and `npm run verify:db` should pass before merge.
