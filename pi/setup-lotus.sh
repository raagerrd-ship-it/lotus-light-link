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
# Python 3.11+ behövs för alsa-capture native build, men ENDAST om vi tvingas
# använda paketets bundlade node-gyp 9.x. Vår strategi är att uppgradera node-gyp
# till v10+ globalt, vilket fungerar med Python 3.13 (default på Bookworm).
# Vi installerar python3.11 om det finns i repo:t som extra säkerhet, men
# faller tillbaka utan om paketet saknas.
taskset -c "$CORE" sudo apt-get install -y -qq \
  bluez libbluetooth-dev \
  libasound2-dev alsa-utils \
  build-essential python3 python3-dev \
  curl
# Försök python3.11 separat (saknas i vissa repos — t.ex. Debian Trixie/13)
taskset -c "$CORE" sudo apt-get install -y -qq python3.11 python3.11-dev 2>/dev/null || \
  echo "  ℹ python3.11 saknas i apt — använder global node-gyp 10+ istället"

# Auto-detektera python <3.12 om den finns. Annars använder vi systemets python3
# tillsammans med uppgraderad node-gyp 10+.
GYP_PYTHON=""
for CAND in python3.11 python3.10 python3.9; do
  if command -v "$CAND" >/dev/null 2>&1; then
    GYP_PYTHON="$(command -v "$CAND")"
    echo "  ✓ Hittade $CAND ($GYP_PYTHON) — använder den för native builds"
    break
  fi
done
if [ -z "$GYP_PYTHON" ]; then
  GYP_PYTHON="$(command -v python3 || true)"
  echo "  ℹ Ingen python <3.12 hittad — använder systemets $(python3 --version 2>/dev/null) + node-gyp 10+"
fi

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

# ─── Native alsa-capture (vendored fork) ──────────────────
# Primärt byggs detta i CI (ARM64-runner = matchande aarch64-binär ingår i tarball).
# Här verifierar vi bara att capture.node finns. Om CI-bygget saknas eller
# misslyckas faller vi tillbaka på lokal build via global node-gyp@10.
echo ""
echo "[ALSA] Verifierar native alsa-capture..."

VENDOR_DIR="$PI_DIR/vendor/alsa-capture"
ALSA_NODE_FILE="$VENDOR_DIR/build/Release/capture.node"

if [ ! -d "$VENDOR_DIR" ]; then
  echo "  ✗ $VENDOR_DIR saknas — engine kommer falla tillbaka på arecord"
elif [ -f "$ALSA_NODE_FILE" ]; then
  ALSA_NODE_SIZE=$(stat -c%s "$ALSA_NODE_FILE" 2>/dev/null || echo 0)
  echo "  ✓ capture.node finns från CI-bygge (${ALSA_NODE_SIZE} bytes)"
  # Verifiera att binären faktiskt går att ladda mot installerad Node
  if ! taskset -c "$CORE" node -e "require('$VENDOR_DIR/index.js')" 2>/tmp/alsa-load-test.err; then
    echo "  ⚠ capture.node kunde inte laddas — bygger om lokalt"
    echo "    Fel: $(tail -3 /tmp/alsa-load-test.err)"
    rm -f "$ALSA_NODE_FILE"
  fi
fi

if [ ! -f "$ALSA_NODE_FILE" ] && [ -d "$VENDOR_DIR" ]; then
  # Fallback: lokal build. Kräver node-gyp — installera globalt om saknas.
  echo "  Installerar global node-gyp@10 för fallback-build..."
  if ! command -v node-gyp >/dev/null 2>&1; then
    sudo npm install -g node-gyp@10 --no-audit --no-fund 2>&1 | tail -3 || true
  fi
  GYP_BIN="$(command -v node-gyp || true)"
  if [ -z "$GYP_BIN" ]; then
    echo "  ✗ node-gyp kunde inte installeras — engine använder arecord-fallback"
  else
    echo "  Installerar vendor-deps (node-addon-api, eventemitter3)..."
    (cd "$VENDOR_DIR" && nice -n 15 taskset -c "$CORE" \
      npm install --no-audit --no-fund --ignore-scripts --no-save 2>&1 | tail -3)

    echo "  Bygger capture.node lokalt (${GYP_BIN}, Python: ${GYP_PYTHON:-$(command -v python3)})..."
    ALSA_BUILD_LOG="/tmp/alsa-capture-build.log"
    (
      cd "$VENDOR_DIR" && \
      ${GYP_PYTHON:+PYTHON=$GYP_PYTHON} \
      ${GYP_PYTHON:+npm_config_python=$GYP_PYTHON} \
      nice -n 15 taskset -c "$CORE" \
        "$GYP_BIN" rebuild --release
    ) > "$ALSA_BUILD_LOG" 2>&1 || true

    if [ -f "$ALSA_NODE_FILE" ]; then
      echo "  ✓ Native alsa-capture byggd lokalt ($(stat -c%s "$ALSA_NODE_FILE") bytes)"
    else
      echo "  ✗ Lokal build failade — engine använder arecord-fallback"
      echo "    Sista 25 raderna ur $ALSA_BUILD_LOG:"
      tail -25 "$ALSA_BUILD_LOG" | sed 's/^/      /'
    fi
  fi
fi

# Installera vendor/node_modules (eventemitter3) om de saknas — krävs för require
if [ -f "$ALSA_NODE_FILE" ] && [ ! -d "$VENDOR_DIR/node_modules/eventemitter3" ]; then
  echo "  Installerar vendor runtime-deps (eventemitter3)..."
  (cd "$VENDOR_DIR" && nice -n 15 taskset -c "$CORE" \
    npm install --no-audit --no-fund --ignore-scripts --no-save eventemitter3@^4.0.7 2>&1 | tail -3)
fi

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

# ─── Engine system-service (ersätter PCC:s user-service) ─────────────
# RATIONALE (2026-04-19): PCC skapar lotus-light-engine som --user-service.
# User-services i systemd kan INTE ärva login-användarens supplementary groups
# (netdev, bluetooth) på Raspberry Pi OS. Konsekvens: rfkill + hci0 = "Permission
# denied" → noble fastnar i state=unknown → UI:t kan inte starta motorn.
#
# Lösning: Skapa en parallell SYSTEM-service med User=pi och korrekta
# SupplementaryGroups. System-services KAN sätta SupplementaryGroups (kräver
# bara systemd PID 1, vilket de har). Vi disablar PCC:s user-service så
# de inte konflitar om porten.
SYS_SVC_PATH="/etc/systemd/system/lotus-light-engine.service"
# Hitta target-user's home (setup körs ofta via sudo → $HOME = /root)
TARGET_HOME="$(getent passwd "$TARGET_USER" | cut -d: -f6)"
USER_SVC_PATH="$TARGET_HOME/.config/systemd/user/lotus-light-engine.service"
TARGET_UID="$(id -u "$TARGET_USER")"
run_user_systemctl() {
  sudo -u "$TARGET_USER" env XDG_RUNTIME_DIR="/run/user/$TARGET_UID" systemctl --user "$@"
}

echo ""
echo "[BLE-fix] Installerar system-service (ersätter user-service)..."

# 1. Rensa GAMMAL user-service från tidigare versioner (idempotent, alltid)
#    Vi kör som target-user via systemctl --user med rätt XDG_RUNTIME_DIR,
#    annars hittar systemctl inte user-bus från sudo-kontext.
run_user_systemctl stop lotus-light-engine 2>/dev/null || true
run_user_systemctl disable lotus-light-engine 2>/dev/null || true
if [ -f "$USER_SVC_PATH" ]; then
  rm -f "$USER_SVC_PATH"
  run_user_systemctl daemon-reload 2>/dev/null || true
  echo "  Gammal user-service raderad ($USER_SVC_PATH) ✓"
fi

# 2. Döda kvarlevande ENGINE-processer via explicita PID:ar.
#    Matcha bara node-processer som kör exakt vår engine-entry.
ENGINE_PIDS="$(pgrep -f "node .*${PI_DIR}/dist/index.js" 2>/dev/null || true)"
if [ -n "$ENGINE_PIDS" ]; then
  echo "  Dödar kvarlevande engine-PID:ar: $(echo "$ENGINE_PIDS" | tr '\n' ' ')"
  echo "$ENGINE_PIDS" | xargs -r sudo kill -TERM 2>/dev/null || true
  sleep 1
  REMAINING_ENGINE_PIDS="$(pgrep -f "node .*${PI_DIR}/dist/index.js" 2>/dev/null || true)"
  if [ -n "$REMAINING_ENGINE_PIDS" ]; then
    echo "$REMAINING_ENGINE_PIDS" | xargs -r sudo kill -KILL 2>/dev/null || true
  fi
  echo "  Kvarlevande engine-processer dödade ✓"
fi

# 3. Skriv ny system-service (idempotent — overwrite varje release)
TARGET_GROUP="$(id -gn "$TARGET_USER" 2>/dev/null || echo "$TARGET_USER")"
echo "  Service kommer köra som: User=$TARGET_USER, Group=$TARGET_GROUP, SupplementaryGroups=netdev bluetooth"
sudo tee "$SYS_SVC_PATH" >/dev/null <<EOF
[Unit]
Description=Lotus Light Link engine
After=network.target bluetooth.service
Wants=bluetooth.service

[Service]
Type=simple
User=$TARGET_USER
Group=$TARGET_GROUP
SupplementaryGroups=netdev bluetooth
WorkingDirectory=$PI_DIR
ExecStartPre=/bin/sleep 2
ExecStart=/usr/bin/node $PI_DIR/dist/index.js
Environment=NPM_CONFIG_CACHE=$APP_DIR/.npm-cache
Environment=PORT=$ENGINE_PORT
Environment=ENGINE_PORT=$ENGINE_PORT
Environment=UI_PORT=$PORT
Environment=DBUS_SYSTEM_BUS_ADDRESS=unix:path=/run/dbus/system_bus_socket
CPUAffinity=$CORE
AllowedCPUs=$CORE
MemoryMax=200M
NoNewPrivileges=false
AmbientCapabilities=CAP_NET_RAW CAP_NET_ADMIN CAP_SYS_NICE
CapabilityBoundingSet=CAP_NET_RAW CAP_NET_ADMIN CAP_SYS_NICE
# Realtime-prio för ALSA capture-tråden (SCHED_FIFO 80) → minimal jitter
LimitRTPRIO=99
LimitNICE=-20
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF
echo "  System-service skriven till $SYS_SVC_PATH ✓"

# 4. Aktivera + starta
sudo systemctl daemon-reload
sudo systemctl enable lotus-light-engine 2>/dev/null || true
sudo systemctl restart lotus-light-engine
echo "  System-service aktiverad och startad ✓"
echo "  → Verifiera: sudo systemctl status lotus-light-engine"
echo "  → Loggar: sudo journalctl -u lotus-light-engine -f"

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
