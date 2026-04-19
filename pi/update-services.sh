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
CURRENT_VERSION=""
if [ -f "$APP_DIR/VERSION.json" ]; then
  CURRENT_VERSION=$(python3 -c "import json; print(json.load(open('$APP_DIR/VERSION.json')).get('version',''))" 2>/dev/null || echo "")
fi

# Check latest valid semver release from GitHub API (skip legacy malformed tags and the "latest" pointer tag)
LATEST_JSON=$(curl -sf "https://api.github.com/repos/$GITHUB_REPO/releases" 2>/dev/null | python3 -c "
import json,re,sys
releases = json.load(sys.stdin)
for r in releases:
    tag = r.get('tag_name','')
    if re.fullmatch(r'v\\d+\\.\\d+\\.\\d+', tag) and not r.get('draft') and not r.get('prerelease'):
        print(json.dumps(r))
        break
" 2>/dev/null || echo "")
if [ -z "$LATEST_JSON" ]; then
  echo "$LOG_PREFIX ERROR: Could not reach GitHub API or no valid semver release found"
  exit 1
fi

LATEST_TAG=$(echo "$LATEST_JSON" | python3 -c "import json,sys; print(json.load(sys.stdin).get('tag_name',''))" 2>/dev/null || echo "")
LATEST_VERSION=${LATEST_TAG#v}

if [ -z "$LATEST_VERSION" ]; then
  echo "$LOG_PREFIX ERROR: Could not parse latest release version"
  exit 1
fi

if [ -n "$CURRENT_VERSION" ] && [ "$CURRENT_VERSION" = "$LATEST_VERSION" ]; then
  echo "$LOG_PREFIX Already up to date (v${CURRENT_VERSION})"
  exit 0
fi

echo "$LOG_PREFIX Updating: v${CURRENT_VERSION:-unknown} → $LATEST_TAG"

# Download release tarball
TARBALL_URL=$(echo "$LATEST_JSON" | python3 -c "import json,sys; assets=json.load(sys.stdin).get('assets',[]); print(next((a['browser_download_url'] for a in assets if a['name']=='dist.tar.gz'),''))" 2>/dev/null || echo "")
if [ -z "$TARBALL_URL" ]; then
  echo "$LOG_PREFIX ERROR: No dist.tar.gz asset found in release"
  exit 1
fi
DOWNLOAD_URL="$TARBALL_URL"
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

# Vendor-mapp: pi/vendor/alsa-capture innehåller native N-API-bindning
# (källa + binding.gyp + ev. pre-built build/Release/capture.node från CI).
# MÅSTE kopieras hit annars faller alsaMic.ts tillbaka på arecord-subprocess
# och ALLA latens-optimeringar (32-frame periods, SCHED_FIFO) blir inaktiva.
if [ -d "$TMP_DIR/pi/vendor" ]; then
  rm -rf "$PI_DIR/vendor"
  cp -r "$TMP_DIR/pi/vendor" "$PI_DIR/vendor"
  echo "$LOG_PREFIX Vendor-mapp synkad ✓"
fi

[ -f "$TMP_DIR/VERSION.json" ] && cp "$TMP_DIR/VERSION.json" "$APP_DIR/VERSION.json"
[ -f "$TMP_DIR/pi/services.json" ] && cp "$TMP_DIR/pi/services.json" "$PI_DIR/services.json"

# Copy updated scripts
for script in setup-lotus.sh uninstall-lotus.sh update-services.sh; do
  [ -f "$TMP_DIR/pi/$script" ] && cp "$TMP_DIR/pi/$script" "$PI_DIR/$script" && chmod +x "$PI_DIR/$script"
done

# Clean up legacy systemd service if still installed
if systemctl is-active --quiet lotus-light-engine.service 2>/dev/null; then
  sudo systemctl stop lotus-light-engine.service
  sudo systemctl disable lotus-light-engine.service
  sudo rm -f /etc/systemd/system/lotus-light-engine.service
  sudo systemctl daemon-reload
  echo "$LOG_PREFIX Removed legacy systemd service ✓"
fi

# BLE permissions (CAP_NET_RAW/CAP_NET_ADMIN) are handled by
# Pi Control Center via systemd AmbientCapabilities — no manual
# bluetooth group or polkit rules needed.

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

# ── Vendored alsa-capture: säkerställ att N-API-bindningen är byggd och laddbar ──
# CI bygger capture.node för ARM64+Node24 på release-runnern. Om den filen saknas
# (gammal release, korrupt tarball, arch-mismatch) bygger vi om lokalt på Pi:n.
ALSA_VENDOR="$PI_DIR/vendor/alsa-capture"
if [ -d "$ALSA_VENDOR" ]; then
  cd "$ALSA_VENDOR"
  NEEDS_REBUILD=0
  if [ ! -f "build/Release/capture.node" ]; then
    echo "$LOG_PREFIX alsa-capture: capture.node saknas — bygger lokalt..."
    NEEDS_REBUILD=1
  elif ! node -e "require('./build/Release/capture.node')" 2>/dev/null; then
    echo "$LOG_PREFIX alsa-capture: capture.node inkompatibel (arch/Node-mismatch) — bygger om..."
    NEEDS_REBUILD=1
  else
    echo "$LOG_PREFIX alsa-capture: capture.node OK ($(stat -c%s build/Release/capture.node 2>/dev/null) bytes) ✓"
  fi

  if [ "$NEEDS_REBUILD" = "1" ]; then
    # ALSA-headers krävs för att kompilera mot libasound.
    if ! dpkg -s libasound2-dev >/dev/null 2>&1; then
      echo "$LOG_PREFIX Installerar libasound2-dev (krävs för alsa-capture build)..."
      apt-get update -qq && apt-get install -y -qq libasound2-dev || {
        echo "$LOG_PREFIX WARN: libasound2-dev install misslyckades — addon kommer falla tillbaka på arecord"
      }
    fi
    # Installera node-addon-api lokalt (devDep för bindningen) + bygg
    npm install --no-audit --no-fund --ignore-scripts --no-save 2>&1 | tail -3 || true
    if command -v node-gyp >/dev/null 2>&1; then
      node-gyp rebuild --release 2>&1 | tail -5
    else
      npx --yes node-gyp@10 rebuild --release 2>&1 | tail -5
    fi
    if [ -f "build/Release/capture.node" ]; then
      echo "$LOG_PREFIX alsa-capture: lokal build OK ✓"
    else
      echo "$LOG_PREFIX WARN: alsa-capture build FAILED — engine fortsätter med arecord-fallback"
    fi
  fi
  cd "$APP_DIR"
else
  echo "$LOG_PREFIX WARN: $ALSA_VENDOR saknas — engine använder arecord-fallback (högre latens)"
fi

# Read new version + commit
NEW_VERSION=""
NEW_COMMIT=""
if [ -f "$APP_DIR/VERSION.json" ]; then
  NEW_VERSION=$(python3 -c "import json; print(json.load(open('$APP_DIR/VERSION.json')).get('version',''))" 2>/dev/null || echo "")
  NEW_COMMIT=$(python3 -c "import json; d=json.load(open('$APP_DIR/VERSION.json')); print(d.get('commitShort') or d.get('commit',''))" 2>/dev/null || echo "")
fi

echo "$LOG_PREFIX Updated to v${NEW_VERSION}${NEW_COMMIT:+ (${NEW_COMMIT:0:7})} ✓"

# Explicit engine restart — PCC's post-update restart är opålitlig och har lett
# till att engine kör gammal kod i minnet medan UI (static) redan visar nya
# filer. Vi gör en best-effort restart både som user-service (PCC's standard)
# och system-service (om någon installerat det så historiskt). Felar tyst om
# tjänsten inte finns på den nivån.
echo "$LOG_PREFIX Forcing engine restart to load new code..."
RESTART_USER=""
RESTART_SYSTEM=""
if systemctl --user list-unit-files lotus-light-engine.service >/dev/null 2>&1; then
  if systemctl --user restart lotus-light-engine.service 2>/dev/null; then
    RESTART_USER="user"
  fi
fi
if systemctl list-unit-files lotus-light-engine.service >/dev/null 2>&1; then
  if sudo systemctl restart lotus-light-engine.service 2>/dev/null; then
    RESTART_SYSTEM="system"
  fi
fi
if [ -n "$RESTART_USER" ] || [ -n "$RESTART_SYSTEM" ]; then
  echo "$LOG_PREFIX Engine restarted (${RESTART_USER:+user-service }${RESTART_SYSTEM:+system-service}) ✓"
else
  echo "$LOG_PREFIX WARN: Could not restart engine — Pi Control Center will retry."
fi
echo "$LOG_PREFIX Pi Control Center will also restart services."
