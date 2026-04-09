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

# ─── Detect target user (support running as root via Pi Dashboard) ────
if [ "$EUID" -eq 0 ]; then
  # Running as root — determine the real user
  TARGET_USER="${SUDO_USER:-pi}"
  TARGET_HOME=$(eval echo "~$TARGET_USER")
  echo "  Kör som root → installerar för användare: $TARGET_USER"
else
  TARGET_USER="$USER"
  TARGET_HOME="$HOME"
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

# Ensure /etc/hosts has an entry for the hostname (prevents sudo warnings)
if ! grep -q "127.0.1.1.*${HOSTNAME_TARGET}" /etc/hosts 2>/dev/null; then
  echo "127.0.1.1 ${HOSTNAME_TARGET}" | sudo tee -a /etc/hosts > /dev/null
  echo "  ✓ /etc/hosts uppdaterad med ${HOSTNAME_TARGET}"
else
  echo "  ✓ /etc/hosts redan korrekt"
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
cat > "$SUDOERS_FILE" 2>/dev/null || sudo tee "$SUDOERS_FILE" > /dev/null << SUDOEOF
# Lotus Light Link — allow target user to manage BLE caps and service without password
${TARGET_USER} ALL=(root) NOPASSWD: /usr/sbin/setcap cap_net_raw+eip *
${TARGET_USER} ALL=(root) NOPASSWD: /bin/systemctl restart ${SERVICE_NAME}
${TARGET_USER} ALL=(root) NOPASSWD: /bin/systemctl stop ${SERVICE_NAME}
${TARGET_USER} ALL=(root) NOPASSWD: /bin/systemctl start ${SERVICE_NAME}
SUDOEOF
chmod 0440 "$SUDOERS_FILE" 2>/dev/null || sudo chmod 0440 "$SUDOERS_FILE"
echo "  ✓ sudoers-regel skapad"

# ─── 8. Validate core arg ────────────────────────────────
if ! [[ "$CORE" =~ ^[0-3]$ ]]; then
  echo "  Ogiltigt core '$CORE', använder standard: 1"
  CORE=1
fi

# ─── 9. User-level systemd services ─────────────────────
echo "[8/8] Skapar systemd-tjänster..."
SYSTEMD_USER_DIR="$TARGET_HOME/.config/systemd/user"
mkdir -p "$SYSTEMD_USER_DIR"

# Main service
cat > "$SYSTEMD_USER_DIR/${SERVICE_NAME}.service" << EOF
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
cat > "$SYSTEMD_USER_DIR/${SERVICE_NAME}-update.service" << EOF
[Unit]
Description=Lotus Light Link — Auto-update from GitHub

[Service]
Type=oneshot
ExecStart=${PI_DIR}/update-services.sh
Environment=HOME=$TARGET_HOME
Environment=PATH=/usr/local/bin:/usr/bin:/bin
EOF

cat > "$SYSTEMD_USER_DIR/${SERVICE_NAME}-update.timer" << EOF
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
cat > "$SYSTEMD_USER_DIR/${SERVICE_NAME}-restart.service" << EOF
[Unit]
Description=Restart Lotus Light Link

[Service]
Type=oneshot
ExecStart=/bin/systemctl --user restart ${SERVICE_NAME}
EOF

cat > "$SYSTEMD_USER_DIR/${SERVICE_NAME}-restart.timer" << EOF
[Unit]
Description=Nightly restart of Lotus Light Link

[Timer]
OnCalendar=*-*-* 05:00:00
Persistent=true

[Install]
WantedBy=timers.target
EOF

# Enable linger so user services survive logout
loginctl enable-linger "$TARGET_USER" 2>/dev/null || true

# Helper: run systemctl --user as TARGET_USER (works both as root and as the user)
run_user_systemctl() {
  if [ "$EUID" -eq 0 ]; then
    sudo -u "$TARGET_USER" XDG_RUNTIME_DIR="/run/user/$(id -u "$TARGET_USER")" systemctl --user "$@"
  else
    systemctl --user "$@"
  fi
}

# Fix ownership if created as root
if [ "$EUID" -eq 0 ]; then
  chown -R "$TARGET_USER:$TARGET_USER" "$TARGET_HOME/.config/systemd" 2>/dev/null || true
fi

run_user_systemctl daemon-reload
run_user_systemctl enable "$SERVICE_NAME"
run_user_systemctl enable "${SERVICE_NAME}-update.timer"
run_user_systemctl enable "${SERVICE_NAME}-restart.timer"

# Start everything
run_user_systemctl start "${SERVICE_NAME}-update.timer"
run_user_systemctl start "${SERVICE_NAME}-restart.timer"
run_user_systemctl start "$SERVICE_NAME"

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
