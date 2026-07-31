# agentic-bet

A multi-agent social betting system: it reads match data, odds and social chatter, talks to users on web and Telegram, and places bets on their behalf — with a hard structural boundary between the agent that reads untrusted content and the agent that moves money.

Built to [`social_betting_agentic_system_spec.md`](./social_betting_agentic_system_spec.md).

---

## The one thing to understand

The Analyst Agent reads untrusted third-party content — social posts, news, chat messages. Untrusted content is where prompt injection comes from. So the Analyst **cannot hold the bet-execution tool**. Not "is told not to use it" — *cannot hold it*:

```ts
// src/agents/privilege.ts
export const roleClearance: Record<AgentRole, Clearance> = {
  analyst:           'read',      // reads untrusted content, tops out here
  bet_placement:     'execute',   // the only role that may move money
  web_persona:       'delegate',
  telegram_persona:  'delegate',
};
```

`createScopedAgent` checks every tool against this table *before the agent exists*. Wiring an execute-clearance tool to the Analyst throws at construction — a startup crash, not a runtime incident with a user's money in flight. On top of that, building the execution tool requires a capability grant branded with a module-private `Symbol`, so a grant cannot be forged from outside the module; `requestExecutionGrant('analyst')` throws.

An injected instruction in a social post has nothing to reach for. There is no code path from the Analyst to the money.

---

## Quick start

```bash
npm install
cp .env.example .env      # add ANTHROPIC_API_KEY (or OPENAI_API_KEY)
npm run dev               # http://localhost:3000
```

Runs with no external services: without `DATABASE_URL` it uses an in-memory store, and `EXECUTION_MODE=stub` logs bets instead of broadcasting them. Add a Neon URL and an LLM key when you want the real paths.

### Verify it does what it claims

```bash
npm test                  # 80 tests
npm run verify:boundary   # 14 checks, no API key or database needed
npm run verify:db         # 8 checks against real Postgres (needs DATABASE_URL)
```

`verify:boundary` proves the three properties the spec's milestone 7 asks for: the Analyst genuinely cannot trigger execution, web and Telegram behave identically, and no success is ever reported without a confirmed transaction.

### Other entry points

```bash
npm run chat                        # terminal chat, web persona
npm run chat -- --channel telegram  # same graph, Telegram persona
npm run telegram                    # the actual bot (needs TELEGRAM_BOT_TOKEN)
npm run db:migrate                  # apply schema to Neon
```

---

## Architecture

```
                    ┌──────────────────────────────┐
                    │     Front-end personas       │
                    │  web_persona │ telegram_persona│
                    │      clearance: delegate      │
                    └───────┬──────────────┬────────┘
                agentAsTool │              │ agentAsTool
                            v              v
   untrusted        ┌───────────────┐   ┌──────────────────────┐
   content   ──────>│ Analyst Agent │   │ Bet Placement Agent  │
   (news,           │ clearance:read│   │ clearance: execute   │
    social,         │               │   │                      │
    chat)           │ 4 read tools  │   │ ONLY holder of       │
                    │ NO exec tool  │   │ place_confirmed_bet  │
                    └───────┬───────┘   └──────────┬───────────┘
                            │                      │
                     structured                    v
                     suggestion          ┌──────────────────────┐
                     (data, not          │ betting service      │
                      an action)         │ limits, confirmation │
                                         │ gate, intent hash    │
                                         └──────────┬───────────┘
                                                    v
                                         ┌──────────────────────┐
                                         │ broadcast → VERIFY   │
                                         │ (two phases, always) │
                                         └──────────────────────┘
```

Both personas call the **same** Bet Placement Agent instance. Neither contains stake limits or confirmation logic, so web and Telegram cannot drift apart — the parity is structural, not a thing tests have to keep catching.

Full detail: [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) · [`docs/SECURITY.md`](./docs/SECURITY.md) · [`docs/DECISIONS.md`](./docs/DECISIONS.md)

---

## The production incident this is built around

The spec calls out a real prior failure: an agent reported a bet as placed when it had not been. The fix here is structural, in three layers.

**1. Execution is two phases, and only the second one means success.**

```ts
interface BetExecutor {
  broadcast(request): Promise<BroadcastResult>;      // returning is NOT success
  verify(request, txHash): Promise<VerificationResult>; // only this confirms
}
```

A successful receipt is still not enough — the `BetPlaced` event must exist *and* carry the intent hash the user confirmed. A transaction that succeeded but emitted nothing matching is a failure.

**2. `reportedToUserAt` is only ever set after `txStatus === 'confirmed'`,** and Postgres enforces that independently of the service layer:

```sql
CHECK (reported_to_user_at IS NULL OR tx_status = 'confirmed')
```

**3. The model is told, in the tool result itself, what it is allowed to say.** `place_confirmed_bet` returns an explicit instruction per outcome — confirmed, pending or failed — so "the bet is placed" is never the model's inference.

When verification errors out (RPC timeout, restart mid-flight), the bet stays `pending` rather than being guessed either way, and [the reconciler](./src/services/reconciler.ts) re-asks the chain later. Until then the user is told it is still confirming.

---

## Confirmation cannot be faked by a model

A bet needs a `Confirmation` row created by a deterministic front-end path — the UI's Confirm button, or `/confirm CODE` in Telegram. No agent creates one.

Each confirmation binds to an **intent hash** over `(userId, marketId, selectionId, stake, odds)`. Change any parameter after confirmation and the hash no longer matches, so the execution is refused. And `place_confirmed_bet` accepts only a *reference* to the confirmed bet:

```ts
schema: z.object({ suggestionIdOrCode: z.string() })
```

There is no stake or market parameter for a manipulated model to alter. Claiming it is confirmed does not make it so — the check is a SQL lookup, and the claim is atomic:

```sql
UPDATE confirmations SET consumed_at = now()
WHERE id = $1 AND consumed_at IS NULL
```

Four concurrent placements race; exactly one wins. Verified against real Postgres in `verify:db`.

---

## Observability

Every hop is traceable, which matters for debugging *and* for telling a genuine failure apart from a user falsely claiming they never confirmed.

- **LangSmith** across every agent hop, with `userId` and `executionId` in run metadata, so traces are queryable by both.
- **Append-only audit log** — the authoritative business record: who confirmed what, on which channel, what was broadcast, when success was reported. Ordered by a `bigserial` sequence, not a timestamp, because several events land in the same millisecond and *ordering* is what answers the dispute.
- **Token cost per agent role**, with the tool-schema overhead each agent carries recorded alongside it. This is what makes the "don't build one monolithic agent" argument measurable rather than theoretical.

```bash
GET /api/audit?executionId=exe_…   # the full ordered event chain
GET /api/usage                     # token cost broken down by role
GET /api/architecture              # the live privilege map
```

---

## Configuration

| Variable | Default | Notes |
|---|---|---|
| `DATABASE_URL` | — | Neon pooled connection string. Falls back to in-memory with a loud warning. |
| `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` | — | At least one. Failover runs primary → fallback across providers. |
| `PRIMARY_MODEL` / `FALLBACK_MODEL` | `anthropic:claude-sonnet-5` | `provider:model`. Uncredentialed providers are dropped from the chain. |
| `EXECUTION_MODE` | `stub` | `stub` \| `simulate` \| `onchain`. |
| `MAX_STAKE_PER_BET` | `250` | Enforced in code, never by the prompt. Per-user overrides in the `users` table. |
| `MAX_STAKE_PER_DAY` | `1000` | Aggregate across pending and confirmed bets. |
| `CONFIRMATION_TTL_SECONDS` | `900` | After this a confirmation must be re-issued. |

Full list in [`.env.example`](./.env.example).

---

## Project layout

```
src/
  agents/       privilege boundary, agent factory, analyst, bet placement, personas
  services/     betting (the privileged core), reconciler
  chain/        executors: stub, simulate, on-chain; two-phase broadcast/verify
  tools/        analyst read tools, untrusted-content sanitiser
  db/           Drizzle schema, migrations, seed
  repositories/ Store interface + Neon and in-memory implementations
  observability/ tracing, audit log, per-role token accounting
  server/       Fastify API + web client
  telegram/     Telegram bot
  cli/          terminal chat, boundary verifier, database verifier
contracts/      SocialBetBook.sol
tests/          80 tests incl. a scripted-model harness (no API key needed)
```

---

## Status

| Milestone (spec §8) | State |
|---|---|
| 1. Graph with two agents + stub execution | Done |
| 2. Analyst read tools + suggestion format | Done |
| 3. Bet Placement with confirmation gating | Done |
| 4. On-chain execution + tx verification | Code complete; `onchain` mode needs a deployed contract |
| 5. LangSmith tracing | Done; needs `LANGSMITH_API_KEY` to emit |
| 6. Web + Telegram personas on one graph | Done |
| 7. Verify the three safety properties | Done — `npm run verify:boundary` |

**Not yet done:** the `SocialBetBook` contract is written but not deployed, so `EXECUTION_MODE=onchain` is unexercised end-to-end (`stub` and the verification logic are fully tested). Load testing has not been run. Live LLM calls are unverified — the provided Anthropic key authenticates but the account has no credits, which is why the graph is tested through a scripted-model harness instead.
