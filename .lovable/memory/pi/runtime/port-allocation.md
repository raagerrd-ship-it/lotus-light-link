---
name: Pi port allocation — Lotus engine på 3051
description: Lotus light engine lyssnar på port 3051 (inte 3050). 3050=Sonos Gateway/Cast Away, 3051=Lotus engine, 3052=Pi #2 brew monitor. Curl och diagnostik MÅSTE använda 3051.
type: feature
---
Portallokering på Pi:n (måste alltid komma ihåg vid SSH-debug):

- **3050** — Sonos Gateway / Cast Away Web (mediabrygga)
- **3051** — Lotus light engine (BLE + audio + UI-API) ← detta projekt
- **3052** — Pi #2 brew monitor (fermentation controller)

Vid debug:
- `curl http://localhost:3051/api/ble/diagnostics` (INTE 3050)
- `curl http://localhost:3051/api/status`
- `ss -tlnp | grep 3051` för att verifiera att engine lyssnar

UI:t räknar ut API-URL via `window.location.port + 50` (se mem://pi/ui/api-routing) — det stämmer för Cast Away/Sonos-fallet, men på Pi:n direkt är Lotus engine på fast port 3051.
