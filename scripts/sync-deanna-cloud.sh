#!/usr/bin/env bash
# Start deanna-cloud, push upstream from this machine, restart dotflowy, then stop the instance.
#
# The cloud VM cannot SSH back to deanna as mrx (no key), so we push from here instead of
# running `rsync mrx@deanna:...` on the instance.
set -euo pipefail

PROJECT="${PROJECT:-arpteg}"
INSTANCE="${INSTANCE:-deanna-cloud}"
ZONE="${ZONE:-europe-north2-a}"
REMOTE_USER="${REMOTE_USER:-anders}"
LOCAL_SRC="${LOCAL_SRC:-/home/mrx/aai/aaflowy/upstream/}"
REMOTE_DEST="${REMOTE_DEST:-/home/anders/aai/aaflowy/upstream/}"
SSH_KEY="${SSH_KEY:-${HOME}/.ssh/google_compute_engine}"

STARTED=0

remote_ssh() {
  gcloud compute ssh "${REMOTE_USER}@${INSTANCE}" \
    --project="$PROJECT" \
    --zone="$ZONE" \
    --command="$1"
}

cleanup() {
  if [[ "$STARTED" -eq 1 ]]; then
    echo "==> Stopping ${INSTANCE}..."
    gcloud compute instances stop "$INSTANCE" \
      --project="$PROJECT" \
      --zone="$ZONE"
  fi
}
trap cleanup EXIT

echo "==> Starting ${INSTANCE} in ${PROJECT} (${ZONE})..."
gcloud compute instances start "$INSTANCE" \
  --project="$PROJECT" \
  --zone="$ZONE"
STARTED=1

echo "==> Waiting for SSH..."
for i in $(seq 1 60); do
  if remote_ssh "true" 2>/dev/null; then
    break
  fi
  if [[ "$i" -eq 60 ]]; then
    echo "ERROR: SSH not ready after ~5 minutes" >&2
    exit 1
  fi
  sleep 5
done

EXTERNAL_IP="$(gcloud compute instances describe "$INSTANCE" \
  --project="$PROJECT" \
  --zone="$ZONE" \
  --format='get(networkInterfaces[0].accessConfigs[0].natIP)')"
if [[ -z "$EXTERNAL_IP" ]]; then
  echo "ERROR: no external IP on ${INSTANCE}" >&2
  exit 1
fi

echo "==> Stopping dotflowy on ${INSTANCE}..."
remote_ssh '
  set -euo pipefail
  export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
  systemctl --user stop dotflowy
'

echo "==> Pushing ${LOCAL_SRC} -> ${REMOTE_USER}@${EXTERNAL_IP}:${REMOTE_DEST}"
rsync -avzu --progress \
  -e "ssh -i ${SSH_KEY} -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new" \
  "${LOCAL_SRC}" \
  "${REMOTE_USER}@${EXTERNAL_IP}:${REMOTE_DEST}"

echo "==> Starting dotflowy on ${INSTANCE}..."
remote_ssh '
  set -euo pipefail
  export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
  systemctl --user start dotflowy
'

echo "==> Done. Stopping instance via cleanup trap."
