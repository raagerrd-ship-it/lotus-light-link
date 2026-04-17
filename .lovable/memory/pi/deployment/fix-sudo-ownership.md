---
name: fix-sudo ownership
description: fix-sudo.sh ägs av Pi Control Center (public/pi-scripts/fix-sudo.sh). Lotus har bara en thin wrapper som anropar PCC-versionen.
type: feature
---
fix-sudo.sh (verifierar/reparerar /etc/sudo.conf, /usr/bin/sudo, /etc/sudoers, /etc/sudoers.d/) är OS-nivå och bor i Pi Control Center: `public/pi-scripts/fix-sudo.sh`. Lotus `pi/scripts/fix-sudo.sh` är en thin wrapper som letar efter PCC-scriptet på `/opt/pi-dashboard/public/pi-scripts/fix-sudo.sh` (och fallbacks i `/var/www/`) och kör det. Om PCC saknas: varna och exit 0 (blockera inte Lotus-install).

**Why:** Sudo-health delas av alla tjänster PCC installerar (Lotus, Cast Away, Brew Monitor). Att ha det i en tjänst skulle leda till duplicering och drift mellan versioner.

**How to apply:** Ändra aldrig logiken i Lotus-wrappern. Alla riktiga ändringar görs i PCC. När nya tjänster läggs till, anropa samma PCC-script — duplicera inte.
