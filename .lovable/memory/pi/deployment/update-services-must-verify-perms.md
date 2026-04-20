---
name: update-services.sh måste verifiera BLE-perms varje update
description: Tidigare körde update-services.sh BARA setup-lotus.sh om service-filen saknades. Resultat: caps/groups/bluetoothd-fixar applicerades aldrig på efterföljande releases. Nu körs verifieringen idempotent varje update.
type: constraint
---
**Symptom (2026-04-20):** UI-loggen visar `rfkill: cannot open /dev/rfkill: Permission denied` + `hciconfig: Operation not permitted` trots att setup-lotus.sh innehåller alla fixar. Engine startar men noble fastnar i `state=unknown`.

**Rotorsak:** `update-services.sh` hade logiken:
```bash
if [ ! -f /etc/systemd/system/lotus-light-engine.service ]; then
  bash setup-lotus.sh
else
  echo "System-service intakt ✓"
fi
```
Om service-filen skapades EN gång (av en gammal buggig version utan `SupplementaryGroups` eller med fel `User=`) skippades hela permissions-blocket på alla efterföljande updates → caps på node-binären, gruppmedlemskap, bluetoothd-start applicerades aldrig.

**Fix (build 2026-04-20/update-perms-every-release):**
1. `update-services.sh` kör ALLTID en billig verify-loop varje update:
   - `getcap node` → setcap om CAP_NET_RAW saknas
   - `id -nG $TARGET_USER` → usermod -aG om netdev/bluetooth saknas
   - `systemctl is-active bluetooth` → enable+start om inaktiv
2. Om service-filen saknar `SupplementaryGroups=netdev bluetooth` → tvinga full setup-lotus.sh.
3. `setup-lotus.sh` använder `$TARGET_USER` (inte hardkodat `pi`) i service-filen.
4. `pi/src/index.ts` loggar `[Boot/Perms]` med uid/gid/groups/CapEff/rfkill-access så det syns i UI:t direkt.

**Verifiera efter release:**
- UI:t Engine-logg ska visa `[Boot/Perms] groups: pi netdev bluetooth ...` och `/dev/rfkill: read+write OK ✓`
- Om `NO ACCESS` står där → reboot Pi:n (gruppändring kräver ny login-session för system-service).
