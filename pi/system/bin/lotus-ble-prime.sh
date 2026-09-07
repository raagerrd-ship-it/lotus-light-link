#!/bin/bash
# GOR REMSAN ANSLUTNINGSBAR IGEN.
#
# UPPMATT KEDJA (2026-09-02), i den ordning felen visade sig:
#   1. Efter en motoromstart: "Peripheral already connected" trots att
#      `hcitool con` ar TOM. bluetoothd sitter kvar med en inaktuell enhetspost.
#   2. `bluetoothctl remove` botar (1) -- men skapar (3).
#   3. Utan enhetspost hanger motorns direktanslutning-pa-adress i 30 s:
#      "connect in-flight watchdog (30s)", om och om igen. Remsan ANNONSERADE
#      hela tiden med RSSI -59, sa det var aldrig hardvaran.
#   4. En SCANNING fyller posten igen, och da gar anslutningen igenom direkt.
#
# Darfor: rensa, cykla adaptern, SCANNA, och anslut en gang med systemets egen
# stack. Sedan kan motorn ta over lanken.
MAC=${LOTUS_BLE_MAC:-BE:67:00:15:09:41}

timeout 10 bluetoothctl remove "$MAC" >/dev/null 2>&1
hciconfig hci0 down; sleep 1; hciconfig hci0 up; sleep 2

# Scanning OCH anslutning i SAMMA session: en upptackt i en annan session hinner
# hinna falla ur cachen innan nasta kommando kors, och da svarar bluetoothctl
# "Device not available".
{ echo "scan on"; sleep 12; echo "connect $MAC"; sleep 12; echo "quit"; } \
  | timeout 40 bluetoothctl 2>&1 | grep -qi "Connection successful"
rc=$?
timeout 10 bluetoothctl disconnect "$MAC" >/dev/null 2>&1
# Remsan behover en stund pa sig att sla ner lanken fran sin sida innan noble
# far ta over — utan pausen misslyckas motorns forsta anslutning ibland anda.
sleep 3
exit $rc
