# Deployment — Google Cloud Run

One container image serves three roles, differing only by the command they run:

| Role | Command | Trigger |
|---|---|---|
| API + web client + Telegram webhook | `node dist/server/index.js` | HTTP |
| Reconciler | `node dist/cli/reconcile.js` | Cloud Scheduler, every 5 min |
| Migrations | `node dist/db/migrate.js` | Cloud Build, per deploy |

Sharing one image matters: the reconciler can never be running a different build of the betting logic than the API.

## Why Cloud Run, and what it forced

Cloud Run throttles CPU to near-zero between requests. Two things in this codebase relied on continuous CPU and would have failed **silently**:

**The reconciler.** `startReconciler()` uses `setInterval`. On Cloud Run it would not reliably fire, so bets stranded in `pending` — broadcast but unverified — would never resolve. That is a user's money in limbo, and nothing would have alerted anyone. It now runs as a Cloud Run Job on a Scheduler trigger; `RECONCILER_MODE=external` disables the in-process timer.

**Telegram.** `bot.start()` long-polls forever, needing a permanently running process. It is now a webhook mounted on the API service (`POST /telegram/webhook`), so it scales to zero with everything else and delivers updates faster than polling.

Both are better designs independent of the platform — a Scheduler-driven job is observable and retryable in a way a background timer is not.

## Prerequisites

- A GCP project with an **active billing account** — Cloud Run, Artifact Registry and Cloud Build all require it
- `gcloud` authenticated: `gcloud auth login` and `gcloud auth application-default login`
- A Neon database (see [NEON_SETUP.md](./NEON_SETUP.md))

## First deploy

```bash
export PROJECT_ID=your-project
export REGION=europe-west1

# 1. APIs, Artifact Registry, service accounts, IAM, empty secrets
./deploy/setup.sh

# 2. Populate secrets (values never pass through a script)
printf '%s' "$DATABASE_URL"      | gcloud secrets versions add agentic-bet-database-url  --data-file=-
printf '%s' "$ANTHROPIC_API_KEY" | gcloud secrets versions add agentic-bet-anthropic-key --data-file=-
openssl rand -hex 32 | tr -d '\n' | gcloud secrets versions add agentic-bet-web-api-key  --data-file=-

# 3. Build, migrate, deploy
gcloud builds submit --config cloudbuild.yaml --substitutions=_REGION=$REGION

# 4. Attach the Scheduler trigger (the job must exist first)
./deploy/setup.sh
```

## Auto-deploy on push

One-time, in the browser — installing the Cloud Build GitHub App needs an OAuth grant that cannot be scripted:

<https://console.cloud.google.com/cloud-build/triggers/connect>

Then:

```bash
./deploy/create-trigger.sh
```

Every push to `main` now runs `cloudbuild.yaml`: build → push to Artifact Registry → migrate → deploy service and reconciler job. Images are tagged with the commit SHA, so rollback is redeploying an earlier tag.

## Telegram

```bash
printf '%s' "$BOT_TOKEN" | gcloud secrets versions add agentic-bet-telegram-token --data-file=-
openssl rand -hex 32 | tr -d '\n' | gcloud secrets versions add agentic-bet-telegram-webhook-secret --data-file=-
gcloud builds submit --config cloudbuild.yaml   # redeploy to pick up the secrets
./deploy/set-telegram-webhook.sh
```

The webhook secret is **required** when a bot token is set — the app refuses to start otherwise. Without it, anyone who learns the URL can post forged updates as any user, and this bot places bets.

## Runtime configuration

| Setting | Value | Why |
|---|---|---|
| `memory` | 1Gi | LangChain/LangGraph imports are heavy |
| `cpu` | 1 | Workload is IO-bound on LLM calls |
| `timeout` | 300s | An agent turn chains several LLM calls |
| `concurrency` | 40 | Async IO-bound; higher risks memory pressure |
| `min-instances` | 0 | Scale to zero. Costs a ~3-5s cold start |
| `max-instances` | 10 | Bounds runaway LLM spend |

Production env: `RECONCILER_MODE=external`, `SEED_DEMO_DATA=false`, `RUN_MIGRATIONS_ON_BOOT=false`.

**Cold starts.** LangChain imports make the first request after idle take ~3-5s. If that matters, set `--min-instances=1` — it costs one always-on instance but removes the delay.

## Secrets

All sensitive config lives in Secret Manager and is mounted as env vars by Cloud Run. Because config is already env-driven and zod-validated, this needs **no code change**.

The runtime service account (`agentic-bet-run`) gets `secretAccessor` on individual secrets, not project-wide. `OPERATOR_PRIVATE_KEY` — the hot wallet — is only attached to services that need it; the API service does not in `stub` mode.

Never put values in `cloudbuild.yaml` or any tracked file.

## Known gaps at production scale

**Session memory is in-process.** With more than one instance, a user's turns hit different instances and lose conversational continuity. Bets are unaffected — all betting state is in Postgres by design — but chat context can jump. Fix by persisting sessions or pinning `--max-instances=1`.

**Demo auth.** Shared `x-api-key` plus `x-user-id` header. Replace with real sessions before this faces the public internet. `src/server/auth.ts` is the only file that changes.

**No rate limiting.** An abusive client can drive unbounded LLM spend. `max-instances` caps concurrency but not cost per request.

## Operations

```bash
# logs
gcloud run services logs read agentic-bet --region=$REGION --limit=50

# reconciler history
gcloud run jobs executions list --job=agentic-bet-reconciler --region=$REGION

# run reconciliation now
gcloud run jobs execute agentic-bet-reconciler --region=$REGION --wait

# rollback to a previous image
gcloud run deploy agentic-bet --region=$REGION \
  --image=$REGION-docker.pkg.dev/$PROJECT_ID/agentic-bet/agentic-bet:<SHA>
```

Health check at `GET /health` reports store type, model chain, execution mode and tracing status.

## Verifying a deploy

```bash
URL=$(gcloud run services describe agentic-bet --region=$REGION --format='value(status.url)')

curl -s $URL/health
curl -s $URL/api/architecture | jq '.tools[] | select(.clearance=="execute") | .heldBy'
# -> ["bet_placement"]   the privilege boundary, assertable in CI
```
