#!/bin/bash
# setup-lotus.sh — Install Lotus Light Link on Raspberry Pi Zero 2 W
# Run as root: sudo bash setup-lotus.sh
#
# Usage:
#   # First install (clones from GitHub):
#   curl -fsSL https://raw.githubusercontent.com/raagerrd-ship-it/lotus-light-link/main/pi/setup-lotus.sh | sudo bash
#
#   # Or manually:
#   git clone https://github.com/raagerrd-ship-it/lotus-light-link.git /opt/lotus-light
#   cd /opt/lotus-light
#   sudo bash pi/setup-lotus.sh

set -euo pipefail

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

REPO_URL="${REPO_URL:-https://github.com/raagerrd-ship-it/lotus-light-link.git}"
APP_DIR="/opt/lotus-light"
HOSTNAME_TARGET="lotus"
RUN_USER="${SUDO_USER:-pi}"

echo "╔═══════════════════════════════════════════════╗"
echo "║   Lotus Light Link — Pi Setup                 ║"
echo "╠═══════════════════════════════════════════════╣"
echo "║   Target: Raspberry Pi Zero 2 W               ║"
echo "║   Repo:   ${REPO_URL}"
echo "╚═══════════════════════════════════════════════╝"
echo ""

# ─── 1. System dependencies ──────────────────────────────
echo "[1/9] Installing system dependencies..."
apt-get update -qq
apt-get install -y -qq \
  bluez libbluetooth-dev \
  libasound2-dev alsa-utils \
  git curl

# ─── 2. Node.js 20 ───────────────────────────────────────
if ! command -v node &>/dev/null || [[ $(node -v | cut -d. -f1 | tr -d v) -lt 20 ]]; then
  echo "[2/9] Installing Node.js 20..."
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y -qq nodejs
else
  echo "[2/9] Node.js $(node -v) already installed ✓"
fi

# ─── 3. I²S audio overlay (INMP441 mic) ──────────────────
echo "[3/9] Configuring I²S audio overlay..."
NEEDS_REBOOT=false
CONFIG_FILE="/boot/config.txt"
[ -f /boot/firmware/config.txt ] && CONFIG_FILE="/boot/firmware/config.txt"

if ! grep -q "googlevoicehat-soundcard" "$CONFIG_FILE" 2>/dev/null; then
  echo "dtoverlay=googlevoicehat-soundcard" >> "$CONFIG_FILE"
  echo "  ✓ Added I²S overlay to $CONFIG_FILE"
  NEEDS_REBOOT=true
else
  echo "  ✓ I²S overlay already configured"
fi

# ─── 4. Hostname ─────────────────────────────────────────
echo "[4/9] Setting hostname..."
CURRENT_HOSTNAME=$(hostname)
if [ "$CURRENT_HOSTNAME" != "$HOSTNAME_TARGET" ]; then
  hostnamectl set-hostname "$HOSTNAME_TARGET"
  echo "  ✓ Hostname set to ${HOSTNAME_TARGET}.local"
else
  echo "  ✓ Hostname already ${HOSTNAME_TARGET}.local"
fi

# ─── 5. Clone or update repo ─────────────────────────────
echo "[5/9] Setting up project..."
if [ -d "$APP_DIR/.git" ]; then
  echo "  Pulling latest from GitHub..."
  cd "$APP_DIR"
  git fetch --all -q
  git reset --hard origin/main -q
  echo "  ✓ Updated to $(git rev-parse --short HEAD)"
elif [ -f "$APP_DIR/pi/package.json" ]; then
  echo "  ✓ Project already in place (no git)"
else
  echo "  Cloning repository..."
  # Remove any partial/empty directory so git clone succeeds
  if [ -d "$APP_DIR" ]; then
    rm -rf "$APP_DIR"
  fi
  git clone "$REPO_URL" "$APP_DIR"
  echo "  ✓ Cloned to $APP_DIR"
fi

# Set ownership to pi user (avoids needing sudo in update script)
chown -R "$RUN_USER:$RUN_USER" "$APP_DIR"
echo "  ✓ Ownership set to $RUN_USER"

# ─── 6. Build Pi runtime ─────────────────────────────────
echo "[6/9] Installing dependencies & building..."
cd "$APP_DIR/pi"
sudo -u "$RUN_USER" NODE_OPTIONS="--max-old-space-size=256" npm install --no-audit --no-fund 2>&1 | tail -1
sudo -u "$RUN_USER" NODE_OPTIONS="--max-old-space-size=256" npm run build
sudo -u "$RUN_USER" npm prune --omit=dev 2>/dev/null || sudo -u "$RUN_USER" npm prune --production 2>/dev/null || true
echo "  ✓ Build complete"

# ─── 7. BLE permissions ──────────────────────────────────
echo "[7/9] Setting BLE permissions..."
setcap cap_net_raw+eip "$(readlink -f "$(which node)")" 2>/dev/null || true
echo "  ✓ Node.js has BLE raw socket capability"

# ─── 8. Validate args ─────────────────────────────────────
echo "[8/9] Validating configuration..."
if ! [[ "$CORE" =~ ^[0-3]$ ]]; then
  echo "  ⚠ Invalid core '$CORE', using default: 1"
  CORE=1
fi
echo "  ✓ Port: ${PORT}, CPU core: ${CORE}"

# ─── 9. systemd services ─────────────────────────────────
echo "[9/9] Installing systemd services..."

# Ensure update script is executable
chmod +x "$APP_DIR/pi/update-services.sh"

# Main service
cat > /etc/systemd/system/lotus-light.service << EOF
[Unit]
Description=Lotus Light Link — Audio-reactive BLE LED controller
After=network.target bluetooth.target
Wants=bluetooth.target

[Service]
Type=simple
User=${RUN_USER}
WorkingDirectory=/opt/lotus-light/pi
ExecStart=/usr/bin/node dist/index.js
Restart=always
RestartSec=5
Environment=NODE_ENV=production
Environment=BRIDGE_URL=http://localhost:3000/api/sonos
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
SyslogIdentifier=lotus-light

[Install]
WantedBy=multi-user.target
EOF

# Auto-update service
cat > /etc/systemd/system/lotus-update.service << 'EOF'
[Unit]
Description=Lotus Light Link — Auto-update from GitHub

[Service]
Type=oneshot
ExecStart=/opt/lotus-light/pi/update-services.sh
StandardOutput=journal
StandardError=journal
SyslogIdentifier=lotus-update
EOF

# Auto-update timer (every 5 minutes)
cat > /etc/systemd/system/lotus-update.timer << 'EOF'
[Unit]
Description=Lotus Light Link — Auto-update timer (every 5 min)

[Timer]
OnBootSec=2min
OnUnitActiveSec=5min
Persistent=true

[Install]
WantedBy=timers.target
EOF

systemctl daemon-reload
systemctl enable lotus-light
systemctl enable lotus-update.timer

echo "  ✓ lotus-light.service installed & enabled"
echo "  ✓ lotus-update.timer installed & enabled (every 5 min)"

# ─── Done ─────────────────────────────────────────────────
echo ""
echo "╔═══════════════════════════════════════════════╗"
echo "║   ✅ Setup complete!                          ║"
echo "╠═══════════════════════════════════════════════╣"
echo "║                                               ║"
echo "║   Start:    systemctl start lotus-light       ║"
echo "║   Logs:     journalctl -u lotus-light -f      ║"
echo "║   Status:   http://lotus.local:3001/api/status║"
echo "║                                               ║"
echo "║   Updates:  Automatic via GitHub (5 min)      ║"
echo "║   Manual:   bash pi/update-services.sh        ║"
echo "║                                               ║"
if [ "$NEEDS_REBOOT" = true ]; then
echo "║   ⚠️  REBOOT REQUIRED (I²S overlay added)     ║"
echo "║   Run: sudo reboot                            ║"
fi
echo "╚═══════════════════════════════════════════════╝"
