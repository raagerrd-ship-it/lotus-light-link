---
name: rfkill kräver netdev-grupp, inte bara CAP_NET_ADMIN
description: /dev/rfkill checkar gruppmedlemskap före capability — user måste vara i netdev (och bluetooth för BlueZ). Kräver logout/reboot.
type: feature
---
**Symptom:** `rfkill unblock bluetooth` failar med `cannot open /dev/rfkill: Permission denied` trots `setcap 'cap_net_raw,cap_net_admin+eip' $(which rfkill)`.

**Root cause:** `/dev/rfkill` ägs av `root:netdev` med mode 660. Kerneln/udev gör DAC-check på filen INNAN capability-check. CAP_NET_ADMIN på binären räcker inte — du måste tillhöra `netdev`-gruppen (eller `rfkill` på vissa distros).

**Fix i `setup-lotus.sh`:**
```bash
sudo usermod -aG bluetooth,netdev "$TARGET_USER"
```
Kräver logout+login (eller reboot) för att gruppen ska aktiveras i sessionen — `systemctl --user`-tjänsten ärver gruppen från user-sessionen, så reboot är säkrast.

**Bevis (2026-04-19):** Med caps men utan groups → `Permission denied`. Efter `usermod -aG bluetooth,netdev pi` + logout/login + manuell `node`-körning → `rfkill` failar fortfarande (eftersom Steg 0 är best-effort), MEN noble får ändå `stateChange poweredOn` på +222ms och motorn blir redo. Conclusion: rfkill är "nice to have", riktiga blockern var att processen kördes i fel session.

**Permanent setup:**
1. `setup-lotus.sh` lägger user i `bluetooth,netdev`-grupperna
2. PCC's user-service ärver grupperna efter logout/reboot
3. Service-instansen lyssnar på `PORT=3051` (PCC: `--port 3001` + offset 50)
