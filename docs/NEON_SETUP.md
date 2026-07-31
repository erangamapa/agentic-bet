# Neon setup

The project is already provisioned and migrated. This is the reference for recreating it, or pointing at a different database.

## Current instance

| | |
|---|---|
| Organisation | Eranga (`org-broad-haze-55490824`) |
| Project | `agentic-bet` (`sweet-mouse-01709491`) |
| Branch | `main` (`br-hidden-cake-awh56r4q`) |
| Database | `neondb` |
| Region | `us-east-1` |

The connection string lives in the gitignored `.env` as `DATABASE_URL`. It is **not** in version control and must not be — see the secrets rule in `~/.claude/CLAUDE.md`.

## Applying the schema

```bash
npm run db:migrate    # idempotent; safe to re-run
```

`src/db/migrate.ts` applies the current schema with `IF NOT EXISTS`, so a fresh Neon branch is usable in one command. For versioned migration history use `npm run db:generate` (drizzle-kit) — both derive from `src/db/schema.ts`, so they agree.

## Verifying

```bash
npm run verify:db
```

Runs quote → confirm → place → verify against real Postgres, including four concurrent placements racing one confirmation row. Expect `8/8 checks passed`.

## Tables

| Table | Holds |
|---|---|
| `users` | Identity, wallet address, per-user limit overrides |
| `markets` | Fixtures and selections with current odds |
| `content_items` | Untrusted social/news content, retained so traces can be replayed |
| `suggestions` | Analyst proposals and user quotes |
| `confirmations` | Explicit user confirmations, intent-hash bound, single-use |
| `bet_executions` | Money movements, tx status, `reported_to_user_at` |
| `audit_events` | Append-only event chain, ordered by `seq` |
| `token_usage` | Per-agent-role token accounting |

### Constraints that carry safety meaning

```sql
-- A bet cannot be recorded as reported to the user unless it actually confirmed.
CHECK (reported_to_user_at IS NULL OR tx_status = 'confirmed')

-- The same confirmed bet cannot be placed twice.
UNIQUE INDEX bet_executions_idempotency_idx ON bet_executions (idempotency_key)
```

Both are enforced by the database, not only the service layer, so they hold against a direct SQL write. Confirmed against the live instance during the build.

## Creating a fresh project

Via the Neon MCP (configured at `~/.claude.json` → `mcpServers.neon`, OAuth):

1. `create_project` with name `agentic-bet`
2. Copy the pooled URI into `.env` as `DATABASE_URL`
3. `npm run db:migrate`
4. `npm run verify:db`

Or from the console at <https://console.neon.tech> — copy the **pooled** connection string.

## Branching for tests

Neon branches are copy-on-write and cheap, which suits destructive test runs:

```
create_branch(projectId, name: 'test')   # point DATABASE_URL at it
delete_branch(...)                       # when done
```

`verify:db` uses a timestamped user id per run instead, so it is safe against the main branch — daily-cap checks stay independent of prior runs.

## Driver notes

`@neondatabase/serverless` over HTTP, not the WebSocket pool: every query here is a short independent statement issued from a request- or agent-scoped context, so there is no long-lived session to keep. If transactions spanning multiple statements are ever needed, switch to the `Pool` driver and `drizzle-orm/neon-serverless`.
