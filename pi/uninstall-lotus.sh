#!/bin/bash
# uninstall-lotus.sh — Remove Lotus Light Link from Raspberry Pi
# Called by Pi Dashboard or manually: bash uninstall-lotus.sh

set -e

echo "Stoppar Lotus Light-tjänster..."

sudo systemctl stop lotus-light 2>/dev/null || true
sudo systemctl disable lotus-light 2>/dev/null || true
sudo rm -f /etc/systemd/system/lotus-light.service

sudo systemctl stop lotus-update.timer 2>/dev/null || true
sudo systemctl disable lotus-update.timer 2>/dev/null || true
sudo rm -f /etc/systemd/system/lotus-update.timer
sudo rm -f /etc/systemd/system/lotus-update.service

sudo systemctl daemon-reload

echo "Tjänster borttagna ✓"
echo "Avinstallation klar ✓"
