---
name: DeviceAllow= implicerar DevicePolicy=closed → blockerar /dev/snd
description: Så fort en enda DeviceAllow=-rad sätts i en systemd-service blockeras ALLA andra device-noder. Att lägga DeviceAllow=/dev/rfkill för BLE bröt ALSA mic-capture (snd_pcm_open returnerar ENOENT, inte EPERM). Lösning: lägg även till DeviceAllow=char-alsa rw + DeviceAllow=/dev/snd rw.
type: constraint
---
**Symptom (2026-04-20):** Mic-subsystem startar utan fel men `arecord -l` inifrån service-context misslyckas och native alsa-capture får `snd_pcm_open(device='hw:0,0') failed: rc=-2 errno=2 (No such file or directory)`. Samma kommando som user `pi` direkt fungerar perfekt. Engine-processen har korrekt UID/GID/Groups (audio gid 29 finns i /proc/PID/status).

**Rotorsak:** systemd's device cgroup-policy är "default-allow" tills första `DeviceAllow=`-raden sätts — då växlar den implicit till `DevicePolicy=closed` (deny-all utom whitelistade). Commit `49a54ec0` lade till `DeviceAllow=/dev/rfkill rw` + `DeviceAllow=char-rfkill rw` för att lösa BLE-rfkill-permissions. Det stängde samtidigt av åtkomst till `/dev/snd/*` för engine-processen. Kärnan returnerar ENOENT (inte EPERM) när cgroup-device blockerar en device-nod — vilket gör buggen extremt missvisande.

**Lösning (setup-lotus.sh):**
```ini
DeviceAllow=/dev/rfkill rw
DeviceAllow=char-rfkill rw
DeviceAllow=char-alsa rw
DeviceAllow=/dev/snd rw
```

**update-services.sh** har health-check som tvingar full re-deploy om `DeviceAllow=char-alsa` saknas.

**Lärdom:** Använd ALDRIG bara en enda `DeviceAllow=`-rad i en systemd-service utan att också whitelista alla andra devices processen behöver. Antingen: lista ALLT explicit, eller använd `DevicePolicy=auto` (default) och hantera rättigheter via grupper + udev istället.
