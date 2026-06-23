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
  # Hård säkerhetskontroll: även om versionen matchar, vägra säga "up to date"
  # om kritiska deployment-artefakter saknas eller är trasiga. Detta fångar
  # fall där en tidigare update kraschade halvvägs eller en gammal release
  # installerades innan setup-lotus.sh kunde skapa system-servicen.
  HEALTH_OK=1
  HEALTH_REASONS=""

  # 1. System-service MÅSTE finnas (user-service ärver inte SupplementaryGroups → BLE failar)
  if [ ! -f /etc/systemd/system/lotus-light-engine.service ]; then
    HEALTH_OK=0
    HEALTH_REASONS="$HEALTH_REASONS\n  - /etc/systemd/system/lotus-light-engine.service saknas"
  elif ! grep -q "SupplementaryGroups=netdev bluetooth audio" /etc/systemd/system/lotus-light-engine.service 2>/dev/null; then
    HEALTH_OK=0
    HEALTH_REASONS="$HEALTH_REASONS\n  - System-service saknar SupplementaryGroups=netdev bluetooth audio"
  elif ! grep -q "DeviceAllow=char-alsa" /etc/systemd/system/lotus-light-engine.service 2>/dev/null; then
    HEALTH_OK=0
    HEALTH_REASONS="$HEALTH_REASONS\n  - System-service saknar DeviceAllow=char-alsa (mic får ENOENT pga DevicePolicy=closed)"
  fi

  # 2. Engine-bundle måste finnas
  if [ ! -f "$PI_DIR/dist/index.js" ]; then
    HEALTH_OK=0
    HEALTH_REASONS="$HEALTH_REASONS\n  - $PI_DIR/dist/index.js saknas"
  fi

  # 3. BLE_BUILD_TAG i deployad bundle måste matcha förväntad tag för denna release.
  #    GitHub release-noten har formatet "BLE_BUILD_TAG: <tag>" på en egen rad.
  #    Om release-noten inte innehåller en sådan rad hoppar vi över denna check
  #    (bakåtkompatibelt med äldre releases).
  EXPECTED_TAG=$(echo "$LATEST_JSON" | python3 -c "
import json,re,sys
body = json.load(sys.stdin).get('body','') or ''
m = re.search(r'BLE_BUILD_TAG:\\s*([^\\s]+)', body)
print(m.group(1) if m else '')
" 2>/dev/null || echo "")
  if [ -n "$EXPECTED_TAG" ] && [ -f "$PI_DIR/dist/ble-driver/state.js" ]; then
    DEPLOYED_TAG=$(grep -oE "BLE_BUILD_TAG[^'\"]*['\"]([^'\"]+)['\"]" "$PI_DIR/dist/ble-driver/state.js" 2>/dev/null | head -1 | sed -E "s/.*['\"]([^'\"]+)['\"].*/\\1/" || echo "")
    if [ -n "$DEPLOYED_TAG" ] && [ "$DEPLOYED_TAG" != "$EXPECTED_TAG" ]; then
      HEALTH_OK=0
      HEALTH_REASONS="$HEALTH_REASONS\n  - BLE_BUILD_TAG mismatch: deployed='$DEPLOYED_TAG' förväntat='$EXPECTED_TAG'"
    fi
  fi

  if [ "$HEALTH_OK" = "1" ]; then
    echo "$LOG_PREFIX Already up to date (v${CURRENT_VERSION}) — health-check OK ✓"
    exit 0
  fi

  echo "$LOG_PREFIX Version matchar (v${CURRENT_VERSION}) MEN health-check FAILADE:"
  printf "$HEALTH_REASONS\n"
  echo "$LOG_PREFIX Tvingar full re-deploy för att reparera..."
  # Fortsätt nedåt i scriptet → ladda ner tarball, packa upp, kör setup-lotus.sh
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

# ── Storage-rättigheter (KRITISKT) ──
# update-services.sh körs som root via PCC. cp -r ovan skapar nya filer/mappar
# med ägare root:root → engine får EACCES vid writeFileSync(...) och /api/* save
# svarar 500. Storage ligger numera primärt i PCC_DATA_DIR/PCC_CONFIG_DIR, inte
# nödvändigtvis i /opt/lotus-light/pi/data — fixa därför ALLA kandidater.
resolve_target_user() {
  # Prio: explicit override → befintlig systemd User= (om ≠ root) → pi (default)
  # → lotus → SUDO_USER → USER → root.
  if [ -n "${LOTUS_SERVICE_USER:-}" ] && id "$LOTUS_SERVICE_USER" >/dev/null 2>&1; then
    echo "$LOTUS_SERVICE_USER"; return
  fi
  local svc_user=""
  if [ -f /etc/systemd/system/lotus-light-engine.service ]; then
    svc_user="$(grep -E '^User=' /etc/systemd/system/lotus-light-engine.service 2>/dev/null | head -1 | cut -d= -f2- || true)"
  fi
  if [ -n "$svc_user" ] && [ "$svc_user" != "root" ] && id "$svc_user" >/dev/null 2>&1; then
    echo "$svc_user"; return
  fi
  if id pi >/dev/null 2>&1; then echo pi; return; fi
  if id lotus >/dev/null 2>&1; then echo lotus; return; fi
  if [ -n "${SUDO_USER:-}" ] && [ "${SUDO_USER:-}" != "root" ]; then echo "$SUDO_USER"; return; fi
  if [ -n "${USER:-}" ] && [ "${USER:-}" != "root" ]; then echo "$USER"; return; fi
  echo root
}
TARGET_USER="$(resolve_target_user)"
TARGET_GROUP="$(id -gn "$TARGET_USER" 2>/dev/null || echo "$TARGET_USER")"
TARGET_HOME="$(getent passwd "$TARGET_USER" 2>/dev/null | cut -d: -f6)"
mkdir -p "$PI_DIR/data"
for STORAGE_DIR in \
  "$PI_DIR/data" \
  "${PCC_DATA_DIR:-}" \
  "${PCC_CONFIG_DIR:-}" \
  "${LOTUS_DATA_DIR:-}" \
  "$TARGET_HOME/.local/share/lotus-light" \
  "/var/lib/lotus-light"
do
  [ -z "$STORAGE_DIR" ] && continue
  mkdir -p "$STORAGE_DIR" 2>/dev/null || true
  chown -R "$TARGET_USER:$TARGET_GROUP" "$STORAGE_DIR" 2>/dev/null || true
  chmod -R u+rwX,g+rwX "$STORAGE_DIR" 2>/dev/null || true
done
if ! chown -R "$TARGET_USER:$TARGET_GROUP" "$APP_DIR" 2>/dev/null; then
  echo "$LOG_PREFIX WARN: chown $APP_DIR misslyckades — engine kan få EACCES på storage"
else
  echo "$LOG_PREFIX Storage-rättigheter verifierade: APP + data/config dirs ägs av $TARGET_USER:$TARGET_GROUP ✓"
fi


# IMPORTANT: do NOT remove /etc/systemd/system/lotus-light-engine.service here.
# setup-lotus.sh installerar medvetet engine som SYSTEM-service (inte PCC:s
# user-service) för att kunna sätta SupplementaryGroups=netdev bluetooth —
# utan dessa fastnar noble i state=unknown och kräver SSH-restart för att
# vakna. Se mem://pi/runtime/engine-must-be-system-service.
#
# Om system-servicen saknas (t.ex. första update efter en gammal installation
# som bara hade user-service), återskapa den genom att köra setup-lotus.sh
# som bara reinstallerar service-blocket — det är idempotent och bygger inte
# om något om dist/ redan finns.
SETUP_NEEDED=0
if [ ! -f /etc/systemd/system/lotus-light-engine.service ]; then
  echo "$LOG_PREFIX System-service saknas — kör setup-lotus.sh för att skapa..."
  SETUP_NEEDED=1
elif ! grep -q "SupplementaryGroups=netdev bluetooth audio" /etc/systemd/system/lotus-light-engine.service 2>/dev/null; then
  echo "$LOG_PREFIX System-service saknar SupplementaryGroups=netdev bluetooth audio — kör setup-lotus.sh för att fixa..."
  SETUP_NEEDED=1
else
  # Service-filen ser OK ut. Verifiera ändå att node-binären har caps + user är i grupperna —
  # detta är BILLIGT och kritiskt för BLE. Sker varje update så regressioner fångas snabbt.
  TARGET_USER_VERIFY="${SUDO_USER:-${USER:-pi}}"
  NODE_BIN_VERIFY="$(readlink -f "$(command -v node)" 2>/dev/null || true)"
  if [ -n "$NODE_BIN_VERIFY" ] && ! getcap "$NODE_BIN_VERIFY" 2>/dev/null | grep -q "cap_net_raw"; then
    echo "$LOG_PREFIX node-binären saknar CAP_NET_RAW — sätter caps..."
    sudo setcap 'cap_net_raw,cap_net_admin+eip' "$NODE_BIN_VERIFY" 2>/dev/null || true
  fi
  # hcitool behöver CAP_NET_ADMIN+CAP_NET_RAW för `hcitool lecup` (20ms BLE
  # connection interval). Utan detta faller länken till ~50ms efter reconnect.
  # Verifieras varje update så fixen överlever /api/update (men inte OS-ominstall).
  HCITOOL_BIN_VERIFY="$(command -v hcitool 2>/dev/null || true)"
  if [ -n "$HCITOOL_BIN_VERIFY" ] && ! getcap "$HCITOOL_BIN_VERIFY" 2>/dev/null | grep -q "cap_net_admin"; then
    echo "$LOG_PREFIX hcitool saknar CAP_NET_ADMIN — sätter caps (för 20ms BLE-interval)..."
    sudo setcap 'cap_net_admin,cap_net_raw+eip' "$HCITOOL_BIN_VERIFY" 2>/dev/null || true
  fi
  for GRP in netdev bluetooth audio; do
    if getent group "$GRP" >/dev/null 2>&1 && ! id -nG "$TARGET_USER_VERIFY" 2>/dev/null | tr ' ' '\n' | grep -qx "$GRP"; then
      echo "$LOG_PREFIX $TARGET_USER_VERIFY saknas i $GRP — lägger till (kräver service-restart för att aktiveras)..."
      sudo usermod -aG "$GRP" "$TARGET_USER_VERIFY" 2>/dev/null || true
    fi
  done
  if ! systemctl is-active bluetooth >/dev/null 2>&1; then
    echo "$LOG_PREFIX bluetooth.service inte igång — startar..."
    sudo systemctl enable --now bluetooth 2>/dev/null || true
  fi
  echo "$LOG_PREFIX System-service intakt + BLE permissions verifierade ✓"
fi

if [ "$SETUP_NEEDED" = "1" ]; then
  if [ -x "$PI_DIR/setup-lotus.sh" ]; then
    bash "$PI_DIR/setup-lotus.sh" || echo "$LOG_PREFIX WARN: setup-lotus.sh returnerade fel — kontrollera manuellt"
  else
    echo "$LOG_PREFIX WARN: $PI_DIR/setup-lotus.sh saknas eller är inte körbar — engine kan fastna i user-service-läge"
  fi
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
      echo "$LOG_PREFIX FATAL: alsa-capture build FAILED — engine kan inte starta utan native binding (arecord-fallback borttagen för minimal latens)"
      exit 1
    fi
  fi
  # Verifiera att binären också går att ladda mot installerad Node
  if ! node -e "require('./build/Release/capture.node')" 2>/dev/null; then
    echo "$LOG_PREFIX FATAL: capture.node finns men kan inte laddas — kör: cd $ALSA_VENDOR && sudo npm rebuild"
    exit 1
  fi
  cd "$APP_DIR"
else
  echo "$LOG_PREFIX FATAL: $ALSA_VENDOR saknas — engine kan inte starta mic"
  exit 1
fi

# Read new version + commit
NEW_VERSION=""
NEW_COMMIT=""
if [ -f "$APP_DIR/VERSION.json" ]; then
  NEW_VERSION=$(python3 -c "import json; print(json.load(open('$APP_DIR/VERSION.json')).get('version',''))" 2>/dev/null || echo "")
  NEW_COMMIT=$(python3 -c "import json; d=json.load(open('$APP_DIR/VERSION.json')); print(d.get('commitShort') or d.get('commit',''))" 2>/dev/null || echo "")
fi

echo "$LOG_PREFIX Updated to v${NEW_VERSION}${NEW_COMMIT:+ (${NEW_COMMIT:0:7})} ✓"

# Explicit engine restart — endast system-servicen (setup-lotus.sh installerar
# bara den varianten; PCC:s user-service är medvetet disablad så den inte
# konfliktar om porten). Om en gammal user-service-rest finns, stoppa den
# först så vi inte har två processer på samma port.
echo "$LOG_PREFIX Forcing engine restart to load new code..."
TARGET_USER="$(resolve_target_user)"
TARGET_UID="$(id -u "$TARGET_USER" 2>/dev/null || echo 1000)"
if sudo -u "$TARGET_USER" XDG_RUNTIME_DIR=/run/user/$TARGET_UID systemctl --user is-active lotus-light-engine >/dev/null 2>&1; then
  sudo -u "$TARGET_USER" XDG_RUNTIME_DIR=/run/user/$TARGET_UID systemctl --user stop lotus-light-engine 2>/dev/null || true
  sudo -u "$TARGET_USER" XDG_RUNTIME_DIR=/run/user/$TARGET_UID systemctl --user disable lotus-light-engine 2>/dev/null || true
  echo "$LOG_PREFIX Stoppade kvarlevande user-service (system-service tar över) ✓"
fi
if sudo systemctl restart lotus-light-engine.service 2>/dev/null; then
  echo "$LOG_PREFIX Engine restarted (system-service) ✓"
else
  echo "$LOG_PREFIX WARN: Could not restart system-service — kontrollera: sudo systemctl status lotus-light-engine"
fi
