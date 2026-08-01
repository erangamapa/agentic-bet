#!/usr/bin/env bash
#
# One-time GCP setup for agentic-bet. Idempotent — safe to re-run.
#
#   PROJECT_ID=my-project ./deploy/setup.sh
#
# Creates: API enablement, Artifact Registry repo, the runtime service account
# with least-privilege IAM, Secret Manager entries, and the Cloud Scheduler job
# that drives reconciliation.
#
# It does NOT deploy. Run `gcloud builds submit --config cloudbuild.yaml` after.

set -euo pipefail

PROJECT_ID="${PROJECT_ID:-$(gcloud config get-value project 2>/dev/null)}"
REGION="${REGION:-europe-west1}"
REPOSITORY="${REPOSITORY:-agentic-bet}"
SERVICE="${SERVICE:-agentic-bet}"
JOB="${JOB:-agentic-bet-reconciler}"
RUN_SA="${RUN_SA:-agentic-bet-run}"
SCHEDULER_SA="${SCHEDULER_SA:-agentic-bet-scheduler}"
RECONCILE_SCHEDULE="${RECONCILE_SCHEDULE:-*/5 * * * *}"

if [[ -z "${PROJECT_ID}" ]]; then
  echo "PROJECT_ID is not set and no gcloud default project is configured." >&2
  exit 1
fi

RUN_SA_EMAIL="${RUN_SA}@${PROJECT_ID}.iam.gserviceaccount.com"
SCHEDULER_SA_EMAIL="${SCHEDULER_SA}@${PROJECT_ID}.iam.gserviceaccount.com"

echo "Project:  ${PROJECT_ID}"
echo "Region:   ${REGION}"
echo

# ---------------------------------------------------------------------------
echo "==> Enabling APIs"
gcloud services enable \
  run.googleapis.com \
  cloudbuild.googleapis.com \
  artifactregistry.googleapis.com \
  secretmanager.googleapis.com \
  cloudscheduler.googleapis.com \
  --project="${PROJECT_ID}"

# ---------------------------------------------------------------------------
echo "==> Artifact Registry"
gcloud artifacts repositories describe "${REPOSITORY}" \
  --location="${REGION}" --project="${PROJECT_ID}" >/dev/null 2>&1 || \
gcloud artifacts repositories create "${REPOSITORY}" \
  --repository-format=docker \
  --location="${REGION}" \
  --description="agentic-bet container images" \
  --project="${PROJECT_ID}"

# ---------------------------------------------------------------------------
echo "==> Service accounts"
# Runtime identity for the service and the job. Deliberately separate from the
# default compute account, which is over-privileged.
gcloud iam service-accounts describe "${RUN_SA_EMAIL}" --project="${PROJECT_ID}" >/dev/null 2>&1 || \
gcloud iam service-accounts create "${RUN_SA}" \
  --display-name="agentic-bet Cloud Run runtime" --project="${PROJECT_ID}"

# Scheduler needs only the right to invoke the reconciler job.
gcloud iam service-accounts describe "${SCHEDULER_SA_EMAIL}" --project="${PROJECT_ID}" >/dev/null 2>&1 || \
gcloud iam service-accounts create "${SCHEDULER_SA}" \
  --display-name="agentic-bet Cloud Scheduler invoker" --project="${PROJECT_ID}"

# ---------------------------------------------------------------------------
echo "==> Secrets"
# Values are NOT set here — this only creates the containers, so no secret ever
# passes through a script or a shell history. Add versions with:
#   printf '%s' "$VALUE" | gcloud secrets versions add NAME --data-file=-
SECRETS=(
  agentic-bet-database-url
  agentic-bet-anthropic-key
  agentic-bet-openai-key
  agentic-bet-langsmith-key
  agentic-bet-web-api-key
  agentic-bet-telegram-token
  agentic-bet-telegram-webhook-secret
  agentic-bet-chain-rpc-url
  agentic-bet-operator-private-key
)

for secret in "${SECRETS[@]}"; do
  gcloud secrets describe "${secret}" --project="${PROJECT_ID}" >/dev/null 2>&1 || {
    echo "    creating ${secret}"
    gcloud secrets create "${secret}" --replication-policy=automatic --project="${PROJECT_ID}"
  }
  # Least privilege: read access to this secret only, not project-wide.
  gcloud secrets add-iam-policy-binding "${secret}" \
    --member="serviceAccount:${RUN_SA_EMAIL}" \
    --role=roles/secretmanager.secretAccessor \
    --project="${PROJECT_ID}" --quiet >/dev/null
done

echo
echo "    Secrets created empty. Add values before deploying, e.g.:"
echo "      printf '%s' \"\$DATABASE_URL\" | gcloud secrets versions add agentic-bet-database-url --data-file=-"
echo "      openssl rand -hex 32 | tr -d '\\n' | gcloud secrets versions add agentic-bet-telegram-webhook-secret --data-file=-"
echo

# ---------------------------------------------------------------------------
echo "==> Cloud Build permissions"
BUILD_SA="$(gcloud projects describe "${PROJECT_ID}" --format='value(projectNumber)')@cloudbuild.gserviceaccount.com"
for role in roles/run.admin roles/artifactregistry.writer roles/iam.serviceAccountUser; do
  gcloud projects add-iam-policy-binding "${PROJECT_ID}" \
    --member="serviceAccount:${BUILD_SA}" --role="${role}" --quiet >/dev/null
done

# ---------------------------------------------------------------------------
echo "==> Cloud Scheduler → reconciler job"
gcloud projects add-iam-policy-binding "${PROJECT_ID}" \
  --member="serviceAccount:${SCHEDULER_SA_EMAIL}" \
  --role=roles/run.invoker --quiet >/dev/null

JOB_URI="https://${REGION}-run.googleapis.com/apis/run.googleapis.com/v1/namespaces/${PROJECT_ID}/jobs/${JOB}:run"

if gcloud scheduler jobs describe "${JOB}-trigger" --location="${REGION}" --project="${PROJECT_ID}" >/dev/null 2>&1; then
  ACTION=update
else
  ACTION=create
fi

# Deferred: the job must exist before Scheduler can target it, so this is
# expected to fail on a first run and is re-run after the first deploy.
gcloud scheduler jobs "${ACTION}" http "${JOB}-trigger" \
  --location="${REGION}" \
  --schedule="${RECONCILE_SCHEDULE}" \
  --uri="${JOB_URI}" \
  --http-method=POST \
  --oauth-service-account-email="${SCHEDULER_SA_EMAIL}" \
  --project="${PROJECT_ID}" --quiet 2>/dev/null || {
    echo "    Scheduler job not created yet — the Cloud Run job must exist first."
    echo "    Re-run this script after the first 'gcloud builds submit'."
  }

echo
echo "Done."
echo
echo "Next:"
echo "  1. Add secret values (see the commands above)"
echo "  2. gcloud builds submit --config cloudbuild.yaml --substitutions=_REGION=${REGION}"
echo "  3. ./deploy/setup.sh   # again, to attach the Scheduler trigger"
echo "  4. ./deploy/set-telegram-webhook.sh   # if using Telegram"
