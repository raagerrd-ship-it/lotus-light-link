---
name: bluetoothd måste vara enabled för att noble ska få stateChange
description: Utan bluetoothd igång stannar noble.state på "unknown" oavsett caps, hci0 UP RUNNING och rfkill unblocked. Setup ska enable+start bluetooth.service.
type: feature
---
**Symptom:** Noble fyrar aldrig `stateChange`-event. `noble.state` förblir `"unknown"` för evigt även när:
- `hci0` är UP RUNNING
- `rfkill` är ej blockerad
- `/usr/bin/node` har `cap_net_raw,cap_net_admin+eip`
- Servicen kör med `CapEff=0000000000003000` (CAP_NET_RAW + CAP_NET_ADMIN)
- Fristående `node -e "..."`-test fungerar **men bara när bluetoothd nyss startades**

**Root cause:** På Raspberry Pi OS Bookworm krävs `bluetoothd` (BlueZ management daemon) för att HCI-adaptern ska initieras till ett state som userspace HCI-sockets (inkl. `@stoprocent/noble`) kan observera. `hci0 UP RUNNING` på interface-nivå räcker inte — det är L2/HCI-link, inte BlueZ adapter management state.

**Verifierat genom:** På Pi:n hittades `bluetooth.service: inactive (dead) since ... 1h 44min ago, Status: "Powering down"`. Efter `sudo systemctl enable --now bluetooth` + restart av Lotus → noble fick `stateChange poweredOn` och `nobleRaw: "poweredOn"` i diagnostics.

**Fix i `setup-lotus.sh`:**
```bash
sudo systemctl enable --now bluetooth
```

**Fix i systemd user-service:** Lägg till BlueZ-beroende i `[Unit]`:
```
After=bluetooth.service
Wants=bluetooth.service
```
(user-units kan inte direkt depend:a på system-units, men `After=` fungerar för ordering om bluetooth redan är enabled.)

**Långsam stateChange efter färsk bluetoothd-start:** Om bluetoothd precis startade tar noble 30–90s att få sitt första `stateChange` på Pi Zero 2W. Vid normal boot (bluetoothd uppe från start) är det <5s. Därför ska `waitForFirstStateChange` vid boot ha generös timeout (15–30s) — det blockerar bara boot-sekvensen, inte runtime.

**Vem stänger av bluetoothd?** Misstänkt: vår gamla `hardBluetoothRestart_invoked`-workaround eller manuell debugging. Rensa bort destruktiva BlueZ-anrop ur Lotus-koden — Lotus ska aldrig stoppa bluetoothd.
