#!/bin/bash
# uninstall-lotus.sh — Clean up Lotus Light Link files
# Called by Pi Control Center. Systemd services are managed by Pi Control Center.
# This script:
#   1. Försöker släcka BLE-lampan rent via /api/ble/disconnect (best effort)
#   2. Dödar alla körande lotus-light node-processer (även de utanför systemd)
#   3. Tar bort byggfiler, node_modules, config och legacy-tjänst

set +e

APP_DIR="/opt/lotus-light"

echo ""
echo "========================================"
echo "  Lotus Light Link Uninstaller"
echo "========================================"
echo ""

# 0. Försök stänga ner BLE-lampan rent INNAN vi dödar processen.
#    Engine lyssnar på 3050 (port + 50 mönstret är för UI). Om engine
#    redan är död är det här en no-op (curl --max-time 2).
echo "[1/4] Kopplar från BLE-lampor (best effort)..."
for port in 3050 3051 3052; do
  curl -s --max-time 2 -X POST "http://127.0.0.1:${port}/api/ble/disconnect" >/dev/null 2>&1
done
echo "  ✓ Disconnect-anrop skickade"

# 1. Stoppa systemd-tjänsten OM den finns (Pi Control Center kan ha den)
echo "[2/4] Stoppar tjänster och dödar node-processer..."
sudo systemctl stop lotus-light-engine.service 2>/dev/null || true
sudo systemctl stop lotus-light.service 2>/dev/null || true

# Döda alla node-processer som kör lotus-light, även de utanför systemd.
# Vanligt scenario: gamla manuellt-startade processer (t.ex. från
# /home/pi/...) som överlever en systemctl stop.
# VIKTIGT: pkill -f matchar HELA cmdline inkl. CWD-resolution — om scriptet
# körs från /opt/lotus-light/... matchar pkill sin egen parent-shell och
# dödar sessionen. Lösning: matcha bara på 'node' i cmd-namnet och filtrera
# bort vår egen pid + parent-pid.
SELF_PID=$$
PARENT_PID=$PPID
KILL_PIDS=$(pgrep -f "node.*lotus-light|node.*piEngine" 2>/dev/null | grep -vE "^($SELF_PID|$PARENT_PID)$" || true)
if [ -n "$KILL_PIDS" ]; then
  echo "$KILL_PIDS" | xargs -r sudo kill -TERM 2>/dev/null || true
  sleep 1
  KILL_PIDS=$(pgrep -f "node.*lotus-light|node.*piEngine" 2>/dev/null | grep -vE "^($SELF_PID|$PARENT_PID)$" || true)
  [ -n "$KILL_PIDS" ] && echo "$KILL_PIDS" | xargs -r sudo kill -KILL 2>/dev/null || true
fi

REMAINING=$(pgrep -f "lotus-light|piEngine" | wc -l)
if [ "$REMAINING" -gt 0 ]; then
  echo "  ⚠ Varning: $REMAINING node-process(er) lever fortfarande — kontrollera manuellt:"
  echo "    ps aux | grep -E 'lotus|piEngine' | grep -v grep"
else
  echo "  ✓ Alla lotus node-processer dödade"
fi

# 2. Rensa applikationsfiler
echo "[3/4] Rensar applikationsfiler..."
rm -rf "$APP_DIR/dist" 2>/dev/null
rm -rf "$APP_DIR/pi/dist" 2>/dev/null
rm -rf "$APP_DIR/pi/node_modules" 2>/dev/null
rm -rf "$APP_DIR/node_modules" 2>/dev/null
# Konfigurations-/storage-filer (kalibrering, sparad enhet, gain-cal etc.)
# Pi Control Center äger själva mappen; vi nollar bara innehållet.
rm -f "$APP_DIR/data/storage.json" 2>/dev/null
rm -f "$APP_DIR/storage.json" 2>/dev/null
echo "  ✓ Byggfiler, beroenden och lokal storage borttagna"

# 3. Ta bort legacy systemd-tjänst om den finns kvar från tidigare installation
echo "[4/4] Rensar legacy systemd-tjänst..."
if [ -f /etc/systemd/system/lotus-light-engine.service ]; then
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
echo "  Om ljuset fortsätter blinka: stäng av lampan helt"
echo "  (BLEDOM kan ha hamnat i internt mic-mode via fjärr)."
echo ""

exit 0
