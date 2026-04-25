---
name: Lotus Light kör manual-update only — aldrig auto-deploy
description: services.json har runInstallOnRelease:false, autoUpdate:false, manualUpdateOnly:true. PCC respekterar dessa flaggor och triggar update endast via UI-knapp eller SSH. Sätt aldrig tillbaka till true utan användarens uttryckliga begäran.
type: constraint
---
**Användaren vill inte ha auto-update.** Engine-restart vid varje release orsakade nedkopplingar (5–15s) + EACCES-bugg på root-ägda filer som upplevdes som "tappade inställningar".

**`pi/services.json` (oförhandlingsbart utan ny användarbegäran):**
```json
"runInstallOnRelease": false,
"autoUpdate": false,
"manualUpdateOnly": true
```

**Manuell update sker via:**
- PCC UI → service "Lotus Light" → "Update"-knapp
- SSH: `sudo bash /opt/lotus-light/pi/update-services.sh`

Ingen `lotus-update.timer` installeras eller används. Om du ser referenser till den i README/scripts → ta bort dem.

Verifierat 2026-04-25.
