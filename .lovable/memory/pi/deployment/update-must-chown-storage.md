---
name: update-services.sh måste chown:a APP_DIR efter varje deploy
description: cp -r som root skapar root-ägda filer. Engine kör som $TARGET_USER → EACCES på storage.json → alla /api/*-saves returnerar 500. Fix: chown -R + mkdir pi/data efter varje update.
type: constraint
---
**Symptom (2026-04-25):** UI visar "Sparning misslyckades: 8/8 misslyckades" där `/api/profiles`, `/api/tick-ms`, `/api/mic-gain`, `/api/dimming-gamma`, `/api/idle-color`, `/api/sonos-gateway`, `/api/auto-tv-mode`, `/api/mic-device` alla returnerar `500`. Engine själv kör fint, det är bara skrivning som failar.

**Rotorsak:** `update-services.sh` körs som root (via PCC). `cp -r $TMP_DIR/... $PI_DIR/...` skapar nya filer/mappar med ägare `root:root`. Engine kör som `$TARGET_USER` (lotus/pi) via systemd-uniten → `writeFileSync('storage.json')` ger `EACCES`.

`setup-lotus.sh` gör `chown -R` på `$APP_DIR` vid första install, men det körs bara på första install eller om health-check failar — inte vid varje update.

**Fix (build 2026-04-25):** I `update-services.sh`, direkt efter att tarballen kopierats in och innan engine startas om:
```bash
TARGET_USER="${SUDO_USER:-${USER:-pi}}"
TARGET_GROUP="$(id -gn "$TARGET_USER")"
mkdir -p "$PI_DIR/data"
chown -R "$TARGET_USER:$TARGET_GROUP" "$APP_DIR"
chmod -R u+rwX,g+rX "$PI_DIR/data"
```
Idempotent + billigt → kör alltid, inte bara vid health-fel.

**Verifiera efter release:**
- `ls -la /opt/lotus-light/pi/data/` → ägare ska vara `lotus:lotus` (eller `pi:pi`), INTE `root:root`
- UI:t Inställningar → ändra valfri slider och spara → ingen 500-banner
