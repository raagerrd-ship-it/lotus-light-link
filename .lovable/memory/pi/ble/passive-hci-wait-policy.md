---
name: Engine väntar passivt på hci0 UP RUNNING — aldrig aktiv wake
description: engine-start-minimal.ts får INTE köra hciconfig up/rfkill unblock själv. bluetoothd äger adaptern och tar upp den. Aktiv wake racear bluetoothd → org.bluez.Error.Busy + ETIMEDOUT.
type: constraint
---
**Förbjudet i `pi/src/ble/engine-start-minimal.ts`:**
- `bringHci0Up()` (kör hciconfig up + rfkill unblock)
- `execSync('hciconfig hci0 up')`
- Allt som muterar adapter-state före noble-import

**Tillåtet:**
- `isHci0Up()` (read-only hciconfig-poll)
- Passiv wait-loop upp till 8s

**Bevis (2026-04-20):** SSH-logg visade `bluetoothctl power on` → `Failed to set power on: org.bluez.Error.Busy` direkt efter att engine försökt `hciconfig hci0 up`. Adaptern fastnade DOWN, noble fick `poweredOff` cachad permanent.

**Vem ansvarar för wake:** `setup-lotus.sh` enable+startar `bluetooth.service` (BlueZ daemon). bluetoothd power:ar på adaptern automatiskt vid boot/restart. Engine ska bara vänta.

**Recovery om hci0 är DOWN:** `sudo systemctl restart bluetooth` — aldrig `hciconfig hci0 up` från engine.
