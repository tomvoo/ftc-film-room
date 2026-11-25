#!/usr/bin/env bash
# Push the code in this folder to the existing Film Room server. Used by GitHub Actions after the tests pass.
# Needs gcloud signed in as an account that may update the VM (the film-room-deployer set up by gcp-deploy.sh).
# The VM's updater service notices the new app-version within seconds and reinstalls; data is untouched.
set -euo pipefail
cd "$(dirname "$0")/.."
# shellcheck disable=SC1091
source deploy/gcp.env
: "${GCP_PROJECT:?GCP_PROJECT is empty in deploy/gcp.env}"
VERSION="${VERSION:-${GITHUB_SHA:-manual-$(date -u +%Y%m%d-%H%M%S)}}"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
echo "$VERSION" > VERSION
tar --exclude=./data --exclude=./.git -czf "$TMP/app.tgz" .
base64 -w0 "$TMP/app.tgz" > "$TMP/app.b64"
if (( $(stat -c %s "$TMP/app.b64") > 250000 )); then echo "App bundle is too large for VM metadata (max 256 KB)."; exit 1; fi

echo "Sending version $VERSION to $VM"
# One metadata update carries the code and the new app-version together; the VM's updater wakes on app-version.
gcloud compute instances add-metadata "$VM" --zone "$ZONE" --project "$GCP_PROJECT" --metadata "app-version=$VERSION" \
  --metadata-from-file "startup-script=deploy/vm-startup.sh,app-bundle=$TMP/app.b64"

if [[ -n "${SITE_HOST:-}" ]]; then
  echo "Waiting for https://$SITE_HOST to report version $VERSION"
  for _ in $(seq 1 40); do
    got="$(curl -fs --max-time 8 "https://$SITE_HOST/api/health" | sed -n 's/.*"version":"\([^"]*\)".*/\1/p' || true)"
    if [[ "$got" == "$VERSION" ]]; then echo "Live: https://$SITE_HOST is running $VERSION"; exit 0; fi
    sleep 6
  done
  echo "The server didn't report the new version within 4 minutes."
  echo "Check: gcloud compute instances get-serial-port-output $VM --zone $ZONE --project $GCP_PROJECT | grep film-room | tail -20"
  exit 1
fi
