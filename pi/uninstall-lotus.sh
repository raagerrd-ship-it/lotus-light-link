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
echo "[1/3] Rensar applikationsfiler..."
rm -rf "$APP_DIR/dist" 2>/dev/null
rm -rf "$APP_DIR/pi/dist" 2>/dev/null
rm -rf "$APP_DIR/pi/node_modules" 2>/dev/null
rm -rf "$APP_DIR/node_modules" 2>/dev/null
echo "  ✓ Byggfiler och beroenden borttagna"

# 2. Remove legacy systemd service if still present
# (BLE permissions are handled by Pi Control Center via AmbientCapabilities)
echo "[2/2] Rensar legacy systemd-tjänst..."
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
