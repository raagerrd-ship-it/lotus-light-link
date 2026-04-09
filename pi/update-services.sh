#!/bin/bash
# update-services.sh — Auto-update Lotus Light Link from GitHub
# Called by systemd timer every 5 minutes, or manually.
#
# Logic:
#   1. git fetch
#   2. Compare local HEAD with remote HEAD
#   3. If different: git pull → npm install → rebuild → restart service
#   4. If same: exit silently (no log spam)

set -euo pipefail

APP_DIR="/opt/lotus-light"
PI_DIR="$APP_DIR/pi"
SERVICE="lotus-light"
LOG_PREFIX="[lotus-update]"

# Ensure we're in the repo
if [ ! -d "$APP_DIR/.git" ]; then
  echo "$LOG_PREFIX No git repo at $APP_DIR — skipping"
  exit 0
fi

cd "$APP_DIR"

# Fetch latest from remote
git fetch --all -q 2>/dev/null || {
  echo "$LOG_PREFIX git fetch failed (network?)"
  exit 0
}

# Compare HEAD
LOCAL_HEAD=$(git rev-parse HEAD)
REMOTE_HEAD=$(git rev-parse origin/main 2>/dev/null || git rev-parse origin/master 2>/dev/null)

if [ "$LOCAL_HEAD" = "$REMOTE_HEAD" ]; then
  # No changes — exit silently
  exit 0
fi

echo "$LOG_PREFIX Update detected: ${LOCAL_HEAD:0:7} → ${REMOTE_HEAD:0:7}"

# Check if pi/ files changed
PI_CHANGED=$(git diff --name-only "$LOCAL_HEAD" "$REMOTE_HEAD" -- pi/ | head -1)
SRC_CHANGED=$(git diff --name-only "$LOCAL_HEAD" "$REMOTE_HEAD" -- src/lib/engine/ | head -1)

# Pull changes
git reset --hard origin/main -q 2>/dev/null || git reset --hard origin/master -q
echo "$LOG_PREFIX Pulled to $(git rev-parse --short HEAD)"

# Check if pi runtime needs rebuild
if [ -n "$PI_CHANGED" ] || [ -n "$SRC_CHANGED" ]; then
  echo "$LOG_PREFIX pi/ or engine/ changed — rebuilding..."
  
  cd "$PI_DIR"
  
  # Always install before build: previous deploy prunes devDependencies,
  # so TypeScript/build deps may be missing even when package.json is unchanged.
  echo "$LOG_PREFIX Installing dependencies for build..."
  npm install --no-audit --no-fund 2>&1 | tail -1
  
  # Rebuild TypeScript
  npm run build
  npm prune --production 2>/dev/null || true
  echo "$LOG_PREFIX Build complete ✓"
  
  # Restart service
  systemctl restart "$SERVICE"
  echo "$LOG_PREFIX Service restarted ✓"
else
  echo "$LOG_PREFIX No pi/ or engine/ changes — no restart needed"
fi

echo "$LOG_PREFIX Done"
