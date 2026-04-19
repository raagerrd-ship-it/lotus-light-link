---
name: Pi port allocation — Lotus engine API på 3051
description: Engine API lyssnar på 3051 (curl-verifierat 2026-04-19). configServer-loggen "listening on :3050" är en SEPARAT inre server, inte BLE-API:et. Använd alltid 3051 för /api/ble/*.
type: feature
---
**Korrekt portallokering på Pi:n (curl-verifierat 2026-04-19):**

| Port | Service | Anteckning |
|------|---------|------------|
| 3000 | UI (lotus-light-ui static) | Vite dist-mappen |
| 3050 | configServer (intern) | Loggar `[Config] Server listening on :3050` — INTE engine API:et |
| **3051** | **Engine API (lotus-light-engine)** | ALLA /api/ble/* + /api/health + /api/diagnostics |
| 3053 | Sonos Gateway (Cast Away) | Extern, inte vår process |

**Verifierat:** `curl localhost:3050/api/ble/connect` → `Connection refused`. `curl localhost:3051/api/ble/connect` → JSON-svar.

UI använder `window.location.port + 50` (apiBase.ts) → UI på 3001 ger engine på 3051. (Alt: UI på 3000 → engine 3050 om PORT-env satt.) På Pi:n är produktionskonfigen UI=3001, engine=3051.

**Rätt curl-kommandon:**
```bash
curl -X POST http://localhost:3051/api/ble/connect
curl -s http://localhost:3051/api/ble/diagnostics | python3 -m json.tool
curl -s http://localhost:3051/api/ble/log
curl -s http://localhost:3051/api/health
```

**Verifiera vilken port engine faktiskt använder:**
```bash
sudo ss -tlnp | grep LISTEN | grep -E '30[0-9]+'
systemctl --user show lotus-light-engine -p Environment
```

**OBS:** Loggraden `[Config] Server listening on :3050` är förvillande — det är configServer (sub-modul), inte huvud-API:et. Lita inte på den för portidentifiering.
