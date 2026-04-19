---
name: journalctl fungerar inte på Pi:n
description: journalctl returnerar alltid "No journal files were found". Använd systemctl status -l, tail på loggfil, /api/ble/diagnostics, eller grep BLE_BUILD_TAG i bundlen för att verifiera deployad kod.
type: constraint
---
`journalctl --user -u lotus-light-engine` (och varianter med `-f`, `--since`, etc.) ger ALLTID `No journal files were found` på den här Pi:n — bekräftat 2026-04-18. `Storage=` i journald.conf är satt till `none` eller `volatile` utan persist, eller user-journal är inte aktiverat.

**Sluta föreslå journalctl som debug-verktyg.** Det slösar tid varje gång.

**Använd istället, i prioritetsordning:**

1. **Verifiera deployad build-tag i bundlen (snabbast, kräver inga loggar alls):**
   ```bash
   grep -o "BLE_BUILD_TAG[^'\"]*['\"][^'\"]*['\"]" /opt/lotus-light/pi/dist/ble/state.js | head -1
   ```
   Visar exakt vilken kod som ligger på disk. Jämför mot förväntad tag i `pi/src/ble/state.ts`.

2. **systemctl status (visar de sista loggraderna direkt utan journalctl):**
   ```bash
   systemctl --user status lotus-light-engine --no-pager -l
   ```

3. **Verifiera att engine startats om efter update:**
   ```bash
   systemctl --user show lotus-light-engine -p ActiveEnterTimestamp -p MainPID
   stat -c '%y %n' /opt/lotus-light/pi/dist/index.js
   ```
   `ActiveEnterTimestamp` ska vara NYARE än mtime på `index.js`. Om inte → engine kör gammal kod, kör `systemctl --user restart lotus-light-engine`.

4. **HTTP-diagnostics-endpoint (rik runtime-info):**
   ```bash
   curl -s http://localhost:3051/api/ble/diagnostics | jq
   ```
   Innehåller `buildTag`, `nobleRawState`, `effectiveAdapterState`, `connectionLog` (50 senaste BLE-events), `workaroundCounters`.

5. **UI-eventloggen:** `http://<pi>:3001` — BLE-diagnostik-sidan längst ner.

6. **Isolerad noble-scan utan motorn:**
   ```bash
   node /opt/lotus-light/pi/scripts/ble-diag.mjs
   ```

7. **Manuell stdout-körning (sista utvägen):**
   ```bash
   systemctl --user stop lotus-light-engine
   cd /opt/lotus-light/pi && node dist/index.js
   ```

**Lotus körs som user-service på Pi Zero 2W:**
- WorkingDirectory: `/opt/lotus-light/pi`
- ExecStart: `/usr/bin/node /opt/lotus-light/pi/dist/index.js`
- Service-fil: `~/.config/systemd/user/lotus-light-engine.service`
- Engine port: 3051, UI port: 3001
- StandardOutput=journal (men journald sparar inget → loggar finns BARA i `systemctl status -l`, max ~10-20 senaste rader)
