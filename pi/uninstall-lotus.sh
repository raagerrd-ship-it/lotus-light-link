#!/bin/bash
# uninstall-lotus.sh — Clean up Lotus Light Link files
# Called by Pi Control Center. Systemd services are managed by Pi Control Center.
# This script ONLY removes application files and config.

set +e

APP_DIR="/opt/lotus-light"

echo ""
echo "========================================"
echo "  Lotus Light Link Uninstaller"
echo "========================================"
echo ""

# 1. Remove application files (preserve installDir removal to Pi Control Center)
echo "[1/2] Rensar applikationsfiler..."
rm -rf "$APP_DIR/dist" 2>/dev/null
rm -rf "$APP_DIR/pi/dist" 2>/dev/null
rm -rf "$APP_DIR/pi/node_modules" 2>/dev/null
rm -rf "$APP_DIR/node_modules" 2>/dev/null
echo "  ✓ Byggfiler och beroenden borttagna"

# 2. Remove BLE permissions (polkit rule + bluetooth group)
echo "[2/3] Rensar BLE-rättigheter..."

# Remove polkit rule
POLKIT_FILE="/etc/polkit-1/localauthority/50-local.d/lotus-light-ble.pkla"
if [ -f "$POLKIT_FILE" ]; then
  sudo rm -f "$POLKIT_FILE"
  echo "  ✓ Polkit-regel borttagen"
else
  echo "  ✓ Ingen polkit-regel att rensa"
fi

# Remove user from bluetooth group
LOTUS_USER="${SUDO_USER:-$(whoami)}"
if id -nG "$LOTUS_USER" 2>/dev/null | grep -qw bluetooth; then
  sudo gpasswd -d "$LOTUS_USER" bluetooth 2>/dev/null || true
  echo "  ✓ $LOTUS_USER borttagen från bluetooth-gruppen"
else
  echo "  ✓ Ingen gruppändring behövs"
fi

# 3. Remove legacy systemd service if still present
echo "[3/3] Rensar legacy systemd-tjänst..."
if [ -f /etc/systemd/system/lotus-light-engine.service ]; then
  sudo systemctl stop lotus-light-engine.service 2>/dev/null || true
  sudo systemctl disable lotus-light-engine.service 2>/dev/null || true
  sudo rm -f /etc/systemd/system/lotus-light-engine.service
  sudo systemctl daemon-reload
  echo "  ✓ Legacy systemd-tjänst borttagen"
else
  echo "  ✓ Ingen legacy-tjänst att rensa"
fi

echo ""
echo "========================================"
echo "  Avinstallation klar!"
echo "========================================"
echo ""
echo "  Pi Control Center hanterar systemd-tjänster."
echo ""

exit 0
