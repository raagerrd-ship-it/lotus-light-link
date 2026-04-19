---
name: Scan-triggered noble respawn vid wedged state
description: Noble-respawn (process.exit→systemd) triggas från scan-knappen i scan.ts när waitForPoweredOnAsync timeoutar — INTE vid boot. Användarinitierat så vi inte respawnar i onödan.
type: feature
---
**Problem:** Engine-processen kan starta med noble fastnat i `state="unknown"` permanent — libuv-racen vid boot åter upp noble's enda `stateChange`-event (mem://pi/ble/noble-statechange-event-loop-race). Då blockeras alla `startScanningAsync`/`connectAsync`-anrop och returnerar timeout efter 10s.

**Bevis (SSH-test 2026-04-19):**
- Engine-process (wedged): `phase=starting raw=0` i 9s, sen `noble inte poweredOn inom 10s: Timeout`
- Fresh noble-process (`scripts/noble-scan-isolated.mjs`): `stateChange→poweredOn` på +310ms, ELK-BLEDOM01 hittad på +1424ms, 100+ discover-events på 2.6s

**Fix-arkitektur (efter v2 2026-04-19):**
1. **Boot (pi/src/index.ts STEP B.1):** Bara PASSIV observation — race `waitForFirstStateChange(5000)` mot `noble.waitForPoweredOnAsync(5000)`, logga resultat, **respawna ALDRIG vid boot**.
2. **Scan (pi/src/ble/scan.ts):** När användaren trycker "Sök efter enheter" och `waitForPoweredOnAsync(10_000)` failar → `triggerNobleRespawn(reason)` → `process.exit(1)` → systemd ger fresh process. Användaren trycker "Sök" igen efter ~3s och då fungerar det.
3. **Cooldown (60s, watchdog.ts):** Skydd mot dubbeltryck/loop om OS är trasigt.

**Varför scan-triggered istället för boot-time:** Om användaren inte tänkt använda BLE just nu (bara Sonos/idle) ska vi inte respawna i onödan. Respawn är användarinitierad — knyts till "Sök efter enheter"-flödet.

Build-tag: `2026-04-19/scan-triggered-noble-respawn`.
