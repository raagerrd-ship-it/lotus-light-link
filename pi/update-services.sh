#!/bin/bash
# update-services.sh — Auto-update Lotus Light Link from GitHub
# Called by user-level systemd timer every 5 minutes, or manually.

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

# Detect the default branch dynamically
DEFAULT_BRANCH=$(git symbolic-ref refs/remotes/origin/HEAD 2>/dev/null | sed 's@^refs/remotes/origin/@@')
if [ -z "$DEFAULT_BRANCH" ]; then
  # Fallback: try main, then master
  if git rev-parse --verify origin/main &>/dev/null; then
    DEFAULT_BRANCH="main"
  else
    DEFAULT_BRANCH="master"
  fi
fi

git fetch origin "$DEFAULT_BRANCH" -q 2>/dev/null || {
  echo "$LOG_PREFIX git fetch failed (network?)"
  exit 0
}

LOCAL_HEAD=$(git rev-parse HEAD)
REMOTE_HEAD=$(git rev-parse "origin/$DEFAULT_BRANCH" 2>/dev/null)

if [ -z "$REMOTE_HEAD" ]; then
  echo "$LOG_PREFIX Could not resolve origin/$DEFAULT_BRANCH"
  exit 0
fi

if [ "$LOCAL_HEAD" = "$REMOTE_HEAD" ]; then
  echo "$LOG_PREFIX Up to date (${LOCAL_HEAD:0:7} on $DEFAULT_BRANCH)"
  exit 0
fi

echo "$LOG_PREFIX Update detected: ${LOCAL_HEAD:0:7} → ${REMOTE_HEAD:0:7}"

PI_CHANGED=$(git diff --name-only "$LOCAL_HEAD" "$REMOTE_HEAD" -- pi/ 2>/dev/null | head -1)
SRC_CHANGED=$(git diff --name-only "$LOCAL_HEAD" "$REMOTE_HEAD" -- src/lib/engine/ 2>/dev/null | head -1)
WEB_CHANGED=$(git diff --name-only "$LOCAL_HEAD" "$REMOTE_HEAD" -- src/ index.html vite.config.ts 2>/dev/null | head -1)

git reset --hard "origin/$DEFAULT_BRANCH" -q
echo "$LOG_PREFIX Pulled to $(git rev-parse --short HEAD)"

NEED_RESTART=false

# Rebuild web app if frontend changed
if [ -n "$WEB_CHANGED" ]; then
  echo "$LOG_PREFIX Frontend changed — rebuilding web app..."
  cd "$APP_DIR"
  export NODE_OPTIONS="--max-old-space-size=256"
  nice -n 15 npm install --no-audit --no-fund 2>&1 | tail -1
  nice -n 15 npx vite build 2>&1 | tail -3
  echo "$LOG_PREFIX Web app build complete ✓"
  NEED_RESTART=true
fi

# Rebuild Pi backend if engine/pi changed
if [ -n "$PI_CHANGED" ] || [ -n "$SRC_CHANGED" ]; then
  echo "$LOG_PREFIX pi/ or engine/ changed — rebuilding backend..."
  cd "$PI_DIR"
  export NODE_OPTIONS="--max-old-space-size=256"
  nice -n 15 npm install --no-audit --no-fund 2>&1 | tail -1
  nice -n 15 npm run build
  npm prune --omit=dev 2>/dev/null || npm prune --production 2>/dev/null || true
  echo "$LOG_PREFIX Backend build complete ✓"

  # Re-apply BLE capabilities in case Node binary was updated by apt
  NODE_BIN=$(which node)
  if [ -n "$NODE_BIN" ]; then
    sudo setcap cap_net_raw+eip "$NODE_BIN" 2>/dev/null && \
      echo "$LOG_PREFIX BLE cap_net_raw re-applied to $NODE_BIN ✓" || \
      echo "$LOG_PREFIX WARNING: Failed to set BLE capabilities on $NODE_BIN"
  fi
  NEED_RESTART=true
fi

if [ "$NEED_RESTART" = true ]; then
  systemctl --user restart "$SERVICE"
  systemctl --user restart "${SERVICE}-web"
  echo "$LOG_PREFIX Services restarted ✓"
else
  echo "$LOG_PREFIX No relevant changes — no restart needed"
fi

echo "$LOG_PREFIX Done"
