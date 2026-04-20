---
name: AmbientCapabilities clearar SupplementaryGroups
description: systemd's AmbientCapabilities=CAP_NET_* gör att SupplementaryGroups=netdev bluetooth IGNORERAS vid setuid-switchen. Lägg user i grupperna permanent via usermod -aG + udev-regel för /dev/rfkill.
type: constraint
---
När en systemd-service har `User=pi` + `AmbientCapabilities=CAP_NET_RAW CAP_NET_ADMIN`, så **clearar Linux alla supplementary groups** vid capability-switchen. Det betyder att `SupplementaryGroups=netdev bluetooth` i unit-filen INTE appliceras — processen får bara sin primära grupp.

**Symptom:**
- `rfkill: cannot open /dev/rfkill: Permission denied` i engine-loggen
- `[Boot/Perms] /dev/rfkill: NO ACCESS (EACCES) — netdev-grupp saknas i processen`
- `hciconfig hci0 up` ger `spawnSync ETIMEDOUT` (mgmt-socket stängs)

**Fix (krävs båda):**
1. `sudo usermod -aG netdev,bluetooth pi` — permanent gruppmedlemskap i /etc/group överlever capability-clear
2. udev-regel `KERNEL=="rfkill", GROUP="netdev", MODE="0660"` — annars är /dev/rfkill root:root 0660 och även CAP_NET_ADMIN räcker inte för open()
3. `DeviceAllow=/dev/rfkill rw` + `DeviceAllow=char-rfkill rw` i unit — annars blockerar systemd cgroup-device-controllern access

Verifierat 2026-04-20 i pi/setup-lotus.sh (steg 3b + 3c + DeviceAllow).
