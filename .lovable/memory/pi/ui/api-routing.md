---
name: API routing
description: Frontend-API-URL-resolution och fast port-layout på Pi:n
type: feature
---

## Port-layout på Pi:n (fast)
- 3001 = Lotus Lantern UI (statisk server)
- 3051 = Lotus Lantern engine (API, denna app)
- 3002 = Cast Away UI
- 3052 = Cast Away engine
- 3003 = Sonos UI
- 3053 = Sonos engine
- **Port 3050 finns inte** — gammal default, numera felaktig.

## apiBase-resolution (src/lib/apiBase.ts)
1. `VITE_ENGINE_URL` (full URL) om satt.
2. `VITE_ENGINE_PORT` override annars.
3. `window.location.port + 50` — funkar när UI serveras på 3001 → API 3051.
4. **Fallback om ingen explicit port** (t.ex. Lovable-preview på 443): `DEFAULT_ENGINE_PORT = 3051`.

## Viktigt
Tidigare version räknade `Number('') || 3000 + 50 = 3050` på Lovable-preview. Det gav anrop till port 3050 som inte finns och all UI föll med "Failed to fetch". Fallbacken måste vara 3051.
