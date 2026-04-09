#!/bin/bash
# uninstall-lotus.sh — Remove Lotus Light Link from Raspberry Pi
# Called by Pi Dashboard or manually: sudo bash uninstall-lotus.sh

set -euo pipefail

echo "Stopping and disabling Lotus Light services..."

# Stop and disable main service
systemctl stop lotus-light 2>/dev/null || true
systemctl disable lotus-light 2>/dev/null || true
rm -f /etc/systemd/system/lotus-light.service

# Stop and disable update timer
systemctl stop lotus-update.timer 2>/dev/null || true
systemctl disable lotus-update.timer 2>/dev/null || true
rm -f /etc/systemd/system/lotus-update.timer
rm -f /etc/systemd/system/lotus-update.service

systemctl daemon-reload

echo "Services removed ✓"

# Optionally remove installed files
if [[ "${REMOVE_FILES:-false}" == "true" ]]; then
  echo "Removing /opt/lotus-light..."
  rm -rf /opt/lotus-light
  echo "Files removed ✓"
else
  echo "Project files kept at /opt/lotus-light (set REMOVE_FILES=true to delete)"
fi

echo "Uninstall complete ✓"
