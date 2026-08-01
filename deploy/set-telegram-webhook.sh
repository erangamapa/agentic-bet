#!/usr/bin/env bash
#
# Points Telegram at the deployed Cloud Run service.
#
#   PROJECT_ID=my-project ./deploy/set-telegram-webhook.sh
#
# Reads the bot token and webhook secret from Secret Manager rather than taking
# them as arguments, so neither ends up in shell history or process listings.

set -euo pipefail

PROJECT_ID="${PROJECT_ID:-$(gcloud config get-value project 2>/dev/null)}"
REGION="${REGION:-europe-west1}"
SERVICE="${SERVICE:-agentic-bet}"

SERVICE_URL="$(gcloud run services describe "${SERVICE}" \
  --region="${REGION}" --project="${PROJECT_ID}" --format='value(status.url)')"

if [[ -z "${SERVICE_URL}" ]]; then
  echo "Could not resolve the URL for Cloud Run service '${SERVICE}'." >&2
  exit 1
fi

BOT_TOKEN="$(gcloud secrets versions access latest \
  --secret=agentic-bet-telegram-token --project="${PROJECT_ID}")"
WEBHOOK_SECRET="$(gcloud secrets versions access latest \
  --secret=agentic-bet-telegram-webhook-secret --project="${PROJECT_ID}")"

WEBHOOK_URL="${SERVICE_URL}/telegram/webhook"

echo "Setting webhook to ${WEBHOOK_URL}"

# drop_pending_updates avoids a burst of stale messages being replayed into the
# agent graph on first deploy — those could quote prices that have since moved.
curl -sS -X POST "https://api.telegram.org/bot${BOT_TOKEN}/setWebhook" \
  --data-urlencode "url=${WEBHOOK_URL}" \
  --data-urlencode "secret_token=${WEBHOOK_SECRET}" \
  --data-urlencode "drop_pending_updates=true" \
  --data-urlencode 'allowed_updates=["message","callback_query"]' \
  | python3 -c 'import json,sys; r=json.load(sys.stdin); print(("OK: " if r.get("ok") else "FAILED: ")+str(r.get("description", r)))'

echo
echo "Current webhook status:"
curl -sS "https://api.telegram.org/bot${BOT_TOKEN}/getWebhookInfo" \
  | python3 -c 'import json,sys; i=json.load(sys.stdin)["result"]; [print(f"  {k}: {v}") for k,v in i.items()]'
