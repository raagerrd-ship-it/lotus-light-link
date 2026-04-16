#!/bin/bash
# BLE scan debug — kör steg för steg för att hitta var det felar
# Användning: sudo bash /opt/lotus-light/scripts/ble-scan-debug.sh

set -e
echo "═══ BLE Scan Debug ═══"
echo ""

# 1. Adapter-status
echo "── Steg 1: Adapter-status ──"
hciconfig hci0 2>&1 || echo "❌ hciconfig misslyckades"
echo ""

# 2. rfkill
echo "── Steg 2: rfkill ──"
rfkill list bluetooth 2>&1 || echo "(rfkill ej tillgänglig)"
echo ""

# 3. Reset adapter
echo "── Steg 3: hciconfig hci0 reset ──"
hciconfig hci0 reset 2>&1 && echo "✅ Reset OK" || echo "❌ Reset misslyckades"
sleep 0.5
echo ""

# 4. Kontrollera att adapter är UP efter reset
echo "── Steg 4: Adapter UP efter reset? ──"
hciconfig hci0 2>&1 | head -5
echo ""

# 5. hcitool lescan (UTAN pipe — till tempfil)
echo "── Steg 5: hcitool lescan (3s, till tempfil) ──"
echo "(Startar scan — väntar 3 sekunder...)"
timeout 3 hcitool lescan > /tmp/ble-scan-raw.txt 2>&1 || true
LINES=$(wc -l < /tmp/ble-scan-raw.txt)
echo "✅ Scan klar — $LINES rader i /tmp/ble-scan-raw.txt"
echo "Första 20 rader:"
head -20 /tmp/ble-scan-raw.txt
echo ""

# 6. Samma sak med pipe (förväntas misslyckas)
echo "── Steg 6: hcitool lescan MED pipe (ska misslyckas) ──"
hciconfig hci0 reset 2>&1 && sleep 0.5
RESULT=$(timeout 3 hcitool lescan 2>/dev/null | head -20 || true)
PLINES=$(echo "$RESULT" | wc -l)
echo "Resultat med pipe: $PLINES rader"
echo "$RESULT"
echo ""

# 7. bluetoothctl scan
echo "── Steg 7: bluetoothctl scan le (3s) ──"
hciconfig hci0 reset 2>&1 && sleep 0.5
bluetoothctl --timeout 3 scan le >/dev/null 2>&1 || true
echo "bluetoothctl devices:"
bluetoothctl devices 2>&1
echo ""

# 8. Jämförelse
echo "═══ Sammanfattning ═══"
echo "hcitool (tempfil): $LINES rader"
echo "hcitool (pipe):    $PLINES rader"
BTCTL_COUNT=$(bluetoothctl devices 2>/dev/null | wc -l)
echo "bluetoothctl:      $BTCTL_COUNT enheter"
echo ""
echo "Om hcitool (tempfil) hittar fler → byt scan.ts till tempfil-metoden"
echo "Om bluetoothctl hittar fler → behåll nuvarande metod"
