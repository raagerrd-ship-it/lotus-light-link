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
- `PCC_DATA_DIR` — persistent state (profiler, kalibrering, BLE-state, cache). `storage.ts` lägger ALLT state här.
- `PCC_CONFIG_DIR` — settings/config. `storage.ts` lägger keys i `SETTINGS_KEYS` här (övrigt → DATA_DIR).
- `PCC_LOG_DIR` — logg-katalog (för fil-logg om vi skulle byta från stdout)
- **Förbjudet:** skriva runtime-state under `/opt/` — den katalogen kan ersättas vid update.
- `PCC_CORE` / `CPU_CORE` — CPU-affinitet (default 1)

### services.json deklarerar
- `permissions: ["bluetooth", "audio", "network"]` — krävs för noble + ALSA + Sonos SSE
- `runInstallOnRelease: true` — kör setup-lotus.sh vid varje release för native rebuild
- `manageService: false` på engine — PCC äger systemd-tjänsten

### PCC_MANAGED-flaggan
- PCC sätter `PCC_MANAGED=1` när den kör `setup-lotus.sh` vid release.
- Skriptet kör då ALLTID systemnivå-prep (grupper, udev-regel för rfkill, ägarskap, native rebuild) men hoppar HELT över: skriva `/etc/systemd/system/lotus-light-engine.service`, `systemctl daemon-reload`, `enable`, `restart`. PCC restartar tjänsten själv.
- Om en legacy unit-fil finns kvar från ett tidigare standalone-install lämnas den orörd — manuell `sudo rm /etc/systemd/system/lotus-light-engine.service` krävs för rensning. Risk: om legacy-tjänsten är `enabled` startar den parallellt med PCC:s tjänst vid boot → portkonflikt.

### Fallback-läge (ingen PCC)
- `setup-lotus.sh` utan `PCC_MANAGED=1` skapar egen systemd system-service med User=$TARGET_USER, SupplementaryGroups=netdev bluetooth audio, AmbientCapabilities=CAP_NET_RAW/ADMIN/SYS_NICE.
- Installerar Node 24 om saknas. Med PCC ska detta redan finnas — skriptet hoppar över om `node -v` ≥ 24.

### Symptom om kontraktet bryts
- Hårdkodad port → portkonflikt med annan PCC-tjänst
- Hårdkodad data-dir → config försvinner vid PCC-flytt mellan releases
- Egen Node-install → ABI-mismatch mot native noble (state=unknown)
- Ingen SIGTERM → orphan BLE-anslutningar efter PCC-restart
