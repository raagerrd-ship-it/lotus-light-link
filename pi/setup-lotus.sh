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

# ─── 0. Sudo pre-flight (utbruten till scripts/fix-sudo.sh) ───
# Verifierar och reparerar /etc/sudo.conf, /usr/bin/sudo, /etc/sudoers och
# /etc/sudoers.d/. BLE behöver inte sudo (vi har CAP_NET_RAW/ADMIN via systemd)
# men apt/systemctl/reboot gör det, så vi normaliserar permissions här.
echo ""
echo "[0/5] Sudo pre-flight check..."
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ -f "$SCRIPT_DIR/scripts/fix-sudo.sh" ]; then
  bash "$SCRIPT_DIR/scripts/fix-sudo.sh" || echo "  ⚠ fix-sudo.sh rapporterade problem — fortsätter ändå"
else
  echo "  ⚠ scripts/fix-sudo.sh saknas — hoppar över sudo-check"
fi

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

# ─── 2. Node.js 24 LTS ───────────────────────────────────
# Måste matcha GitHub Actions release-bygget (Node 24 ARM64), annars
# misslyckas native ABI för @stoprocent/noble (state fastnar på "unknown").
echo ""
echo "[2/5] Kontrollerar Node.js (kräver v24+)..."
NODE_MAJOR=$(node -v 2>/dev/null | cut -d. -f1 | tr -d v || echo 0)
if ! command -v node &>/dev/null || [ "$NODE_MAJOR" -lt 24 ]; then
  if command -v node &>/dev/null; then
    echo "  Hittade Node v$(node -v) — uppgraderar till v24 (ABI-match med native noble)..."
    taskset -c "$CORE" sudo apt-get remove -y -qq nodejs 2>/dev/null || true
    sudo rm -f /etc/apt/sources.list.d/nodesource.list /etc/apt/keyrings/nodesource.gpg 2>/dev/null || true
  fi
  echo "  Installerar Node.js 24 LTS..."
  curl -fsSL https://deb.nodesource.com/setup_24.x | taskset -c "$CORE" sudo -E bash -
  taskset -c "$CORE" sudo apt-get install -y -qq nodejs
  echo "  ✓ Node.js $(node -v) installerad"
  # Native moduler måste byggas om mot nya Node-ABI
  if [ -d "$PI_DIR/node_modules" ]; then
    echo "  Bygger om native-moduler mot ny Node-ABI..."
    cd "$PI_DIR" && nice -n 15 taskset -c "$CORE" npm rebuild 2>&1 | tail -5
  fi
else
  echo "  ✓ Node.js $(node -v) ($(uname -m))"
fi

# ─── 3. I²S audio overlay (INMP441 mic) ──────────────────
echo ""
echo "[3/5] Konfigurerar I²S-ljud..."
NEEDS_REBOOT=false
CONFIG_FILE="/boot/config.txt"
[ -f /boot/firmware/config.txt ] && CONFIG_FILE="/boot/firmware/config.txt"

if ! grep -q "^dtparam=i2s=on" "$CONFIG_FILE" 2>/dev/null; then
  echo "dtparam=i2s=on" | sudo tee -a "$CONFIG_FILE" > /dev/null
  echo "  I²S dtparam tillagd ✓"
  NEEDS_REBOOT=true
else
  echo "  ✓ I²S dtparam redan konfigurerad"
fi

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

# ─── BLE permissions ─────────────────────────────────────────
echo ""
echo "[BLE] Verifierar och fixar Bluetooth-tillgång..."

# 1. Säkerställ att Bluetooth inte är blockerat
sudo rfkill unblock bluetooth 2>/dev/null || true
echo "  Bluetooth unblocked ✓"

# 1a. Säkerställ att bluetoothd (BlueZ management daemon) är enabled + igång.
#     Utan denna stannar noble.state på "unknown" för evigt — hci0 UP RUNNING
#     på interface-nivå räcker inte. Se mem://pi/ble/bluetoothd-required.
if ! systemctl is-enabled bluetooth >/dev/null 2>&1; then
  sudo systemctl enable bluetooth >/dev/null 2>&1 \
    && echo "  Aktiverade bluetooth.service vid boot ✓" \
    || echo "  ⚠ Kunde inte enable:a bluetooth.service"
fi
if ! systemctl is-active bluetooth >/dev/null 2>&1; then
  sudo systemctl start bluetooth >/dev/null 2>&1 \
    && echo "  Startade bluetooth.service ✓" \
    || echo "  ⚠ Kunde inte starta bluetooth.service"
else
  echo "  bluetooth.service redan igång ✓"
fi

# 1b. Ge hcitool CAP_NET_RAW så att vår scan-fallback fungerar utan sudo.
#     Noble håller HCI-socketen, men hcitool kan ändå köra LE-scan parallellt
#     när det har caps. Utan detta failar fallbacken med "Operation not permitted".
for SCAN_BIN_NAME in hcitool btmgmt bluetoothctl hciconfig rfkill; do
  SCAN_BIN_PATH="$(command -v "$SCAN_BIN_NAME" 2>/dev/null || true)"
  if [ -z "$SCAN_BIN_PATH" ]; then
    echo "  ⚠ $SCAN_BIN_NAME saknas — installera bluez-paketet"
    continue
  fi
  if ! getcap "$SCAN_BIN_PATH" 2>/dev/null | grep -q "cap_net_raw"; then
    sudo setcap 'cap_net_raw,cap_net_admin+eip' "$SCAN_BIN_PATH" \
      && echo "  Satte CAP_NET_RAW på $SCAN_BIN_NAME ✓" \
      || echo "  ⚠ Kunde inte sätta caps på $SCAN_BIN_NAME"
  else
    echo "  $SCAN_BIN_NAME har redan CAP_NET_RAW ✓"
  fi
done

# 1c. Sätt file capabilities direkt på node-binären.
#     Verifierat: med `sudo node` fungerar noble perfekt (state=poweredOn,
#     discover-events strömmar in). Med systemd AmbientCapabilities fastnar
#     state på "unknown" — Node.js native bindings (@stoprocent/noble) verkar
#     inte alltid plocka upp ambient caps. setcap på själva binären är
#     den robusta lösningen.
NODE_BIN="$(readlink -f "$(command -v node)")"
if [ -n "$NODE_BIN" ] && [ -f "$NODE_BIN" ]; then
  if ! getcap "$NODE_BIN" 2>/dev/null | grep -q "cap_net_raw"; then
    sudo setcap 'cap_net_raw,cap_net_admin+eip' "$NODE_BIN" \
      && echo "  Satte CAP_NET_RAW på node ($NODE_BIN) ✓" \
      || echo "  ⚠ Kunde inte sätta caps på node"
  else
    echo "  node har redan CAP_NET_RAW ✓"
  fi
else
  echo "  ⚠ node-binär hittades inte"
fi

# 1d. Lägg till user i bluetooth+netdev-grupperna.
#     CAP_NET_ADMIN på rfkill-binären räcker inte för att öppna /dev/rfkill —
#     enheten kräver gruppmedlemskap (netdev). Utan detta failar `rfkill unblock`
#     med "Permission denied" trots korrekta caps. bluetooth-gruppen behövs för
#     BlueZ D-Bus-anrop. Kräver logout/reboot för att aktiveras i sessionen.
TARGET_USER="${SUDO_USER:-$USER}"
if [ -n "$TARGET_USER" ] && [ "$TARGET_USER" != "root" ]; then
  ADDED_GROUPS=()
  for GRP in bluetooth netdev; do
    if getent group "$GRP" >/dev/null 2>&1; then
      if ! id -nG "$TARGET_USER" 2>/dev/null | tr ' ' '\n' | grep -qx "$GRP"; then
        sudo usermod -aG "$GRP" "$TARGET_USER" \
          && ADDED_GROUPS+=("$GRP") \
          && echo "  Lade $TARGET_USER i $GRP ✓" \
          || echo "  ⚠ Kunde inte lägga $TARGET_USER i $GRP"
      else
        echo "  $TARGET_USER redan i $GRP ✓"
      fi
    fi
  done
  if [ ${#ADDED_GROUPS[@]} -gt 0 ]; then
    echo "  ⚠ Logga ut och in (eller reboot) för att gruppändringarna ska aktiveras"
    BLE_NEEDS_RELOGIN=true
  fi
fi

# 2-4. Auto-fixa systemd-tjänsten om capabilities eller startup-order saknas
SVC_FILE="$HOME/.config/systemd/user/lotus-light-engine.service"
BLE_FIXED=false

if [ -f "$SVC_FILE" ]; then
  SVC_CONTENT=$(cat "$SVC_FILE")

  # User-services kan inte depend:a på system-units som bluetooth.service.
  # Vänta istället kort innan start så HCI hinner bli redo.
  sed -i '/^After=.*bluetooth\.service/d' "$SVC_FILE"
  sed -i '/^Requires=.*bluetooth\.service/d' "$SVC_FILE"

  if echo "$SVC_CONTENT" | grep -Eq '^After=.*(^|[[:space:]])bluetooth\.service($|[[:space:]])'; then
    echo "  Tog bort ogiltig After=bluetooth.service för user-service ✓"
    BLE_FIXED=true
  fi

  if echo "$SVC_CONTENT" | grep -Eq '^Requires=.*(^|[[:space:]])bluetooth\.service($|[[:space:]])'; then
    echo "  Tog bort ogiltig Requires=bluetooth.service för user-service ✓"
    BLE_FIXED=true
  fi

  # Ge bluetoothd/HCI lite tid att bli redo innan node-processen startar
  if ! grep -q '^ExecStartPre=/bin/sleep 2$' "$SVC_FILE"; then
    sed -i '/^ExecStartPre=\/bin\/sleep 2$/d' "$SVC_FILE"
    if grep -q '^\[Service\]' "$SVC_FILE"; then
      sed -i '/^\[Service\]/a ExecStartPre=/bin/sleep 2' "$SVC_FILE"
    else
      printf '\n[Service]\nExecStartPre=/bin/sleep 2\n' >> "$SVC_FILE"
    fi
    echo "  Lade till ExecStartPre=/bin/sleep 2 ✓"
    BLE_FIXED=true
  else
    echo "  ExecStartPre=/bin/sleep 2 ✓"
  fi

  # NoNewPrivileges=false (krävs för AmbientCapabilities)
  if echo "$SVC_CONTENT" | grep -q "NoNewPrivileges=true"; then
    sed -i 's/NoNewPrivileges=true/NoNewPrivileges=false/' "$SVC_FILE"
    echo "  Fixade NoNewPrivileges=false ✓"
    BLE_FIXED=true
  elif ! echo "$SVC_CONTENT" | grep -q "NoNewPrivileges="; then
    if grep -q '^ExecStartPre=/bin/sleep 2$' "$SVC_FILE"; then
      sed -i '/^ExecStartPre=\/bin\/sleep 2$/a NoNewPrivileges=false' "$SVC_FILE"
    elif echo "$SVC_CONTENT" | grep -q "PrivateTmp="; then
      sed -i '/PrivateTmp=/a NoNewPrivileges=false' "$SVC_FILE"
    else
      sed -i '/^\[Service\]/a NoNewPrivileges=false' "$SVC_FILE"
    fi
    echo "  Lade till NoNewPrivileges=false ✓"
    BLE_FIXED=true
  else
    echo "  NoNewPrivileges=false ✓"
  fi

  # AmbientCapabilities
  if ! grep -q "AmbientCapabilities=CAP_NET_RAW CAP_NET_ADMIN" "$SVC_FILE"; then
    sed -i '/^AmbientCapabilities=/d' "$SVC_FILE"
    sed -i '/NoNewPrivileges=/a AmbientCapabilities=CAP_NET_RAW CAP_NET_ADMIN' "$SVC_FILE"
    echo "  Lade till AmbientCapabilities ✓"
    BLE_FIXED=true
  else
    echo "  AmbientCapabilities=CAP_NET_RAW CAP_NET_ADMIN ✓"
  fi

  # CapabilityBoundingSet
  if ! grep -q "CapabilityBoundingSet=CAP_NET_RAW CAP_NET_ADMIN" "$SVC_FILE"; then
    sed -i '/^CapabilityBoundingSet=/d' "$SVC_FILE"
    sed -i '/AmbientCapabilities=/a CapabilityBoundingSet=CAP_NET_RAW CAP_NET_ADMIN' "$SVC_FILE"
    echo "  Lade till CapabilityBoundingSet ✓"
    BLE_FIXED=true
  else
    echo "  CapabilityBoundingSet=CAP_NET_RAW CAP_NET_ADMIN ✓"
  fi

  # SupplementaryGroups — systemd-user-services ärver INTE login-grupper.
  # Utan detta: /dev/rfkill = "Permission denied" i tjänsten trots
  # att pi-användaren är med i netdev. Måste sättas explicit här.
  if ! grep -q "^SupplementaryGroups=.*netdev" "$SVC_FILE" || ! grep -q "^SupplementaryGroups=.*bluetooth" "$SVC_FILE"; then
    sed -i '/^SupplementaryGroups=/d' "$SVC_FILE"
    sed -i '/CapabilityBoundingSet=/a SupplementaryGroups=netdev bluetooth' "$SVC_FILE"
    echo "  Lade till SupplementaryGroups=netdev bluetooth ✓"
    BLE_FIXED=true
  else
    echo "  SupplementaryGroups=netdev bluetooth ✓"
  fi

  # MemoryMax — PCC sätter default 27M vilket OOM-killar Node + noble + alsa.
  # Höj till 150M (Pi Zero 2W har 512MB RAM, gott om plats).
  if grep -qE "^MemoryMax=" "$SVC_FILE"; then
    CURRENT_MEM=$(grep -E "^MemoryMax=" "$SVC_FILE" | head -1 | cut -d= -f2)
    if [ "$CURRENT_MEM" != "150M" ]; then
      sed -i 's/^MemoryMax=.*/MemoryMax=150M/' "$SVC_FILE"
      echo "  Höjde MemoryMax från $CURRENT_MEM till 150M ✓"
      BLE_FIXED=true
    else
      echo "  MemoryMax=150M ✓"
    fi
  else
    sed -i '/^\[Service\]/a MemoryMax=150M' "$SVC_FILE"
    echo "  Lade till MemoryMax=150M ✓"
    BLE_FIXED=true
  fi

  # Ladda om och starta om tjänsten om vi ändrade något
  if [ "$BLE_FIXED" = true ]; then
    echo "  Laddar om systemd och startar om tjänsten..."
    systemctl --user daemon-reload 2>/dev/null || true
    systemctl --user restart lotus-light-engine 2>/dev/null || true
    echo "  Tjänsten omstartad med BLE-startordning + rättigheter ✓"
  fi
else
  echo "  ℹ️  Systemd-tjänstfil inte hittad — förutsätter att Pi Control Center skapar den"
fi

# ─── Done ─────────────────────────────────────────────────
echo ""
echo "========================================"
echo "  Installation klar!"
echo "========================================"
echo ""
echo "  UI Port:     $PORT"
echo "  Engine Port: $ENGINE_PORT"
echo "  CPU Core:    $CORE"
echo ""

if [ "$NEEDS_REBOOT" = true ]; then
  echo "  ⚠ Omstart krävs (I²S overlay tillagd) — kör: sudo reboot"
  echo ""
fi
