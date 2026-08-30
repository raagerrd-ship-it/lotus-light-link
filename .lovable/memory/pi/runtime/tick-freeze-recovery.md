---
name: Tick-frysning — instrumentering + per-delsystem soft recovery
description: engineTickTotal mäter motor-liveness även bakom legitim playing/BLE-grind; wdb-frys får bara agera när både tick och audio-callbacks avancerar.
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

**FIX 17 (v1.0.792):** `noteTick()` körs vid varje `tickInner()`-anrop före
playing/BLE/mic-safe-grindarna. `engineTickTotal` betyder att motorn lever, inte att
en ljusframe levererades; `_diag.tickCount` är fortsatt den produktiva mätaren.
`wdb-låst` får endast byggas upp när både engine-ticks och ALSA audio-callbacks
har avancerat sedan föregående 2 s-prov. En detektor får aldrig gata på en signal
som dess egen åtgärd eller legitim vila stoppar. Owner-repair kräver dessutom 3 s
stabil BLE/owner-avvikelse för att inte flappa under anslutningsförsök.

Aldrig återinföra: `noteTick` bakom output-grinden, wdb-recovery utan tick+audio-liveness, await på BLE-write i tick-loopen, eller en generisk "soft recovery" som bara reconnectar BLE.
