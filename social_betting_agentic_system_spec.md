# Social Betting Agentic System — Build Spec

> **Note on assumptions:** this spec defaults to **TypeScript + LangChain.js/LangGraph.js**, matching the candidate's primary stack (Node/NestJS/TypeScript). If the actual implementation should be Python, swap the tech stack section accordingly — the architecture itself is language-agnostic. Adjust any placeholder values (chain names, provider names) to match real requirements before building.

## 1. Overview

Build a multi-agent system that helps users engage with sports betting socially — reading match/odds context and social signal, generating conversational engagement (posts, chat responses), and placing on-chain bets on the user's behalf across web and Telegram front-ends.

The system must NOT be architected as a single monolithic agent with unrestricted tool access. It must be split into narrowly-scoped, specialized agents with a hard privilege boundary between **content analysis** (reads untrusted external input) and **money movement** (executes real, on-chain financial transactions).

## 2. Non-functional requirements

- **Security boundary:** the agent that reads untrusted content (news, social posts, chat messages) must never directly hold or call the bet-placement tool. A prompt-injected or hallucinated instruction from untrusted content must be structurally incapable of triggering a real trade.
- **Consistency across clients:** web and Telegram front-ends must not duplicate betting logic (stake limits, confirmation flow) independently — both must route through the same privileged execution path to avoid behavioral drift.
- **Latency:** avoid monolithic agents carrying large, all-purpose tool sets — every LLM call pays token overhead for every tool schema it carries, regardless of whether that tool is used. Keep each agent's tool set minimal and role-scoped.
- **Cost:** tool-schema overhead should scale with what each agent actually needs, not with the total capability of the system. Track token usage per agent role.
- **Correctness — intent/outcome verification:** an agent must never report a bet as successfully placed unless the underlying transaction has actually been confirmed on-chain (or by the relevant execution backend). Do not conflate "tool was called" with "tool call succeeded." This was a real production incident in a prior iteration of this system — treat it as a hard requirement, not an edge case.
- **Observability:** every agent decision, tool call, and outcome must be traceable end-to-end (see Section 6). This is required both for debugging and for distinguishing genuine system failures from user-side disputes/fraud (e.g., a user falsely claiming a bet was placed without confirmation).

## 3. Agent architecture

```
                         ┌────────────────────────────┐
                         │      Front-end Personas     │
                         │  (Web Agent, Telegram Agent)│
                         └──────────────┬─────────────┘
                                        │  agentAsTool()
                                        v
   ┌───────────────┐          ┌─────────────────────┐
   │  Untrusted     │  reads   │   Analyst Agent      │
   │  Content Feed  │────────> │  - match/odds data    │
   │  (news, social,│          │  - social posts       │
   │   chat msgs)   │          │  - RAG / market search │
   └───────────────┘          │  NO bet-placement tool │
                               └──────────┬────────────┘
                                          │ produces suggestion
                                          │ (structured, not executed)
                                          v
                               ┌─────────────────────┐
                               │  Bet Placement Agent │
                               │  - ONLY agent holding │
                               │    the bet-execution  │
                               │    tool                │
                               │  - enforces stake      │
                               │    limits, confirmation│
                               │  - verifies on-chain    │
                               │    tx before reporting │
                               │    success              │
                               └──────────┬────────────┘
                                          │
                                          v
                               ┌─────────────────────┐
                               │  On-chain execution   │
                               │  layer (wallet, RPC,  │
                               │  smart contract calls) │
                               └─────────────────────┘
```

**Key architectural rule:** the Analyst Agent can produce a *suggestion* (structured data describing a proposed bet). It cannot execute anything. Only the Bet Placement Agent — invoked via LangGraph's `agentAsTool` pattern from either front-end persona — actually holds the tool that moves money. Both Web and Telegram personas call the **same** Bet Placement Agent instance/tool, not separate reimplementations, so stake limits and confirmation logic can never drift between clients.

## 4. Agent & tool definitions

### 4.1 Analyst Agent
- **Purpose:** read and interpret untrusted external content (odds feeds, social/news content, user chat messages); produce structured market analysis and bet suggestions.
- **Tools available:** odds/market lookup, RAG search over sports data, social content retrieval.
- **Tools explicitly NOT available:** any bet-execution or wallet tool.
- **Output:** a structured suggestion object (see Section 5), not a direct action.

### 4.2 Bet Placement Agent
- **Purpose:** the sole execution point for placing a real bet.
- **Tools available:** `placeBetOnBehalfOf(userId, marketId, stake, odds)` — the only agent in the system with access to this tool.
- **Responsibilities:**
  - Enforce stake limits and any per-user risk rules.
  - Require explicit user confirmation before executing (do not auto-execute an Analyst suggestion).
  - After calling the execution tool, **verify the actual on-chain/backend transaction outcome** before reporting success back to the user. Do not report success based solely on the tool call being issued.
- **Called via:** `agentAsTool`, from Web Agent or Telegram Agent — never called directly by the Analyst Agent.

### 4.3 Web Agent / Telegram Agent (front-end personas)
- **Purpose:** platform-specific conversational interface.
- **Tools available:** Analyst Agent (as tool), Bet Placement Agent (as tool).
- **Must not:** implement their own stake-limit or confirmation logic — always delegate to the Bet Placement Agent for anything execution-related.

## 5. Data model (draft — refine during build)

```
Suggestion {
  id: string
  userId: string
  marketId: string
  suggestedStake: number
  odds: number
  rationale: string        // Analyst's reasoning, shown to user
  source: string            // which content triggered this (email/chat/etc.)
  status: "suggested" | "confirmed" | "dismissed" | "expired"
  createdAt: timestamp
}

BetExecution {
  id: string
  suggestionId: string | null   // null if user-initiated directly, not from a suggestion
  userId: string
  marketId: string
  stake: number
  odds: number
  txStatus: "pending" | "confirmed" | "failed"
  txHash: string | null          // on-chain transaction reference, once confirmed
  reportedToUserAt: timestamp | null   // must only be set AFTER txStatus = confirmed
}
```

## 6. Observability

- Integrate **LangSmith** (or equivalent LangChain-compatible tracing) across every agent hop — Analyst reasoning, tool calls, Bet Placement Agent decisions, and final execution outcome.
- Every trace must be queryable by `userId` and `BetExecution.id`, so a user dispute ("I never confirmed this bet") can be checked against the actual execution trace rather than taken at face value.
- Log token usage per agent role, to track the cost-control goal in Section 2.

## 7. Suggested tech stack

- **Orchestration:** LangGraph.js (multi-agent graph, `agentAsTool` pattern)
- **LLM provider:** configurable, with fallback support across at least two providers (do not hardcode a single provider — production reliability requires failover)
- **Language/runtime:** TypeScript / Node.js
- **Tracing:** LangSmith
- **On-chain execution:** wallet/RPC integration layer, EVM-compatible chain (confirm target chain before implementation)
- **Persistence:** Postgres (or existing project DB) for `Suggestion` and `BetExecution` tables
- **Front-end integration:** Web client and Telegram bot, both calling into the same backend agent graph — no client-side betting logic

## 8. Build order (suggested milestones)

1. Scaffold the LangGraph agent graph with two agents (Analyst, Bet Placement) and a stub execution tool that logs instead of executing.
2. Implement the Analyst Agent's read/analysis tools and suggestion output format.
3. Implement the Bet Placement Agent with confirmation-gating and the stub execution tool.
4. Wire in real on-chain execution, with the mandatory tx-verification-before-success-report step.
5. Add LangSmith tracing across the full graph.
6. Build Web Agent and Telegram Agent personas, both calling the same underlying agent graph via `agentAsTool`.
7. Load-test and verify: (a) Analyst Agent genuinely cannot trigger execution under any input, (b) Web and Telegram produce identical betting behavior for equivalent inputs, (c) no "success" is ever reported without a confirmed transaction.

## 9. Open questions to confirm before/during build

- Target blockchain/network for execution.
- Exact stake-limit and risk rules to enforce in the Bet Placement Agent.
- LLM provider(s) and fallback order.
- Whether Suggestion confirmation happens via a UI form, a chat reply, or both.
