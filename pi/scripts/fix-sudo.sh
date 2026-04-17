#!/bin/bash
# fix-sudo.sh — Thin wrapper. Den faktiska implementationen ägs av
# Pi Control Center (PCC) eftersom sudo-health är OS-nivå och delas av
# alla tjänster (Lotus, Cast Away, Brew Monitor).
#
# Beteende:
#   1. Letar efter PCC-scriptet på vanliga platser och kör det om det finns.
#   2. Om PCC inte är installerat: skriver en kort varning och avslutar med 0
#      (vi vill inte blockera Lotus-installationen för att PCC saknas).
#
# Manuell körning (när PCC finns):
#   bash /opt/pi-dashboard/public/pi-scripts/fix-sudo.sh

set -u

PCC_PATHS=(
  "/opt/pi-dashboard/public/pi-scripts/fix-sudo.sh"
  "/var/www/pi-dashboard/pi-scripts/fix-sudo.sh"
  "/var/www/html/pi-scripts/fix-sudo.sh"
)

for p in "${PCC_PATHS[@]}"; do
  if [ -f "$p" ]; then
    echo "  → Kör PCC fix-sudo.sh från $p"
    bash "$p"
    exit $?
  fi
done

echo "  ℹ PCC fix-sudo.sh hittades inte — hoppar över sudo pre-flight"
echo "    (Installera Pi Control Center för automatisk sudo-reparation)"
exit 0
