#!/bin/bash
# update-services.sh — Update Lotus Light Link from GitHub release
# Called by Pi Control Center. Downloads latest release tarball and replaces files.
# Pi Control Center handles service restarts after this script completes.

set -euo pipefail

APP_DIR="/opt/lotus-light"
PI_DIR="$APP_DIR/pi"
LOG_PREFIX="[lotus-update]"
GITHUB_REPO="raagerrd-ship-it/lotus-light-link"

echo "$LOG_PREFIX Checking for updates..."

# Get current version
CURRENT_COMMIT=""
CURRENT_VERSION=""
if [ -f "$APP_DIR/VERSION.json" ]; then
  CURRENT_COMMIT=$(python3 -c "import json; print(json.load(open('$APP_DIR/VERSION.json')).get('commit',''))" 2>/dev/null || echo "")
  CURRENT_VERSION=$(python3 -c "import json; print(json.load(open('$APP_DIR/VERSION.json')).get('version',''))" 2>/dev/null || echo "")
fi

# Check latest release from GitHub API
LATEST_JSON=$(curl -sf "https://api.github.com/repos/$GITHUB_REPO/releases/tags/latest" 2>/dev/null || echo "")
if [ -z "$LATEST_JSON" ]; then
  echo "$LOG_PREFIX ERROR: Could not reach GitHub API"
  exit 1
fi

LATEST_COMMIT=$(echo "$LATEST_JSON" | python3 -c "import json,sys; print(json.load(sys.stdin).get('target_commitish',''))" 2>/dev/null || echo "")

if [ -z "$LATEST_COMMIT" ]; then
  echo "$LOG_PREFIX ERROR: Could not parse latest release"
  exit 1
fi

if [ "$CURRENT_COMMIT" = "$LATEST_COMMIT" ]; then
  echo "$LOG_PREFIX Already up to date (v${CURRENT_VERSION} ${CURRENT_COMMIT:0:7})"
  exit 0
fi

echo "$LOG_PREFIX Updating: ${CURRENT_COMMIT:0:7} → ${LATEST_COMMIT:0:7}"

# Download release tarball
DOWNLOAD_URL="https://github.com/$GITHUB_REPO/releases/download/latest/dist.tar.gz"
TMP_DIR=$(mktemp -d)
trap "rm -rf $TMP_DIR" EXIT

if ! curl -sfL "$DOWNLOAD_URL" -o "$TMP_DIR/dist.tar.gz"; then
  echo "$LOG_PREFIX ERROR: Download failed"
  exit 1
fi

cd "$TMP_DIR"
tar xzf dist.tar.gz

# Replace files (preserve pi/data/ for persistent storage)
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
NODE_BIN=$(readlink -f "$(which node)")
if [ -n "$NODE_BIN" ]; then
  sudo setcap cap_net_raw+eip "$NODE_BIN" 2>/dev/null || true
fi

# Rebuild native modules if architecture or Node version differs
BUILD_ARCH=$(python3 -c "import json; print(json.load(open('$APP_DIR/VERSION.json')).get('arch',''))" 2>/dev/null || echo "")
BUILD_NODE=$(python3 -c "import json; v=json.load(open('$APP_DIR/VERSION.json')).get('nodeVersion',''); print(v.split('.')[0])" 2>/dev/null || echo "")
PI_ARCH=$(uname -m)
PI_NODE=$(node -v | cut -d. -f1)

if [ "$BUILD_ARCH" != "$PI_ARCH" ] || [ "$BUILD_NODE" != "$PI_NODE" ]; then
  echo "$LOG_PREFIX Native modules mismatch (build: $BUILD_ARCH/$BUILD_NODE, pi: $PI_ARCH/$PI_NODE) — rebuilding..."
  cd "$PI_DIR" && npm rebuild 2>&1 | tail -5
  echo "$LOG_PREFIX Native modules rebuilt ✓"
else
  echo "$LOG_PREFIX Native modules OK (arch=$PI_ARCH, node=$PI_NODE) — skipping rebuild ✓"
fi

# Read new version
NEW_VERSION=""
if [ -f "$APP_DIR/VERSION.json" ]; then
  NEW_VERSION=$(python3 -c "import json; print(json.load(open('$APP_DIR/VERSION.json')).get('version',''))" 2>/dev/null || echo "")
fi

echo "$LOG_PREFIX Updated to v${NEW_VERSION} (${LATEST_COMMIT:0:7}) ✓"
echo "$LOG_PREFIX Pi Control Center will restart services."
