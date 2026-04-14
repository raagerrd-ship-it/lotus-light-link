#!/bin/bash
# setup-lotus.sh — Fallback install script for Lotus Light Link
# Called by Pi Control Center: bash /opt/lotus-light/pi/setup-lotus.sh --port 3001 --core 1
#
# This script ONLY installs dependencies and builds the project.
# Systemd services, sandboxing, and port assignment are handled by Pi Control Center.

set -e

# ─── Parse arguments from Pi Control Center ───────────────
PORT=3001
CORE=1
while [[ $# -gt 0 ]]; do
  case $1 in
    --port) PORT="$2"; shift 2 ;;
    --core) CORE="$2"; shift 2 ;;
    *) shift ;;
  esac
done

APP_DIR="/opt/lotus-light"
PI_DIR="$APP_DIR/pi"
SERVICES_JSON="$PI_DIR/services.json"
PORT_OFFSET=$(python3 -c "import json; print(json.load(open('$SERVICES_JSON')).get('portOffset', 50))" 2>/dev/null || echo 50)
ENGINE_PORT=$((PORT + PORT_OFFSET))
TOTAL_CPUS=$(nproc 2>/dev/null || echo 4)

echo ""
echo "========================================"
echo "  Lotus Light Link — Fallback Installer"
echo "========================================"
echo ""
echo "  UI Port:     $PORT"
echo "  Engine Port: $ENGINE_PORT"
echo "  CPU Core:    $CORE (av $TOTAL_CPUS)"

# ─── 1. System dependencies ──────────────────────────────
echo ""
echo "[1/5] Installerar systempaket..."

TOTAL_RAM=$(free -m 2>/dev/null | awk '/^Mem:/{print $2}')
TOTAL_SWAP=$(free -m 2>/dev/null | awk '/^Swap:/{print $2}')
if [ -n "$TOTAL_RAM" ]; then
  echo "  RAM: ${TOTAL_RAM}MB, Swap: ${TOTAL_SWAP:-0}MB"
  if [ "$TOTAL_RAM" -lt 600 ] && [ "${TOTAL_SWAP:-0}" -lt 100 ]; then
    echo "  ⚠️  Lite RAM och ingen swap — rekommenderar minst 256MB swap"
  fi
fi

taskset -c "$CORE" sudo apt-get update -qq
taskset -c "$CORE" sudo apt-get install -y -qq \
  bluez libbluetooth-dev \
  libasound2-dev alsa-utils \
  curl

# ─── 2. Node.js (LTS) ────────────────────────────────────
echo ""
echo "[2/5] Kontrollerar Node.js..."
NODE_MAJOR=$(node -v 2>/dev/null | cut -d. -f1 | tr -d v || echo 0)
if ! command -v node &>/dev/null || [ "$NODE_MAJOR" -lt 20 ]; then
  echo "  Installerar Node.js 22 LTS..."
  curl -fsSL https://deb.nodesource.com/setup_22.x | taskset -c "$CORE" sudo -E bash -
  taskset -c "$CORE" sudo apt-get install -y -qq nodejs
else
  echo "  ✓ Node.js $(node -v) ($(uname -m))"
fi

# ─── 3. I²S audio overlay (INMP441 mic) ──────────────────
echo ""
echo "[3/5] Konfigurerar I²S-ljud..."
NEEDS_REBOOT=false
CONFIG_FILE="/boot/config.txt"
[ -f /boot/firmware/config.txt ] && CONFIG_FILE="/boot/firmware/config.txt"

if ! grep -q "googlevoicehat-soundcard" "$CONFIG_FILE" 2>/dev/null; then
  echo "dtoverlay=googlevoicehat-soundcard" | sudo tee -a "$CONFIG_FILE" > /dev/null
  echo "  I²S overlay tillagd ✓"
  NEEDS_REBOOT=true
else
  echo "  ✓ I²S overlay redan konfigurerad"
fi

# ─── 4. Build web app (if no pre-built dist) ─────────────
echo ""
echo "[4/5] Förbereder webbapp..."

WEB_DIST_READY=false
if [ -f "$APP_DIR/dist/index.html" ] && [ -d "$APP_DIR/dist/assets" ]; then
  WEB_DIST_READY=true
fi

if [ "$WEB_DIST_READY" = true ]; then
  echo "  Förbyggd webbapp hittad i dist/ — hoppar över build ✓"
elif [ -f "$APP_DIR/package.json" ]; then
  cd "$APP_DIR"
  export NODE_OPTIONS="--max-old-space-size=256"
  echo "  Installerar root-beroenden..."
  nice -n 15 taskset -c "$CORE" npm install --no-audit --no-fund
  echo "  Bygger webbgränssnitt..."
  nice -n 15 taskset -c "$CORE" npx vite build
  echo "  Webbapp klar ✓"
else
  echo "  ✗ Ingen förbyggd webbapp och inget package.json i root"
  exit 1
fi

# ─── 5. Build Pi engine ──────────────────────────────────
echo ""
echo "[5/5] Förbereder Pi-backend..."

PI_DIST_READY=false
if [ -f "$PI_DIR/dist/index.js" ]; then
  PI_DIST_READY=true
fi

cd "$PI_DIR"

if [ "$PI_DIST_READY" = true ] && [ -d "$PI_DIR/node_modules" ]; then
  echo "  Förbyggd Pi-backend hittad — hoppar över build ✓"
else
  echo "  Installerar Pi-beroenden..."
  nice -n 15 taskset -c "$CORE" npm install --no-audit --no-fund 2>&1 | tail -3
  echo "  Bygger Pi-backend..."
  nice -n 15 taskset -c "$CORE" npm run build
  nice -n 15 taskset -c "$CORE" npm prune --omit=dev 2>/dev/null || npm prune --production 2>/dev/null || true
  echo "  Bygg klart ✓"
fi

# Rebuild native modules for current architecture
echo "  Bygger om native-moduler för $(uname -m)..."
nice -n 15 taskset -c "$CORE" npm rebuild 2>&1 | tail -5
echo "  Native-moduler klara ✓"

# ─── BLE permissions (hanteras av Pi Control Center) ────────
echo ""
echo "[BLE] Verifierar Bluetooth-tillgång..."

# 1. Säkerställ att Bluetooth inte är blockerat
sudo rfkill unblock bluetooth 2>/dev/null || true
echo "  Bluetooth unblocked ✓"

# 2-4. Kontrollera att Pi Control Center har konfigurerat systemd-tjänsten
# med: NoNewPrivileges=false, AmbientCapabilities=CAP_NET_RAW CAP_NET_ADMIN
# och CapabilityBoundingSet=CAP_NET_RAW CAP_NET_ADMIN
SVC_FILE="/home/pi/.config/systemd/user/lotus-light-engine.service"
if [ -f "$SVC_FILE" ]; then
  echo "  Kontrollerar systemd-tjänstkonfiguration..."
  
  # Kontrollera NoNewPrivileges=false
  if ! grep -q "NoNewPrivileges=false" "$SVC_FILE" 2>/dev/null; then
    echo "  ⚠️  VARNING: NoNewPrivileges=false saknas i $SVC_FILE"
    echo "      noble kräver detta för direkt HCI-åtkomst (bypassar D-Bus/bluez)"
  else
    echo "  NoNewPrivileges=false ✓"
  fi
  
  # Kontrollera AmbientCapabilities
  if ! grep -q "AmbientCapabilities=CAP_NET_RAW CAP_NET_ADMIN" "$SVC_FILE" 2>/dev/null; then
    echo "  ⚠️  VARNING: AmbientCapabilities saknas i $SVC_FILE"
    echo "      noble kräver CAP_NET_RAW och CAP_NET_ADMIN för BLE HCI-åtkomst"
  else
    echo "  AmbientCapabilities=CAP_NET_RAW CAP_NET_ADMIN ✓"
  fi
  
  # Kontrollera CapabilityBoundingSet
  if ! grep -q "CapabilityBoundingSet=CAP_NET_RAW CAP_NET_ADMIN" "$SVC_FILE" 2>/dev/null; then
    echo "  ⚠️  VARNING: CapabilityBoundingSet saknas i $SVC_FILE"
  else
    echo "  CapabilityBoundingSet=CAP_NET_RAW CAP_NET_ADMIN ✓"
  fi
else
  echo "  ℹ️  Systemd-tjänstfil inte hittad — förutsätter att Pi Control Center hanterar detta"
fi

echo ""
echo "========================================"
echo "  Installation klar!"
echo "========================================"
echo ""
echo "  UI Port:     $PORT"
echo "  Engine Port: $ENGINE_PORT"
echo "  CPU Core:    $CORE"
echo ""
echo "  Obs: BLE-rättigheter hanteras av Pi Control Center via systemd."
echo "      Kontrollera att lotus-light-engine.service har:"
echo "        - NoNewPrivileges=false"
echo "        - AmbientCapabilities=CAP_NET_RAW CAP_NET_ADMIN"
echo "        - CapabilityBoundingSet=CAP_NET_RAW CAP_NET_ADMIN"
echo ""

if [ "$NEEDS_REBOOT" = true ]; then
  echo ""
  echo "  ⚠ Omstart krävs (I²S overlay tillagd) — kör: sudo reboot"
fi
echo ""
