---
name: Service-user måste vara pi (default), inte root/lotus/SUDO_USER
description: setup-lotus.sh + update-services.sh prioriterar `pi` som engine-user. Override via LOTUS_SERVICE_USER eller befintlig systemd User=. Aldrig root, aldrig "första bästa SUDO_USER".
type: constraint
---
PCC kör scripten som root → SUDO_USER kan vara root eller saknas. Att då fallback:a på `lotus` eller "första gruppen som finns" gör att chown sätter fel ägare → engine (som körs som `pi`) får EACCES.

**Resolve-prio (båda scripten):**
1. `LOTUS_SERVICE_USER` (env override)
2. `User=` i `/etc/systemd/system/lotus-light-engine.service` (om ≠ root och usern existerar)
3. `pi` ← default
4. `lotus`
5. `SUDO_USER`, `USER`
6. `root` (sista utväg, varnar)

Verifierat 2026-04-25.
