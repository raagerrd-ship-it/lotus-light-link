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

# ─── 1. System dependencies ──────────────────────────────
echo "Installerar systempaket..."
sudo apt-get update -qq
sudo apt-get install -y -qq \
  bluez libbluetooth-dev \
  libasound2-dev alsa-utils \
  curl

# ─── 2. Node.js 20 ───────────────────────────────────────
if ! command -v node &>/dev/null || [[ $(node -v | cut -d. -f1 | tr -d v) -lt 20 ]]; then
  echo "Installerar Node.js 20..."
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo bash -
  sudo apt-get install -y -qq nodejs
else
  echo "Node.js $(node -v) redan installerad ✓"
fi

# ─── 3. I²S audio overlay (INMP441 mic) ──────────────────
echo "Konfigurerar I²S-ljud..."
NEEDS_REBOOT=false
CONFIG_FILE="/boot/config.txt"
[ -f /boot/firmware/config.txt ] && CONFIG_FILE="/boot/firmware/config.txt"

if ! grep -q "googlevoicehat-soundcard" "$CONFIG_FILE" 2>/dev/null; then
  echo "dtoverlay=googlevoicehat-soundcard" | sudo tee -a "$CONFIG_FILE" > /dev/null
  echo "  I²S overlay tillagd ✓"
  NEEDS_REBOOT=true
else
  echo "  I²S overlay redan konfigurerad ✓"
fi

# ─── 4. Hostname ─────────────────────────────────────────
CURRENT_HOSTNAME=$(hostname)
if [ "$CURRENT_HOSTNAME" != "$HOSTNAME_TARGET" ]; then
  sudo hostnamectl set-hostname "$HOSTNAME_TARGET"
  echo "Hostname satt till ${HOSTNAME_TARGET}.local ✓"
fi

# ─── 5. Install npm dependencies ─────────────────────────
echo "Installerar npm-beroenden..."
cd "$PI_DIR"
export NODE_OPTIONS="--max-old-space-size=256"
nice -n 15 npm install --no-audit --no-fund 2>&1 | tail -3

# ─── 6. Build Pi runtime ─────────────────────────────────
echo "Bygger..."
nice -n 15 npm run build
npm prune --omit=dev 2>/dev/null || npm prune --production 2>/dev/null || true
echo "  Bygg klart ✓"

# ─── 7. BLE permissions ──────────────────────────────────
echo "Sätter BLE-behörigheter..."
sudo setcap cap_net_raw+eip "$(readlink -f "$(which node)")" 2>/dev/null || true

# ─── 8. Make scripts executable ──────────────────────────
chmod +x "$PI_DIR/update-services.sh"
chmod +x "$PI_DIR/uninstall-lotus.sh" 2>/dev/null || true

# ─── 9. Validate core arg ────────────────────────────────
if ! [[ "$CORE" =~ ^[0-3]$ ]]; then
  echo "  Ogiltigt core '$CORE', använder standard: 1"
  CORE=1
fi

# ─── 10. systemd service ─────────────────────────────────
echo "Skapar systemd-tjänst..."

sudo tee /etc/systemd/system/${SERVICE_NAME}.service > /dev/null << EOF
[Unit]
Description=Lotus Light Link — Audio-reactive BLE LED controller
After=network.target bluetooth.target
Wants=bluetooth.target

[Service]
Type=simple
User=$(whoami)
WorkingDirectory=${PI_DIR}
ExecStart=/usr/bin/node dist/index.js
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

# Logging
StandardOutput=journal
StandardError=journal
SyslogIdentifier=${SERVICE_NAME}

[Install]
WantedBy=multi-user.target
EOF

# Auto-update service + timer
sudo tee /etc/systemd/system/lotus-update.service > /dev/null << 'EOF'
[Unit]
Description=Lotus Light Link — Auto-update from GitHub

[Service]
Type=oneshot
ExecStart=/opt/lotus-light/pi/update-services.sh
StandardOutput=journal
StandardError=journal
SyslogIdentifier=lotus-update
EOF

sudo tee /etc/systemd/system/lotus-update.timer > /dev/null << 'EOF'
[Unit]
Description=Lotus Light Link — Auto-update timer (every 5 min)

[Timer]
OnBootSec=2min
OnUnitActiveSec=5min
Persistent=true

[Install]
WantedBy=timers.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable ${SERVICE_NAME}
sudo systemctl enable lotus-update.timer

echo "Tjänster installerade ✓"

# ─── Done ─────────────────────────────────────────────────
echo ""
echo "Installation klar!"
echo "  Port: ${PORT}, CPU core: ${CORE}"
echo "  Starta: sudo systemctl start ${SERVICE_NAME}"
echo "  Loggar: journalctl -u ${SERVICE_NAME} -f"

if [ "$NEEDS_REBOOT" = true ]; then
  echo "  ⚠ Omstart krävs (I²S overlay tillagd) — kör: sudo reboot"
fi
