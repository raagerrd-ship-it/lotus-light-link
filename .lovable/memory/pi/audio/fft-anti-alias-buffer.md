---
name: Anti-alias rolling average över FFT-frames i alsaMic
description: 3-frame rolling average på bassRms/midHiRms/totalRms i processFFT (~30ms fönster) eliminerar 50Hz tick × 100Hz FFT-aliasing. flux passerar oförändrad till onset-detektorn. Latens-tillägg <20ms.
type: feature
---
**Beslut (2026-04-26):** Pre-allokerade Float32Array(3) ringbuffrar i `pi/src/alsaMic.ts` glättar bands-RMS över 3 senaste FFT-frames innan de exponeras via `latestBands`. EMA i `engine.tickInner` ligger oförändrad ovanpå.

**Varför:** Tick @ 50Hz stickprovar FFT @ ~100Hz → frame-to-frame-brus blev synliga hopp i ljuset trots EMA i engine. Anti-alias-fönstret (~30ms) ligger under perceptuell sync-tröskel (~50ms) och kortare än hi-hat-mellanrum (~80ms).

**Kritiskt:** `flux` smoothas EJ — onset-detektion (processOnset @ 100Hz) behöver skarpa transienter för kick-detektion.

**Reset:** `resetFluxState()` nollställer även anti-alias-historiken så tystnadsperioder inte blandas in.

**Konstanter:** `FFT_SMOOTH_WINDOW = 3`. RAM-tillägg ~36 bytes. Noll allokering i hot path.
