#!/bin/bash
# update-services.sh — Auto-update Lotus Light Link from GitHub
# Supports two modes:
#   1. Git repo: git pull + rebuild if needed
#   2. Release tarball: download latest release from GitHub

set -euo pipefail

APP_DIR="/opt/lotus-light"
PI_DIR="$APP_DIR/pi"
SERVICE="lotus-light"
LOG_PREFIX="[lotus-update]"
GITHUB_REPO="raagerrd-ship-it/lotus-light-link"

# ─── Release-based update (no .git directory) ────────────────────
if [ ! -d "$APP_DIR/.git" ]; then
  echo "$LOG_PREFIX Release-based install detected"

  # Get current version from VERSION.json
  CURRENT_COMMIT=""
  if [ -f "$APP_DIR/VERSION.json" ]; then
    CURRENT_COMMIT=$(python3 -c "import json; print(json.load(open('$APP_DIR/VERSION.json'))['commit'])" 2>/dev/null || echo "")
  fi

  # Check latest release commit from GitHub API
  LATEST_JSON=$(curl -sf "https://api.github.com/repos/$GITHUB_REPO/releases/tags/latest" 2>/dev/null || echo "")
  if [ -z "$LATEST_JSON" ]; then
    echo "$LOG_PREFIX Could not reach GitHub API — skipping"
    exit 0
  fi

  # Extract the target_commitish (commit SHA of the release)
  LATEST_COMMIT=$(echo "$LATEST_JSON" | python3 -c "import json,sys; print(json.load(sys.stdin).get('target_commitish',''))" 2>/dev/null || echo "")

  if [ -z "$LATEST_COMMIT" ]; then
    echo "$LOG_PREFIX Could not parse latest release — skipping"
    exit 0
  fi

  if [ "$CURRENT_COMMIT" = "$LATEST_COMMIT" ]; then
    echo "$LOG_PREFIX Up to date (${CURRENT_COMMIT:0:7})"
    exit 0
  fi

  echo "$LOG_PREFIX Update available: ${CURRENT_COMMIT:0:7} → ${LATEST_COMMIT:0:7}"

  # Download and extract new release
  DOWNLOAD_URL="https://github.com/$GITHUB_REPO/releases/download/latest/dist.tar.gz"
  TMP_DIR=$(mktemp -d)
  trap "rm -rf $TMP_DIR" EXIT

  if ! curl -sfL "$DOWNLOAD_URL" -o "$TMP_DIR/dist.tar.gz"; then
    echo "$LOG_PREFIX Download failed — skipping"
    exit 0
  fi

  # Extract to temp, then swap in
  cd "$TMP_DIR"
  tar xzf dist.tar.gz

  # Replace files (keep pi/data/ for persistent storage)
  rm -rf "$APP_DIR/dist"
  cp -r "$TMP_DIR/dist" "$APP_DIR/dist"
  rm -rf "$PI_DIR/dist"
  cp -r "$TMP_DIR/pi/dist" "$PI_DIR/dist"
  rm -rf "$PI_DIR/node_modules"
  cp -r "$TMP_DIR/pi/node_modules" "$PI_DIR/node_modules"
  cp "$TMP_DIR/pi/package.json" "$PI_DIR/package.json"
  cp "$TMP_DIR/pi/start-lotus.js" "$PI_DIR/start-lotus.js"
  [ -f "$TMP_DIR/VERSION.json" ] && cp "$TMP_DIR/VERSION.json" "$APP_DIR/VERSION.json"

  # Copy updated scripts
  for script in setup-lotus.sh uninstall-lotus.sh update-services.sh; do
    [ -f "$TMP_DIR/pi/$script" ] && cp "$TMP_DIR/pi/$script" "$PI_DIR/$script" && chmod +x "$PI_DIR/$script"
  done

  # Re-apply BLE capabilities
  NODE_BIN=$(which node)
  if [ -n "$NODE_BIN" ]; then
    sudo setcap cap_net_raw+eip "$NODE_BIN" 2>/dev/null || true
  fi

  systemctl --user restart "$SERVICE"
  echo "$LOG_PREFIX Updated to ${LATEST_COMMIT:0:7} and restarted ✓"
  exit 0
fi

# ─── Git-based update ────────────────────────────────────────────
cd "$APP_DIR"

# Detect the default branch dynamically
DEFAULT_BRANCH=$(git symbolic-ref refs/remotes/origin/HEAD 2>/dev/null | sed 's@^refs/remotes/origin/@@')
if [ -z "$DEFAULT_BRANCH" ]; then
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

# Check if pre-built dist exists (release tarball)
WEB_DIST_READY=false
if [ -f "$APP_DIR/dist/index.html" ] && [ -d "$APP_DIR/dist/assets" ]; then
  WEB_DIST_READY=true
fi

# Rebuild web app if frontend changed
if [ -n "$WEB_CHANGED" ]; then
  if [ "$WEB_DIST_READY" = true ]; then
    echo "$LOG_PREFIX Frontend changed — pre-built dist/ found, skipping build ✓"
  elif [ -f "$APP_DIR/package.json" ]; then
    echo "$LOG_PREFIX Frontend changed — rebuilding web app..."
    cd "$APP_DIR"
    export NODE_OPTIONS="--max-old-space-size=256"
    nice -n 15 npm install --no-audit --no-fund 2>&1 | tail -1
    nice -n 15 npx vite build 2>&1 | tail -3
    echo "$LOG_PREFIX Web app build complete ✓"
  else
    echo "$LOG_PREFIX Frontend changed but no dist/ or package.json — cannot build"
  fi
  NEED_RESTART=true
fi

# Rebuild Pi backend if engine/pi changed
if [ -n "$PI_CHANGED" ] || [ -n "$SRC_CHANGED" ]; then
  if [ -f "$PI_DIR/dist/index.js" ] && [ -f "$PI_DIR/node_modules/.package-lock.json" ]; then
    echo "$LOG_PREFIX pi/ changed — pre-built pi/dist/ found, skipping build ✓"
  else
    echo "$LOG_PREFIX pi/ or engine/ changed — rebuilding backend..."
    cd "$PI_DIR"
    export NODE_OPTIONS="--max-old-space-size=256"
    nice -n 15 npm install --no-audit --no-fund 2>&1 | tail -1
    nice -n 15 npm run build
    npm prune --omit=dev 2>/dev/null || npm prune --production 2>/dev/null || true
    echo "$LOG_PREFIX Backend build complete ✓"
  fi

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
  echo "$LOG_PREFIX Service restarted ✓"
else
  echo "$LOG_PREFIX No relevant changes — no restart needed"
fi

echo "$LOG_PREFIX Done"
