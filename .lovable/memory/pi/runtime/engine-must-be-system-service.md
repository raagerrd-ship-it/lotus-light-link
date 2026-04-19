---
name: Engine MÅSTE köras som system-service, inte user-service
description: PCC skapar lotus-light-engine som --user-service, men user-services ärver INTE login-användarens supplementary groups (netdev, bluetooth). Resultat: rfkill+hci0 = Permission denied → noble fastnar i state=unknown. setup-lotus.sh skriver över med en system-service.
type: constraint
---
**Symptom:** Tjänsten startar (active running), men loggen visar:
```
rfkill: cannot open /dev/rfkill: Permission denied
hciconfig: Can't init device hci0: Operation not permitted (1)
noble.state efter 1s = unknown → Timeout waiting for Noble to be powered on
```
Trots att `pi`-användaren är medlem i både `netdev` och `bluetooth` (verifierat med `getent group`).

**Rotorsak:** systemd `--user`-services kör i `user@1000.service`-cgroupen, som INTE ärver supplementary groups från login-sessionen. `SupplementaryGroups=` i user-unit failar dessutom med `status=216/GROUP` eftersom user-systemd saknar privileges att sätta grupper.

**Lösning (implementerad i setup-lotus.sh, build 2026-04-19/system-service-engine):**
1. Disabla PCC:s user-service: `systemctl --user disable lotus-light-engine`
2. Skriv `/etc/systemd/system/lotus-light-engine.service` med `User=pi`, `Group=pi`, `SupplementaryGroups=netdev bluetooth`
3. `sudo systemctl enable + restart lotus-light-engine`

**Manuell körning (SSH) funkar** för att en interaktiv login-session DÅ har grupperna direkt — det är skillnaden mellan `pi@login` och `user@1000.service`.

**update-services.sh** har redan logik som hanterar både user- och system-service vid restart.

**Verifiera efter release:**
```bash
sudo systemctl status lotus-light-engine
sudo journalctl -u lotus-light-engine -n 50 --no-pager
# Förväntat: noble.state = poweredOn inom 2s, ingen Permission denied
```
