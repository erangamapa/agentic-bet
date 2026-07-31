# Architecture

## Why it is split this way

A single agent holding every tool would be simpler to write and worse in four specific ways the spec calls out. Each split below exists to fix one of them.

| Requirement | What the architecture does |
|---|---|
| Untrusted input must not reach money | The agent that reads untrusted content is capped below execute clearance, so there is no code path from it to a bet |
| Web and Telegram must not drift | Both personas delegate to one Bet Placement Agent; neither holds betting logic |
| Latency | Each agent carries 2–5 tool schemas instead of ~11; every LLM call pays only for its own |
| Cost | Token usage recorded per role, with schema overhead alongside, so the above is measurable |

## Request flow

```
POST /api/chat  or  Telegram message
        │
        v
   runTurn()                            src/graph/index.ts
        │  builds a TraceContext (traceId, userId, channel, sessionId)
        v
   Front-end persona                    src/agents/personas.ts
   clearance: delegate
   tools: [analyst, bet_placement]      ← both are agentAsTool wrappers
        │
        ├──> analyst              ──>  Analyst Agent        (clearance: read)
        │                              4 read tools
        │                              returns analysis + optional suggestion
        │
        └──> bet_placement        ──>  Bet Placement Agent  (clearance: execute)
                                       quote / check / place / status / list
                                               │
                                               v
                                       betting service       src/services/betting.ts
                                       limits → confirmation gate → execute
                                               │
                                               v
                                       BetExecutor           src/chain/executor.ts
                                       broadcast, then verify
```

The persona is the only agent that sees the conversation. Specialists receive a self-contained instruction, which is why the `agentAsTool` schema tells the caller "it does not see the conversation".

## The privilege model

Three clearance levels, ordered:

| Clearance | Meaning | Held by |
|---|---|---|
| `read` | Reads data, including untrusted third-party content | analyst, and the non-money tools of bet_placement |
| `delegate` | Invokes another agent; moves no money itself | web_persona, telegram_persona |
| `execute` | Moves real money | bet_placement only |

Enforced in two places:

**At construction.** `createScopedAgent` calls `assertToolsAllowedForRole` before building anything. It runs first and unconditionally — before model resolution — so a privilege mistake cannot be masked by a missing API key. An unregistered tool is rejected too, so a tool cannot slip through by being unclassified.

**At tool construction.** Building `place_confirmed_bet` requires an `ExecutionGrant`. The grant's brand is a module-private `Symbol`, so `{ role: 'bet_placement' }` neither type-checks nor passes the runtime check. The only issuer refuses every role except `bet_placement`.

Privilege does not flow through `agentAsTool`. A persona holds a `delegate` tool whose *implementation* closes over the specialist. Holding the wrapper does not confer the specialist's clearance.

`describeToolCatalog()` instantiates every tool set at boot without an LLM and asserts the whole map, so a mis-wiring crashes startup. It is also what `GET /api/architecture` returns, which makes the boundary assertable in CI:

```bash
curl -s localhost:3000/api/architecture \
  | jq '.tools[] | select(.clearance=="execute") | .heldBy'   # ["bet_placement"]
```

## Agents

### Analyst — `read`

Tools: `lookup_markets`, `get_market_odds`, `search_social_content`, `search_sports_knowledge`.

Output is prose plus an optional `SUGGESTION` block. A block-in-text format rather than a forced response schema, because the Analyst must be free to answer "there is no edge here" in plain language — and "suggest nothing" is a correct answer we do not want to make structurally awkward.

Parsing is strict: a malformed block yields no suggestion rather than a half-populated one, and values are validated by zod before anything downstream sees them.

The Analyst does not persist its own suggestions. It returns data; the orchestrator decides whether that becomes a durable, quotable record. Persistence is a privileged act and stays outside the untrusted-input agent.

### Bet Placement — `execute`

| Tool | Clearance | Purpose |
|---|---|---|
| `quote_bet` | read | Validate against live odds + limits, register a pending bet, return a confirmation code |
| `check_confirmation` | read | Report whether the user actually confirmed |
| `place_confirmed_bet` | **execute** | The only tool that moves money |
| `get_bet_status` | read | Look up an execution by id |
| `list_user_bets` | read | Recent bets and pending confirmations |

`place_confirmed_bet` takes only `suggestionIdOrCode`. Stake, odds, market and selection all come from the stored row the user confirmed against. The model has no parameter through which it could change the size or target of a bet — by mistake, by hallucination, or because something upstream told it to.

### Personas — `delegate`

Identical instructions; only tone and formatting differ (markdown vs. short Telegram lines). Both are told never to implement stake limits or confirmation logic, and never to state a bet was placed except by relaying what `bet_placement` returned. `tests/channel-parity.test.ts` asserts the shared instructions are present in both prompts.

## Data model

```
Market ──< Suggestion ──< Confirmation ──< BetExecution
                                              │
                            AuditEvent >──────┘
```

`Suggestion` covers both an Analyst proposal and a user-initiated quote. Reusing one table is deliberate: a confirmation binds to a *stored row*, so both paths get the same immutability guarantee, and `BetExecution.suggestionId` is never null in practice.

`BetExecution.reportedToUserAt` may only be set once `txStatus = 'confirmed'`, enforced by a Postgres `CHECK` as well as by the service.

`AuditEvent` carries a `bigserial seq`. Ordering by `created_at` is not sufficient — several events in one turn land in the same tick, and a dispute is answered by ordering ("was success reported before the transaction confirmed?"). That bug was live until a test caught it.

## Execution modes

| Mode | Broadcast | Verify | Use |
|---|---|---|---|
| `stub` | Deterministic fake hash | Confirms only hashes it actually issued | Local dev, tests |
| `simulate` | Real `eth_call`, never broadcast | **Always fails** — nothing was broadcast | Contract-call validation |
| `onchain` | Signs and broadcasts | Waits for receipt, decodes `BetPlaced`, matches intent hash | Production |

`simulate` failing verification is intentional. Nothing was broadcast, so no bet exists; reporting success would be precisely the bug this system must not have.

## LLM provider failover

`resolveModelChain()` returns `[primary, ...fallbacks]`, dropping providers with no credentials. The head becomes the model; the tail becomes `modelFallbackMiddleware`. If configured ids resolve to nothing usable, it falls back to a sane default per available provider rather than failing the request.

## Persistence

`Store` is an interface with two implementations: `PostgresStore` (Neon serverless HTTP driver — every query is a short independent statement, so there is no session to keep) and `MemoryStore` (used when `DATABASE_URL` is absent, so the system boots with no external services).

The memory store is a dev convenience, not a correctness equal. `npm run verify:db` exercises the paths where the SQL itself is load-bearing — the atomic confirmation claim, the idempotency index, sequence ordering — against real Postgres.

## Trade-offs

**Session memory is in-process and shallow (12 turns).** Everything that matters — suggestions, confirmations, executions — is in Postgres, so a restart can never lose or resurrect a betting decision. It costs conversational continuity across restarts, which is the cheaper thing to lose.

**Suggestion parsing is text-based, not a structured-output constraint.** Costs some parsing robustness; buys the Analyst the ability to decline naturally.

**`agentAsTool` is hand-rolled rather than `Runnable.asTool()`.** Gives explicit control over the clearance registration and audit emission at the delegation boundary, which is exactly where it matters most.

**Every turn constructs fresh agents.** Simple and stateless, at the cost of rebuilding tool closures per turn. If it shows up in latency, cache per `(userId, channel)` — the privilege checks are construction-time and would still run.
