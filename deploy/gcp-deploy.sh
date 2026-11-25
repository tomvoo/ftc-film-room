#!/usr/bin/env bash
# Set up (or update) FTC Film Room on Google Cloud. Run it in Google Cloud Shell from the ftc-film-room folder:
#     bash deploy/gcp-deploy.sh
# The first run creates everything; running it again pushes the code in this folder and keeps all data.
#
# What it creates (Compute Engine free tier; the monthly Google AI Pro credit covers anything beyond it):
#   - one e2-micro VM, Debian 12, 30 GB standard disk, in us-central1 (Iowa)
#   - a fixed external IP, so the web address never changes
#   - a firewall rule opening ports 80 and 443 to that VM only
#   - a Cloud Storage bucket that receives a copy of every backup
#   - HTTPS from Let's Encrypt via Caddy, at https://<ip-with-dashes>.sslip.io (or your own domain: SITE_HOST=...)
#   - a "film-room-deployer" account that only GitHub Actions on the main branch of GITHUB_REPO can use,
#     allowed to update this one VM, so pushes to GitHub deploy automatically
set -euo pipefail
cd "$(dirname "$0")/.."
# shellcheck disable=SC1091
source deploy/gcp.env

PROJECT="${PROJECT:-$(gcloud config get-value project 2>/dev/null || true)}"
REGION="${REGION:-us-central1}"
ZONE="${ZONE:-${REGION}-a}"
VM="${VM:-film-room}"
GITHUB_REPO="${GITHUB_REPO:-}"

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }

if [[ -z "$PROJECT" ]]; then
  echo "No project selected. In the Cloud Shell prompt run:  gcloud config set project YOUR_PROJECT_ID"
  exit 1
fi
BUCKET="${BUCKET:-${PROJECT}-film-room-backups}"
if [[ "$(gcloud billing projects describe "$PROJECT" --format='value(billingEnabled)' 2>/dev/null || echo unknown)" == "False" ]]; then
  echo "Billing isn't turned on for project $PROJECT. Link it to the billing account that has your AI Pro credit:"
  echo "  https://console.cloud.google.com/billing/linkedaccount?project=$PROJECT"
  exit 1
fi
PROJECT_NUMBER="$(gcloud projects describe "$PROJECT" --format='value(projectNumber)')"
VM_SA="${PROJECT_NUMBER}-compute@developer.gserviceaccount.com"

say "1/7 Turning on the Google Cloud services this needs (first time takes a minute or two)"
gcloud services enable compute.googleapis.com storage.googleapis.com iam.googleapis.com \
  iamcredentials.googleapis.com sts.googleapis.com --project "$PROJECT"

say "2/7 Packaging the app"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
VERSION="cloudshell-$(date -u +%Y%m%d-%H%M%S)"
echo "$VERSION" > VERSION
tar --exclude=./data --exclude=./.git -czf "$TMP/app.tgz" .
base64 -w0 "$TMP/app.tgz" > "$TMP/app.b64"
if (( $(stat -c %s "$TMP/app.b64") > 250000 )); then echo "App bundle is too large for VM metadata (max 256 KB)."; exit 1; fi

say "3/7 Backup bucket gs://$BUCKET"
if ! gcloud storage buckets describe "gs://$BUCKET" --project "$PROJECT" >/dev/null 2>&1; then
  gcloud storage buckets create "gs://$BUCKET" --project "$PROJECT" --location "$REGION" --uniform-bucket-level-access
fi
gcloud storage buckets add-iam-policy-binding "gs://$BUCKET" --member "serviceAccount:$VM_SA" --role roles/storage.objectAdmin --quiet >/dev/null

say "4/7 Network: fixed IP and firewall"
if ! gcloud compute addresses describe film-room-ip --region "$REGION" --project "$PROJECT" >/dev/null 2>&1; then
  gcloud compute addresses create film-room-ip --region "$REGION" --project "$PROJECT"
fi
IP="$(gcloud compute addresses describe film-room-ip --region "$REGION" --project "$PROJECT" --format='value(address)')"
if ! gcloud compute firewall-rules describe film-room-web --project "$PROJECT" >/dev/null 2>&1; then
  gcloud compute firewall-rules create film-room-web --project "$PROJECT" --allow tcp:80,tcp:443 --target-tags film-room \
    --description "FTC Film Room web traffic"
fi
HOST="${SITE_HOST:-${IP//./-}.sslip.io}"

ADMIN_PW=""
if gcloud compute instances describe "$VM" --zone "$ZONE" --project "$PROJECT" >/dev/null 2>&1; then
  say "5/7 Server exists: pushing this folder's code (your data stays)"
  gcloud compute instances add-metadata "$VM" --zone "$ZONE" --project "$PROJECT" \
    --metadata "site-host=$HOST,backup-bucket=$BUCKET,app-version=$VERSION" \
    --metadata-from-file "startup-script=deploy/vm-startup.sh,app-bundle=$TMP/app.b64"
else
  say "5/7 Creating the server (e2-micro, free tier)"
  ADMIN_PW="$(python3 -c "import secrets; a='abcdefghjkmnpqrstuvwxyz23456789'; print(''.join(secrets.choice(a) for _ in range(12)))")"
  gcloud compute instances create "$VM" --project "$PROJECT" --zone "$ZONE" \
    --machine-type e2-micro --image-family debian-12 --image-project debian-cloud \
    --boot-disk-size 30GB --boot-disk-type pd-standard \
    --address "$IP" --tags film-room --scopes storage-rw,logging-write,monitoring-write \
    --metadata "site-host=$HOST,backup-bucket=$BUCKET,admin-password=$ADMIN_PW,app-version=$VERSION" \
    --metadata-from-file "startup-script=deploy/vm-startup.sh,app-bundle=$TMP/app.b64"
fi

if [[ -n "$GITHUB_REPO" ]]; then
  say "6/7 Letting GitHub ($GITHUB_REPO, main branch) deploy updates to this server"
  DEPLOYER="film-room-deployer@${PROJECT}.iam.gserviceaccount.com"
  if ! gcloud iam service-accounts describe "$DEPLOYER" --project "$PROJECT" >/dev/null 2>&1; then
    gcloud iam service-accounts create film-room-deployer --project "$PROJECT" --display-name "GitHub deploys for FTC Film Room"
    sleep 10  # new accounts take a moment to become usable
  fi
  if ! gcloud iam workload-identity-pools describe github --location global --project "$PROJECT" >/dev/null 2>&1; then
    gcloud iam workload-identity-pools create github --location global --project "$PROJECT" --display-name "GitHub Actions"
  fi
  if ! gcloud iam workload-identity-pools providers describe film-room --location global --workload-identity-pool github --project "$PROJECT" >/dev/null 2>&1; then
    gcloud iam workload-identity-pools providers create-oidc film-room --location global --workload-identity-pool github --project "$PROJECT" \
      --display-name "ftc-film-room repo" --issuer-uri "https://token.actions.githubusercontent.com" \
      --attribute-mapping "google.subject=assertion.sub,attribute.repository=assertion.repository,attribute.ref=assertion.ref" \
      --attribute-condition "assertion.repository == '${GITHUB_REPO}' && assertion.ref == 'refs/heads/main'"
  fi
  gcloud iam service-accounts add-iam-policy-binding "$DEPLOYER" --project "$PROJECT" --role roles/iam.workloadIdentityUser \
    --member "principalSet://iam.googleapis.com/projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/github/attribute.repository/${GITHUB_REPO}" --quiet >/dev/null
  # Only this VM, nothing else in the project:
  gcloud compute instances add-iam-policy-binding "$VM" --zone "$ZONE" --project "$PROJECT" \
    --member "serviceAccount:$DEPLOYER" --role roles/compute.instanceAdmin.v1 --quiet >/dev/null
  gcloud iam service-accounts add-iam-policy-binding "$VM_SA" --project "$PROJECT" \
    --member "serviceAccount:$DEPLOYER" --role roles/iam.serviceAccountUser --quiet >/dev/null
else
  say "6/7 (no GITHUB_REPO in deploy/gcp.env: skipping automatic deploys)"
fi

code=""
say "7/7 Waiting for https://$HOST to come up (first run installs software: 3-6 minutes)"
for _ in $(seq 1 60); do
  code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 8 "https://$HOST/" || true)"
  [[ "$code" == "200" ]] && break
  printf '.'; sleep 10
done
echo
if [[ "$code" != "200" ]]; then
  echo "Not answering yet. Give it a few more minutes, then open https://$HOST"
  echo "To watch progress: gcloud compute instances get-serial-port-output $VM --zone $ZONE | grep -i film-room | tail"
fi

say "Done"
echo "  Film Room:   https://$HOST"
if [[ -n "$ADMIN_PW" ]]; then
  echo "  Admin login: coach / $ADMIN_PW   (you'll choose a new password on first sign-in)"
  if [[ "$code" == "200" ]]; then
    # The database now holds the password, so remove the one-time copy from the VM's settings.
    gcloud compute instances remove-metadata "$VM" --zone "$ZONE" --project "$PROJECT" --keys admin-password >/dev/null 2>&1 || true
  fi
fi
echo "  Backups:     every 6 h on the server, copied to gs://$BUCKET/backups"
if [[ -n "$GITHUB_REPO" ]]; then
  echo
  echo "  To turn on automatic deploys, send Claude this line:"
  echo "    GCP_PROJECT=$PROJECT GCP_PROJECT_NUMBER=$PROJECT_NUMBER SITE_HOST=$HOST"
fi
