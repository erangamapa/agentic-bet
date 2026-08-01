#!/usr/bin/env bash
#
# Creates the Cloud Build trigger that redeploys on every push to main.
#
#   PROJECT_ID=my-project ./deploy/create-trigger.sh
#
# Prerequisite (one-time, browser): connect the GitHub repository to Cloud Build
#   https://console.cloud.google.com/cloud-build/triggers/connect
# Installing the Cloud Build GitHub App requires an OAuth grant that cannot be
# scripted. Once connected, this is idempotent and re-runnable.

set -euo pipefail

PROJECT_ID="${PROJECT_ID:-$(gcloud config get-value project 2>/dev/null)}"
REGION="${REGION:-europe-west1}"
REPO_OWNER="${REPO_OWNER:-erangamapa}"
REPO_NAME="${REPO_NAME:-agentic-bet}"
BRANCH="${BRANCH:-^main$}"
TRIGGER_NAME="${TRIGGER_NAME:-agentic-bet-deploy-on-push}"

if [[ -z "${PROJECT_ID}" ]]; then
  echo "PROJECT_ID is not set and no gcloud default project is configured." >&2
  exit 1
fi

echo "Project: ${PROJECT_ID}"
echo "Repo:    ${REPO_OWNER}/${REPO_NAME} (branch ${BRANCH})"
echo

if gcloud builds triggers describe "${TRIGGER_NAME}" \
     --region="${REGION}" --project="${PROJECT_ID}" >/dev/null 2>&1; then
  echo "==> Trigger exists; updating"
  ACTION=update
else
  echo "==> Creating trigger"
  ACTION=create
fi

gcloud builds triggers "${ACTION}" github "${TRIGGER_NAME}" \
  --region="${REGION}" \
  --repo-owner="${REPO_OWNER}" \
  --repo-name="${REPO_NAME}" \
  --branch-pattern="${BRANCH}" \
  --build-config=cloudbuild.yaml \
  --substitutions=_REGION="${REGION}" \
  --description="Build, migrate and deploy agentic-bet to Cloud Run on push to main" \
  --project="${PROJECT_ID}" \
  ${ACTION:+--quiet}

echo
echo "Done. Every push to main now runs cloudbuild.yaml:"
echo "  build image -> push to Artifact Registry -> migrate -> deploy service + reconciler job"
echo
echo "Watch builds:"
echo "  gcloud builds list --region=${REGION} --project=${PROJECT_ID} --limit=5"
