---
name: PCC äger lagringsplatser — appen får aldrig spara state i /opt
description: Använd PCC_DATA_DIR (state), PCC_CONFIG_DIR (settings), PCC_LOG_DIR (loggar). /opt är read-only/replaceable. storage.ts separerar settings från state och auto-migrerar från legacy-paths.
type: constraint
---
**PCC äger katalogerna. Appen läser dem från env, hårdkodar aldrig paths.**

| Env | Syfte |
|---|---|
| `PCC_DATA_DIR` | State, profiler, kalibrering, parade BLE-enheter, cache, user data |
| `PCC_CONFIG_DIR` | Inställningar (settings) |
| `PCC_LOG_DIR` | App-egna loggar (vi använder stdout/journal idag) |

**Förbjudet:** Skriva något under `/opt/` runtime. `/opt/lotus-light/` är programkod — kan ersättas vid OTA-update.

**Implementation (`pi/src/storage.ts`):**
- DATA_DIR = `PCC_DATA_DIR` || fallback (`$HOME/.local/share/lotus-light` eller `/var/lib/lotus-light`).
- CONFIG_DIR = `PCC_CONFIG_DIR` || DATA_DIR.
- `SETTINGS_KEYS`-set styr vilken katalog en key hamnar i. Allt utanför listan = state → DATA_DIR.
- Auto-migration: om mål-dir saknar *.json letar den i kända legacy-paths (`/opt/lotus-light/pi/data`, gamla env-overrides) och kopierar över. Skyddar mot förlorade profiler vid PCC-flytt.

**Skyddade kontrakt (oförändrade):**
1. `pi/update-services.sh` får ALDRIG röra data/config-kataloger.
2. `pi/setup-lotus.sh` får endast `mkdir -p` + `chown -R` på data — aldrig delete/overwrite.

Verifierat 2026-04-22.
