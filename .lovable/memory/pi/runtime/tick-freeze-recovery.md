---
name: Tick-frysning — instrumentering + per-delsystem soft recovery
description: v1.0.750: playback-watchdogen diagnostiserar mic vs BLE (audioCbs/engineTicks/tickOk) och återställer just det stallade delsystemet. Mic-stall → restartCapture(), BLE-stall → reconnect. Exit(1) först efter 3 riktade försök.
type: feature
---
**Problem (v1.0.749):** hard-restart ~1×/10h med `playback-watchdog-stuck: tickOk frozen 8000ms after soft recovery` (~5 s nere + UI-reload). Inte minne, inte CPU. Gamla watchdogen tittade BARA på `bleStats.tickOkCount` och "soft recovery" var alltid BLE-reconnect — hjälpte inte när ALSA-capturen slutade leverera audio-callbacks (utan att fyra `error`/`close`).

**Instrumentering (`runtimeHealth.ts`):**
- `noteNativeCall(op, ms, ctx)` → `maxNativeCallMs`, `slowNativeCallTotal`, `lastSlowNativeCall`; loggar throttlat vid >200 ms. Exponeras i `/api/status.runtime`.
- `engineTickTotal` (monoton) + `msSinceLastTick()` skiljer "motorn tickar men BLE levererar inte" från "motorn tickar inte alls".
- `alsaMic.onAudioData` tidsstämplas helt (`alsa-audio-cb`). `sendToBLE` mäter den SYNKRONA delen av `writeAsync` → `bleStats.writeSyncMaxMs` / `writeSyncSlowCount`.

**Icke-blockerande:**
- `WRITE_PENDING_TIMEOUT_MS` 1000 → **150 ms**: en hängande write kostar en frame, inte en sekund.
- `piEngine.onFFTFrame`: BLE-pre-gaten får blockera max **500 ms** obrutet (`_bleGateSince`); därefter körs `tickInner` ändå så smoothing/beat/dynamics hålls levande (framen dör som `busy`).
- `alsaMic.isMicStalled()` (ingen audio-cb på 1500 ms) + `restartCapture(reason)` — stänger och startar capturen utan process-restart. Pollas från 1 Hz-schedulern.

**Watchdog (`index.ts`):** vid 8 s frusen `tickOk` dumpas hela kontexten (engineTicks, audioCbs, lastTickAge, writePending+age, slotLocked, bleBusySkips, writeSyncMax, maxNativeCall). Sedan riktad recovery: mic frusen → `restartCapture()`, annars → `scheduleAutoReconnect()`. `exit(1)` först efter 3 misslyckade riktade försök.

Aldrig återinföra: await på BLE-write i tick-loopen, eller en generisk "soft recovery" som bara reconnectar BLE.
