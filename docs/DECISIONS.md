# Decisions

The spec left four questions open (§9) and several implicit ones. These are the calls made during the build, with reasoning — all are reversible, and the ones worth revisiting are marked.

---

## Answers to the spec's open questions

### Target chain — **Base Sepolia (`chainId` 84532), configurable**

EVM as the spec suggests. Base for cheap, fast settlement with a credible mainnet path; Sepolia because nothing here should touch real money until the contract is audited. Chain id, RPC and contract address are all environment-driven — moving chains is config, not code.

**Revisit if** settlement needs a specific token or an existing book contract lives elsewhere.

### Stake and risk rules — **layered defaults with per-user overrides**

| Rule | Default | Why |
|---|---|---|
| Min stake | 1 | Below this, gas dominates |
| Max per bet | 250 | Bounds single-mistake blast radius |
| Max per day | 1000 | Aggregate across pending and confirmed |
| Max open bets | 10 | Caps unresolved on-chain exposure |
| Max odds | 25 | Extreme prices usually mean stale or mispriced markets |
| Confirmation TTL | 15 min | Long enough to be usable, short enough that prices hold |

Placeholder numbers — a real product sets these with the risk team. What matters is *where* they live: in code, checked by `assertWithinLimits`, never in a prompt. The model may explain a limit; it never decides one. Per-user overrides live in `users.limits_override`.

### LLM providers — **Anthropic primary, OpenAI fallback, both optional**

The spec requires no hardcoded provider. `resolveModelChain()` builds `[primary, ...fallbacks]`, silently dropping providers with no credentials, and the tail becomes `modelFallbackMiddleware`. Anthropic leads because the agents lean on instruction-following under adversarial input.

The personas get their own `PERSONA_MODEL` knob — they only route and format, so a cheaper model fits, while the Bet Placement Agent should stay on the strongest available.

### Confirmation channel — **both UI and chat**

The spec asks: form, chat reply, or both. Both, because they are the same operation:

- Web: `POST /api/suggestions/:id/confirm` (the Confirm button)
- Telegram: `/confirm CODE`
- Chat: the user says confirm, the agent surfaces the code, the user replies with it

All three call one `confirmSuggestion()` service and produce identical rows. Adding a channel cannot loosen the requirement.

Confirmation codes are the last 6 characters of the suggestion id, uppercased — short enough to type on a phone, and scoped to one user's recent suggestions when resolved.

---

## Other decisions worth recording

### Suggestion persistence belongs to the orchestrator, not the Analyst

The Analyst returns structured data. Turning that into a durable, quotable record is privileged, so it happens in `personas.ts` after the Analyst returns — keeping write access out of the agent that reads untrusted input, even for a low-risk write.

### Suggestions and quotes share one table

An Analyst proposal and a user-initiated quote both become a `Suggestion`. Confirmation therefore always binds to a stored row, and both paths inherit the same immutability guarantee. The alternative — a separate `quotes` table — would have meant two confirmation paths and two chances to get it wrong.

### Analyst output is parsed text, not a forced schema

A structured-output constraint would make "there is no edge here" awkward to express, and that is a correct and common answer. Parsing is strict and validated, so a malformed block yields no suggestion rather than a partial one.

### `agentAsTool` is hand-rolled

`Runnable.asTool()` exists, but wrapping it manually gives explicit control over clearance registration and audit emission at the delegation boundary — the point where privilege must visibly *not* propagate.

### Idempotency key is `intentHash:confirmationId`

Not a random id. A retried placement of the same confirmed bet collides on the unique index and returns the original execution instead of double-staking. It is the same-bet-twice case that matters, and this makes it structurally impossible.

### Audit ordering uses a sequence, not a timestamp

Several events in one turn land in the same millisecond, and a dispute is answered by ordering. `bigserial` gives a total order independent of clock resolution. This was a live bug — the memory store sorted by `createdAt` and scrambled ties — caught by an ordering assertion in `tests/observability.test.ts`.

### In-memory store fallback

Without `DATABASE_URL` the system boots on an in-memory store, so `git clone && npm install && npm run dev` works with no external services. It warns loudly, and it is not treated as a correctness equal — `verify:db` exercises the SQL-critical paths against real Postgres.

### Model injection seam in the agent factory

`setModelFactoryOverride()` lets tests supply a scripted model per role. It exists so the graph — delegation, tool calls, privilege checks — is testable deterministically and without an API key. The clearance assertion runs *first and unconditionally*, so the seam cannot mask a privilege bug.

This became load-bearing: the provided Anthropic key authenticates but the account has no credits, so live calls are impossible. The graph is nonetheless tested end to end.

### Fresh agents per turn

Simple and stateless; costs rebuilding tool closures each turn. If latency demands it, cache per `(userId, channel)` — privilege checks are construction-time and would still run.

---

## Deliberately not built

| Not built | Why |
|---|---|
| Bet settlement / payouts | The spec covers placement. `settle()` exists on the contract; no service consumes it. |
| Real odds feed | `Store.listMarkets()` is the seam. Tools read through it, so a feed adapter changes nothing above. |
| Vector RAG | The knowledge base is small and hand-written; keyword scoring is honest at this size. Swap in embeddings when the corpus justifies it. |
| Contract deployment | Written, unaudited, undeployed. `EXECUTION_MODE=onchain` is unexercised end-to-end. |
| Load testing | Spec §7 asks for it; not run. Concurrency correctness *is* covered (4-way confirmation race against real Postgres). |
| Auth | Demo-grade on purpose, with the identity resolution point structured so replacing it touches one file. |
