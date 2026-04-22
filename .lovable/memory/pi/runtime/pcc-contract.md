---
name: PCC service contract
description: Pi Control Center äger runtime, portar, resurser, logs, config och behörigheter. Tjänsten äger bara appkod + dependencies.
type: constraint
---
**PCC owns. Service obeys.**

### Service-ansvar (Lotus)
- Egna `node_modules` per tjänst (aldrig globala/shared)
- Egen appkod + native moduler (rebuildas mot PCC:s Node v24 vid install)
- Health endpoint: `GET /api/health` → `{ status, uptime, memory.rss, version }`
- Lyssnar på SIGTERM och stänger ner rent (engine.stop, mic.stop, sonos.stop, ble.disconnect)
- Releasar via `dist.tar.gz` med färdigbyggd kod + prod-deps

### PCC tillhandahåller (env)
- `PORT` — engine-port (PCC tilldelad). Fallback-kedja: `PORT` → `ENGINE_PORT` → `BACKEND_PORT` → `UI_PORT + 50` → 3050
- `UI_PORT` — UI-port. Engine räknar `UI_PORT + 50` för fallback om PORT saknas
- `PCC_CONFIG_DIR` — config/secrets storage. `storage.ts` föredrar denna före `LOTUS_DATA_DIR` och hårdkodad path
- `PCC_LOG_DIR` — logg-katalog (för fil-logg om vi skulle byta från stdout)
- `PCC_CORE` / `CPU_CORE` — CPU-affinitet (default 1)

### services.json deklarerar
- `permissions: ["bluetooth", "audio", "network"]` — krävs för noble + ALSA + Sonos SSE
- `runInstallOnRelease: true` — kör setup-lotus.sh vid varje release för native rebuild
- `manageService: false` på engine — PCC äger systemd-tjänsten

### Fallback-läge (ingen PCC)
- `setup-lotus.sh` skapar EGEN systemd system-service `lotus-light-engine.service` när skriptet körs manuellt — endast om PCC inte hanterar tjänsten. PCC:s release-flow ska helst skippa denna sektion (TODO: detektera `PCC_MANAGED=1` env och no-op).
- Installerar Node 24 om saknas. Med PCC ska detta redan finnas — skriptet hoppar över om `node -v` ≥ 24.

### Symptom om kontraktet bryts
- Hårdkodad port → portkonflikt med annan PCC-tjänst
- Hårdkodad data-dir → config försvinner vid PCC-flytt mellan releases
- Egen Node-install → ABI-mismatch mot native noble (state=unknown)
- Ingen SIGTERM → orphan BLE-anslutningar efter PCC-restart
