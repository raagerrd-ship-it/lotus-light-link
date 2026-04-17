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

# ─── 0. Reparera sudo om /etc/sudo.conf har fel ägare ─────
# Vissa Pi-images (eller manuella chown -R) lämnar /etc/sudo.conf ägd av
# en vanlig användare, vilket gör att sudo tyst vägrar köra ("sudo: ...
# must be owned by uid 0"). Vi har caps via systemd så BLE funkar utan
# sudo, men andra verktyg på Pi:n (apt, systemctl, reboot) behöver det.
# Reparera utan sudo via pkexec/su om vi inte redan är root.
echo ""
echo "[0/5] Verifierar /etc/sudo.conf..."
SUDO_CONF_FIX_NEEDED=false
if [ -f /etc/sudo.conf ]; then
  OWNER=$(stat -c '%U:%G' /etc/sudo.conf 2>/dev/null || echo "?")
  PERMS=$(stat -c '%a' /etc/sudo.conf 2>/dev/null || echo "?")
  if [ "$OWNER" != "root:root" ] || [ "$PERMS" != "644" ]; then
    echo "  ⚠ /etc/sudo.conf har fel ägarskap/permissions: $OWNER ($PERMS) — försöker reparera"
    SUDO_CONF_FIX_NEEDED=true
    if [ "$(id -u)" = "0" ]; then
      chown root:root /etc/sudo.conf && chmod 644 /etc/sudo.conf && echo "  ✓ Fixade /etc/sudo.conf som root"
    elif command -v pkexec >/dev/null 2>&1; then
      pkexec sh -c 'chown root:root /etc/sudo.conf && chmod 644 /etc/sudo.conf' \
        && echo "  ✓ Fixade /etc/sudo.conf via pkexec" \
        || echo "  ✗ pkexec misslyckades — kör manuellt: su -c 'chown root:root /etc/sudo.conf && chmod 644 /etc/sudo.conf'"
    else
      echo "  ✗ Kan inte reparera (kör inte som root och saknar pkexec)"
      echo "    Kör manuellt: su -c 'chown root:root /etc/sudo.conf && chmod 644 /etc/sudo.conf'"
    fi
    # Verifiera resultatet
    NEW_OWNER=$(stat -c '%U:%G' /etc/sudo.conf 2>/dev/null || echo "?")
    NEW_PERMS=$(stat -c '%a' /etc/sudo.conf 2>/dev/null || echo "?")
    if [ "$NEW_OWNER" = "root:root" ] && [ "$NEW_PERMS" = "644" ]; then
      echo "  ✓ /etc/sudo.conf nu korrekt: root:root (644)"
      SUDO_CONF_FIX_NEEDED=false
    fi
  else
    echo "  ✓ /etc/sudo.conf OK (root:root, 644)"
  fi
else
  echo "  ℹ /etc/sudo.conf saknas — sudo använder kompilerade defaults (OK)"
fi

# Verifiera /usr/bin/sudo setuid-bit (måste vara 4755 root:root för att eskalera till root)
SUDO_BIN=$(command -v sudo 2>/dev/null || echo /usr/bin/sudo)
if [ -f "$SUDO_BIN" ]; then
  SUDO_OWNER=$(stat -c '%U:%G' "$SUDO_BIN" 2>/dev/null || echo "?")
  SUDO_MODE=$(stat -c '%a' "$SUDO_BIN" 2>/dev/null || echo "?")
  if [ "$SUDO_OWNER" != "root:root" ] || [ "$SUDO_MODE" != "4755" ]; then
    echo "  ⚠ $SUDO_BIN har fel ägare/mode: $SUDO_OWNER ($SUDO_MODE) — försöker reparera (förväntat: root:root 4755)"
    SUDO_CONF_FIX_NEEDED=true
    if [ "$(id -u)" = "0" ]; then
      chown root:root "$SUDO_BIN" && chmod 4755 "$SUDO_BIN" && echo "  ✓ Fixade $SUDO_BIN som root"
    elif command -v pkexec >/dev/null 2>&1; then
      pkexec sh -c "chown root:root '$SUDO_BIN' && chmod 4755 '$SUDO_BIN'" \
        && echo "  ✓ Fixade $SUDO_BIN via pkexec" \
        || echo "  ✗ pkexec misslyckades — kör manuellt: su -c \"chown root:root $SUDO_BIN && chmod 4755 $SUDO_BIN\""
    else
      echo "  ✗ Kan inte reparera (kör inte som root och saknar pkexec)"
      echo "    Kör manuellt: su -c \"chown root:root $SUDO_BIN && chmod 4755 $SUDO_BIN\""
    fi
    NEW_SUDO_OWNER=$(stat -c '%U:%G' "$SUDO_BIN" 2>/dev/null || echo "?")
    NEW_SUDO_MODE=$(stat -c '%a' "$SUDO_BIN" 2>/dev/null || echo "?")
    if [ "$NEW_SUDO_OWNER" = "root:root" ] && [ "$NEW_SUDO_MODE" = "4755" ]; then
      echo "  ✓ $SUDO_BIN nu korrekt: root:root (4755)"
      SUDO_CONF_FIX_NEEDED=false
    fi
  else
    echo "  ✓ $SUDO_BIN OK (root:root, 4755)"
  fi
else
  echo "  ⚠ sudo-binären hittas inte ($SUDO_BIN) — installera med: apt install sudo"
fi

# Snabbtest: går sudo att köra alls?
if ! sudo -n true 2>/dev/null && ! sudo -v 2>/dev/null; then
  if [ "$SUDO_CONF_FIX_NEEDED" = true ]; then
    echo "  ⚠ sudo verkar trasigt — fortsätter ändå (BLE behöver inte sudo tack vare CAP_NET_RAW/ADMIN)"
  fi
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

# ─── BLE permissions ─────────────────────────────────────────
echo ""
echo "[BLE] Verifierar och fixar Bluetooth-tillgång..."

# 1. Säkerställ att Bluetooth inte är blockerat
sudo rfkill unblock bluetooth 2>/dev/null || true
echo "  Bluetooth unblocked ✓"

# 2-4. Auto-fixa systemd-tjänsten om capabilities saknas
SVC_FILE="$HOME/.config/systemd/user/lotus-light-engine.service"
BLE_FIXED=false

if [ -f "$SVC_FILE" ]; then
  SVC_CONTENT=$(cat "$SVC_FILE")

  # NoNewPrivileges=false (krävs för AmbientCapabilities)
  if echo "$SVC_CONTENT" | grep -q "NoNewPrivileges=true"; then
    sed -i 's/NoNewPrivileges=true/NoNewPrivileges=false/' "$SVC_FILE"
    echo "  Fixade NoNewPrivileges=false ✓"
    BLE_FIXED=true
  elif ! echo "$SVC_CONTENT" | grep -q "NoNewPrivileges="; then
    # Lägg till efter [Service] eller efter sista Environment=
    if echo "$SVC_CONTENT" | grep -q "PrivateTmp="; then
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
    # Ta bort eventuell gammal rad
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

  # Ladda om och starta om tjänsten om vi ändrade något
  if [ "$BLE_FIXED" = true ]; then
    echo "  Laddar om systemd och startar om tjänsten..."
    systemctl --user daemon-reload 2>/dev/null || true
    systemctl --user restart lotus-light-engine 2>/dev/null || true
    echo "  Tjänsten omstartad med BLE-rättigheter ✓"
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
