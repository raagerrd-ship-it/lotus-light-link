#!/bin/bash
# update-services.sh — Auto-update Lotus Light Link from GitHub
# Called by systemd timer every 5 minutes, or manually.

set -euo pipefail

APP_DIR="/opt/lotus-light"
PI_DIR="$APP_DIR/pi"
SERVICE="lotus-light"
LOG_PREFIX="[lotus-update]"

if [ ! -d "$APP_DIR/.git" ]; then
  echo "$LOG_PREFIX No git repo at $APP_DIR — skipping"
  exit 0
fi

cd "$APP_DIR"

git fetch --all -q 2>/dev/null || {
  echo "$LOG_PREFIX git fetch failed (network?)"
  exit 0
}

LOCAL_HEAD=$(git rev-parse HEAD)
REMOTE_HEAD=$(git rev-parse origin/main 2>/dev/null || git rev-parse origin/master 2>/dev/null)

if [ "$LOCAL_HEAD" = "$REMOTE_HEAD" ]; then
  exit 0
fi

echo "$LOG_PREFIX Update detected: ${LOCAL_HEAD:0:7} → ${REMOTE_HEAD:0:7}"

PI_CHANGED=$(git diff --name-only "$LOCAL_HEAD" "$REMOTE_HEAD" -- pi/ | head -1)
SRC_CHANGED=$(git diff --name-only "$LOCAL_HEAD" "$REMOTE_HEAD" -- src/lib/engine/ | head -1)

git reset --hard origin/main -q 2>/dev/null || git reset --hard origin/master -q
echo "$LOG_PREFIX Pulled to $(git rev-parse --short HEAD)"

if [ -n "$PI_CHANGED" ] || [ -n "$SRC_CHANGED" ]; then
  echo "$LOG_PREFIX pi/ or engine/ changed — rebuilding..."
  cd "$PI_DIR"

  export NODE_OPTIONS="--max-old-space-size=256"
  nice -n 15 npm install --no-audit --no-fund 2>&1 | tail -1
  nice -n 15 npm run build
  npm prune --omit=dev 2>/dev/null || npm prune --production 2>/dev/null || true
  echo "$LOG_PREFIX Build complete ✓"

  sudo systemctl restart "$SERVICE"
  echo "$LOG_PREFIX Service restarted ✓"
else
  echo "$LOG_PREFIX No pi/ or engine/ changes — no restart needed"
fi

echo "$LOG_PREFIX Done"
