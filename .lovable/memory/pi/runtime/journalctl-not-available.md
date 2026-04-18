---
name: journalctl fungerar inte på Pi:n
description: journalctl --user -u lotus-light-engine returnerar alltid "No journal files were found". Använd inte journalctl för debug — kör curl mot /api/ble/diagnostics, läs eventloggen i UI:t, eller print:a till stdout och läs via systemd-cat / direkt processkonsol.
type: constraint
---
`journalctl --user -u lotus-light-engine` (och varianter med `-f`, `--since`, etc.) ger ALLTID `No journal files were found` på den här Pi:n — bekräftat 2026-04-18. Troligtvis är `Storage=` i journald.conf satt till `none` eller `volatile` utan persist, eller user-journal är inte aktiverat (`systemctl --user enable systemd-journald` saknas / pi-användarens journal-katalog finns inte).

**Sluta föreslå journalctl som debug-verktyg.** Det slösar tid varje gång.

**Använd istället:**
- `curl -s http://localhost:3051/api/ble/diagnostics | jq` — innehåller `buildTag`, `nobleRawState`, `effectiveAdapterState`, `connectionLog` (ring buffer med 50 senaste BLE-events), `workaroundCounters`
- UI:t på `http://<pi>:3001` har eventloggen synlig längst ner på BLE-diagnostik-sidan
- `node /opt/lotus-light/pi/scripts/ble-diag.mjs` — kör en isolerad noble-scan utan att röra motorn
- Om vi MÅSTE ha stdout: kör motorn manuellt i en SSH-session efter `systemctl --user stop lotus-light-engine`: `cd /opt/lotus-light/pi && node dist/index.js`

**Lotus körs som user-service på Pi Zero 2W:**
- WorkingDirectory: `/opt/lotus-light/pi`
- ExecStart: `/usr/bin/node /opt/lotus-light/pi/dist/index.js`
- Service-fil: `~/.config/systemd/user/lotus-light-engine.service`
- Engine port: 3051, UI port: 3001
