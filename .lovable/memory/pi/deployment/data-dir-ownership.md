---
name: /opt/lotus-light/pi/data måste ägas av TARGET_USER
description: Engine kraschar vid boot med EACCES på mkdir /opt/lotus-light/pi/data om PI_DIR ägs av root. setup-lotus.sh måste chown:a APP_DIR + pre-skapa data/ INNAN service startar.
type: constraint
---
Engine kör som `User=pi` (system-service) men releasen packas upp via `sudo cp` → root:root. `installLocalStorageShim` kallar `mkdirSync('/opt/lotus-light/pi/data')` som första instruktion → EACCES → exit 1 → auto-restart loop.

**Setup-skriptet MÅSTE göra detta innan systemctl restart:**
```bash
sudo mkdir -p "$PI_DIR/data"
sudo chown -R "$TARGET_USER:$TARGET_GROUP" "$APP_DIR"
```

Verifierat fix 2026-04-20 i pi/setup-lotus.sh (steg 3a).
