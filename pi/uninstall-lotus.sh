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

# 2. Remove BLE capabilities (optional cleanup)
echo "[2/2] Rensar BLE-rättigheter..."
NODE_BIN=$(readlink -f "$(which node)" 2>/dev/null)
if [ -n "$NODE_BIN" ]; then
  sudo setcap -r "$NODE_BIN" 2>/dev/null || true
  echo "  ✓ BLE-capabilities borttagna från Node"
else
  echo "  ✓ Inget att rensa"
fi

echo ""
echo "========================================"
echo "  Avinstallation klar!"
echo "========================================"
echo ""
echo "  Pi Control Center hanterar systemd-tjänster."
echo ""

exit 0
