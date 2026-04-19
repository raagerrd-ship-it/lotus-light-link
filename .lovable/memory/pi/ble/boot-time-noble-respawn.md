---
name: Boot-time noble respawn vid wedged state
description: Om noble inte når poweredOn inom 5s vid boot triggas triggerNobleRespawn() — bevisat fungerande då fresh noble-process når poweredOn på 310ms (SSH-test 2026-04-19)
type: feature
---
**Problem:** Engine-processen kan starta med noble fastnat i `state="unknown"` permanent — libuv-racen vid boot åter upp noble's enda `stateChange`-event (mem://pi/ble/noble-statechange-event-loop-race). Då blockeras alla `startScanningAsync`/`connectAsync`-anrop och returnerar timeout efter 10s.

**Bevis (SSH-test 2026-04-19):**
- Engine-process (wedged): `phase=starting raw=0` i 9s, sen `noble inte poweredOn inom 10s: Timeout`
- Fresh noble-process (`scripts/noble-scan-isolated.mjs`): `stateChange→poweredOn` på +310ms, ELK-BLEDOM01 hittad på +1424ms, 100+ discover-events på 2.6s

**Fix (pi/src/index.ts STEP B.1):**
1. Race `waitForFirstStateChange(5000)` mot `noble.waitForPoweredOnAsync(5000)` — kort timeout, inte 30s
2. Efter race: läs `getNobleRawState()` 
3. Om varken cached state eller raw är `'poweredOn'` → `triggerNobleRespawn(reason)` → `process.exit(1)` → systemd ger oss en fresh process
4. Cooldown (60s) i `watchdog.ts` förhindrar oändlig boot-loop om OS är trasigt

Build-tag: `2026-04-19/boot-time-noble-respawn`.
