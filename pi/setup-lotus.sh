#!/bin/bash
# setup-lotus.sh — Install Lotus Light Link on Raspberry Pi Zero 2 W
# Run as root: sudo bash setup-lotus.sh

set -euo pipefail

echo "╔═══════════════════════════════════════════╗"
echo "║   Lotus Light Link — Pi Setup             ║"
echo "╚═══════════════════════════════════════════╝"

# --- System deps ---
echo "[1/6] Installing system dependencies..."
apt-get update -qq
apt-get install -y -qq \
  bluez libbluetooth-dev \
  libasound2-dev alsa-utils \
  git

# --- Node.js 20 ---
if ! command -v node &>/dev/null || [[ $(node -v | cut -d. -f1 | tr -d v) -lt 20 ]]; then
  echo "[2/6] Installing Node.js 20..."
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y -qq nodejs
else
  echo "[2/6] Node.js $(node -v) already installed"
fi

# --- I²S audio overlay ---
echo "[3/6] Configuring I²S audio overlay..."
if ! grep -q "googlevoicehat-soundcard" /boot/config.txt 2>/dev/null && \
   ! grep -q "googlevoicehat-soundcard" /boot/firmware/config.txt 2>/dev/null; then
  CONFIG_FILE="/boot/config.txt"
  [ -f /boot/firmware/config.txt ] && CONFIG_FILE="/boot/firmware/config.txt"
  echo "dtoverlay=googlevoicehat-soundcard" >> "$CONFIG_FILE"
  echo "  Added I²S overlay to $CONFIG_FILE (reboot required)"
else
  echo "  I²S overlay already configured"
fi

# --- Project setup ---
APP_DIR="/opt/lotus-light"
echo "[4/6] Setting up project in $APP_DIR..."

if [ -d "$APP_DIR" ]; then
  cd "$APP_DIR/pi"
  git pull --ff-only 2>/dev/null || true
else
  # Expect repo to be cloned or copied
  mkdir -p "$APP_DIR"
  echo "  NOTE: Copy project files to $APP_DIR or clone from GitHub"
fi

if [ -d "$APP_DIR/pi" ]; then
  cd "$APP_DIR/pi"
  npm install --production
  npm run build
fi

# --- BLE permissions ---
echo "[5/6] Setting BLE permissions..."
setcap cap_net_raw+eip $(eval readlink -f $(which node)) 2>/dev/null || true

# --- systemd service ---
echo "[6/6] Installing systemd service..."
cat > /etc/systemd/system/lotus-light.service << 'EOF'
[Unit]
Description=Lotus Light Link — Audio-reactive BLE LED controller
After=network.target bluetooth.target
Wants=bluetooth.target

[Service]
Type=simple
User=root
WorkingDirectory=/opt/lotus-light/pi
ExecStart=/usr/bin/node dist/index.js
Restart=always
RestartSec=5
Environment=NODE_ENV=production
Environment=BRIDGE_URL=http://localhost:3000/api/sonos
Environment=CONFIG_PORT=3001
Environment=TICK_MS=30

# Resource limits
MemoryMax=128M
CPUQuota=80%

# Logging
StandardOutput=journal
StandardError=journal
SyslogIdentifier=lotus-light

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable lotus-light

echo ""
echo "╔═══════════════════════════════════════════╗"
echo "║   Setup complete!                         ║"
echo "║                                           ║"
echo "║   Start:   systemctl start lotus-light    ║"
echo "║   Logs:    journalctl -u lotus-light -f   ║"
echo "║   Config:  http://lotus.local:3001        ║"
echo "║                                           ║"
echo "║   NOTE: Reboot if I²S overlay was added   ║"
echo "╚═══════════════════════════════════════════╝"
