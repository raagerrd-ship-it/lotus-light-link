#!/bin/bash
# uninstall-lotus.sh — Remove Lotus Light Link from Raspberry Pi
# Called by Pi Dashboard or manually: bash uninstall-lotus.sh

set -e

SERVICE_NAME="lotus-light"

echo ""
echo "========================================"
echo "  Lotus Light Link Uninstaller"
echo "========================================"
echo ""

# 1. Stop and disable user-level services
echo "[1/3] Stoppar tjänster..."
systemctl --user stop "$SERVICE_NAME" 2>/dev/null || true
systemctl --user stop "${SERVICE_NAME}-update.timer" 2>/dev/null || true
systemctl --user stop "${SERVICE_NAME}-restart.timer" 2>/dev/null || true
systemctl --user disable "$SERVICE_NAME" 2>/dev/null || true
systemctl --user disable "${SERVICE_NAME}-update.timer" 2>/dev/null || true
systemctl --user disable "${SERVICE_NAME}-restart.timer" 2>/dev/null || true
echo "  ✓ Tjänster stoppade"

# 2. Remove service files
echo "[2/3] Tar bort systemd-filer..."
rm -f "$HOME/.config/systemd/user/${SERVICE_NAME}.service"
rm -f "$HOME/.config/systemd/user/${SERVICE_NAME}-update.service"
rm -f "$HOME/.config/systemd/user/${SERVICE_NAME}-update.timer"
rm -f "$HOME/.config/systemd/user/${SERVICE_NAME}-restart.service"
rm -f "$HOME/.config/systemd/user/${SERVICE_NAME}-restart.timer"
systemctl --user daemon-reload
echo "  ✓ Systemd-filer borttagna"

# Also clean up legacy system-level services if they exist
if [ -f "/etc/systemd/system/${SERVICE_NAME}.service" ]; then
  echo "  Rensar gamla system-level tjänster..."
  sudo systemctl stop "$SERVICE_NAME" 2>/dev/null || true
  sudo systemctl disable "$SERVICE_NAME" 2>/dev/null || true
  sudo rm -f "/etc/systemd/system/${SERVICE_NAME}.service"
  sudo rm -f "/etc/systemd/system/lotus-update.service"
  sudo rm -f "/etc/systemd/system/lotus-update.timer"
  sudo systemctl daemon-reload
  echo "  ✓ Legacy tjänster borttagna"
fi

# 3. Summary (don't remove /opt/lotus-light — dashboard manages that)
echo "[3/3] Klart"
echo ""
echo "========================================"
echo "  Avinstallation klar!"
echo "========================================"
echo ""
