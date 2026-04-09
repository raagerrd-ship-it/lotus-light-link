#!/bin/bash
# setup-lotus.sh — Install Lotus Light Link on Raspberry Pi Zero 2 W
# Called by Pi Dashboard: bash /opt/lotus-light/pi/setup-lotus.sh --port 3001 --core 1
# The dashboard clones the repo to /opt/lotus-light before running this script.

set -e

# ─── Parse arguments from Pi Dashboard ───────────────────
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
HOSTNAME_TARGET="lotus"
SERVICE_NAME="lotus-light"
TOTAL_CPUS=$(nproc 2>/dev/null || echo 4)

echo ""
echo "========================================"
echo "  Lotus Light Link Installer"
echo "========================================"
echo ""
echo "  Port: $PORT"
echo "  CPU:  Kärna $CORE (av $TOTAL_CPUS)"

# ─── Refuse to run as root ───────────────────────────────
if [ "$EUID" -eq 0 ]; then
  echo "❌ Kör inte detta script som root!"
  echo "   Använd: ./setup-lotus.sh"
  exit 1
fi

# ─── 1. System dependencies ──────────────────────────────
echo "[1/8] Installerar systempaket..."

# Check RAM
TOTAL_RAM=$(free -m 2>/dev/null | awk '/^Mem:/{print $2}')
TOTAL_SWAP=$(free -m 2>/dev/null | awk '/^Swap:/{print $2}')
if [ -n "$TOTAL_RAM" ]; then
  echo "  RAM: ${TOTAL_RAM}MB, Swap: ${TOTAL_SWAP:-0}MB"
  if [ "$TOTAL_RAM" -lt 600 ] && [ "${TOTAL_SWAP:-0}" -lt 100 ]; then
    echo "  ⚠️  Lite RAM och ingen swap — rekommenderar minst 256MB swap"
  fi
fi

sudo apt-get update -qq
sudo apt-get install -y -qq \
  bluez libbluetooth-dev \
  libasound2-dev alsa-utils \
  curl

# ─── 2. Node.js 20 ───────────────────────────────────────
echo "[2/8] Kontrollerar Node.js..."
if ! command -v node &>/dev/null || [[ $(node -v | cut -d. -f1 | tr -d v) -lt 20 ]]; then
  echo "  Installerar Node.js 20..."
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
  sudo apt-get install -y -qq nodejs
else
  echo "  ✓ Node.js $(node -v) ($(uname -m))"
fi

# ─── 3. I²S audio overlay (INMP441 mic) ──────────────────
echo "[3/8] Konfigurerar I²S-ljud..."
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

# ─── 4. Hostname ─────────────────────────────────────────
echo "[4/8] Kontrollerar hostname..."
CURRENT_HOSTNAME=$(hostname)
if [ "$CURRENT_HOSTNAME" != "$HOSTNAME_TARGET" ]; then
  sudo hostnamectl set-hostname "$HOSTNAME_TARGET"
  echo "  Hostname satt till ${HOSTNAME_TARGET}.local ✓"
else
  echo "  ✓ Hostname redan ${HOSTNAME_TARGET}.local"
fi

# ─── 5. Install npm dependencies ─────────────────────────
echo "[5/8] Installerar npm-beroenden..."
cd "$PI_DIR"
export NODE_OPTIONS="--max-old-space-size=256"
nice -n 15 npm install --no-audit --no-fund 2>&1 | tail -3

# ─── 6. Build Pi runtime ─────────────────────────────────
echo "[6/8] Bygger..."
nice -n 15 npm run build
npm prune --omit=dev 2>/dev/null || npm prune --production 2>/dev/null || true
echo "  Bygg klart ✓"

# ─── 7. BLE permissions & sudoers ─────────────────────────
echo "[7/8] Sätter BLE-behörigheter och sudoers..."
NODE_BIN=$(readlink -f "$(which node)")
sudo setcap cap_net_raw+eip "$NODE_BIN" 2>/dev/null || true
chmod +x "$PI_DIR/update-services.sh" 2>/dev/null || true
chmod +x "$PI_DIR/uninstall-lotus.sh" 2>/dev/null || true

# Passwordless sudo for setcap and systemctl (used by auto-updater)
SUDOERS_FILE="/etc/sudoers.d/lotus-light"
sudo tee "$SUDOERS_FILE" > /dev/null << SUDOEOF
# Lotus Light Link — allow pi user to manage BLE caps and service without password
${USER} ALL=(root) NOPASSWD: /usr/sbin/setcap cap_net_raw+eip *
${USER} ALL=(root) NOPASSWD: /bin/systemctl restart ${SERVICE_NAME}
${USER} ALL=(root) NOPASSWD: /bin/systemctl stop ${SERVICE_NAME}
${USER} ALL=(root) NOPASSWD: /bin/systemctl start ${SERVICE_NAME}
SUDOEOF
sudo chmod 0440 "$SUDOERS_FILE"
echo "  ✓ sudoers-regel skapad"

# ─── 8. Validate core arg ────────────────────────────────
if ! [[ "$CORE" =~ ^[0-3]$ ]]; then
  echo "  Ogiltigt core '$CORE', använder standard: 1"
  CORE=1
fi

# ─── 9. User-level systemd services ─────────────────────
echo "[8/8] Skapar systemd-tjänster..."
mkdir -p "$HOME/.config/systemd/user"

# Main service
cat > "$HOME/.config/systemd/user/${SERVICE_NAME}.service" << EOF
[Unit]
Description=Lotus Light Link — Audio-reactive BLE LED controller
After=network.target bluetooth.target
Wants=bluetooth.target

[Service]
Type=simple
WorkingDirectory=${PI_DIR}
ExecStart=$(which node) --max-old-space-size=128 dist/index.js
Restart=always
RestartSec=5
Environment=NODE_ENV=production
Environment=CONFIG_PORT=${PORT}
Environment=TICK_MS=30

# Resource limits & CPU pinning
MemoryMax=128M
AllowedCPUs=${CORE}
CPUQuota=100%
Nice=-5

[Install]
WantedBy=default.target
EOF

# Auto-update service + timer
cat > "$HOME/.config/systemd/user/${SERVICE_NAME}-update.service" << EOF
[Unit]
Description=Lotus Light Link — Auto-update from GitHub

[Service]
Type=oneshot
ExecStart=${PI_DIR}/update-services.sh
Environment=HOME=$HOME
Environment=PATH=/usr/local/bin:/usr/bin:/bin
EOF

cat > "$HOME/.config/systemd/user/${SERVICE_NAME}-update.timer" << EOF
[Unit]
Description=Lotus Light Link — Auto-update timer (every 5 min)

[Timer]
OnBootSec=2min
OnUnitActiveSec=5min
Persistent=true

[Install]
WantedBy=timers.target
EOF

# Nightly restart for stability (05:00)
cat > "$HOME/.config/systemd/user/${SERVICE_NAME}-restart.service" << EOF
[Unit]
Description=Restart Lotus Light Link

[Service]
Type=oneshot
ExecStart=/bin/systemctl --user restart ${SERVICE_NAME}
EOF

cat > "$HOME/.config/systemd/user/${SERVICE_NAME}-restart.timer" << EOF
[Unit]
Description=Nightly restart of Lotus Light Link

[Timer]
OnCalendar=*-*-* 05:00:00
Persistent=true

[Install]
WantedBy=timers.target
EOF

# Enable linger so user services survive logout
loginctl enable-linger "$USER" 2>/dev/null || true

systemctl --user daemon-reload
systemctl --user enable "$SERVICE_NAME"
systemctl --user enable "${SERVICE_NAME}-update.timer"
systemctl --user enable "${SERVICE_NAME}-restart.timer"

# Start everything
systemctl --user start "${SERVICE_NAME}-update.timer"
systemctl --user start "${SERVICE_NAME}-restart.timer"
systemctl --user start "$SERVICE_NAME"

echo "  ✓ Tjänster skapade och startade"

# ─── Done ─────────────────────────────────────────────────
IP_ADDR=$(hostname -I 2>/dev/null | awk '{print $1}')

echo ""
echo "========================================"
echo "  Installation klar!"
echo "========================================"
echo ""
echo "  Port: ${PORT}, CPU core: ${CORE}"
echo "  Config: http://${IP_ADDR:-lotus.local}:${PORT}"
echo ""
echo "  Schema:"
echo "    Var 5:e min  Auto-update (git pull + restart om ändringar)"
echo "    05:00        Nattlig omstart"
echo ""
echo "  Kommandon:"
echo "    Status:  systemctl --user status ${SERVICE_NAME}"
echo "    Loggar:  journalctl --user -u ${SERVICE_NAME} -f"
echo "    Stoppa:  systemctl --user stop ${SERVICE_NAME}"
echo "    Starta:  systemctl --user start ${SERVICE_NAME}"

if [ "$NEEDS_REBOOT" = true ]; then
  echo ""
  echo "  ⚠ Omstart krävs (I²S overlay tillagd) — kör: sudo reboot"
fi
echo ""
