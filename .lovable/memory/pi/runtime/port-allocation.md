---
name: Lotus engine API lyssnar på port 3050, inte 3051
description: Engine har en enda port (CONFIG_PORT, default 3050) som hanterar både config OCH alla /api/ble/*-rutter. UI är på 3000, engine API på 3050. Det finns ingen 3051.
type: feature
---
**Korrekt portallokering på Pi:n (uppdaterad 2026-04-19 efter live-verifiering):**

| Port | Service | Anteckning |
|------|---------|------------|
| 3000 | UI (lotus-light-ui static) | Vite dist-mappen |
| 3050 | Engine API (lotus-light-engine) | ALLA /api/* rutter, inkl. /api/ble/connect, /api/ble/diagnostics, /api/health |
| 3053 | Sonos Gateway (Cast Away) | Extern, inte vår process |

**Det finns INGEN port 3051.** Tidigare antagande att Lotus var på 3051 var FELAKTIGT — bekräftat via boot-logg `[Config] Server listening on :3050` och via `curl localhost:3051 → connection refused`.

UI använder `window.location.port + 50` (apiBase.ts), så UI på 3000 → engine på 3050. Engine binder bara CONFIG_PORT (en port, en process, alla rutter där).

**Rätt curl-kommandon:**
```bash
curl -X POST http://localhost:3050/api/ble/connect
curl -s http://localhost:3050/api/ble/diagnostics | python3 -m json.tool
curl -s http://localhost:3050/api/ble/log
curl -s http://localhost:3050/api/health
```

**Verifiera vilken port engine faktiskt använder:**
```bash
systemctl --user show lotus-light-engine -p Environment
sudo ss -tlnp | grep LISTEN | grep -E '30[0-9]+'
```

Engine sätter porten via: `process.env.PORT ?? process.env.BACKEND_PORT ?? 3050` (se pi/src/index.ts rad 47).
