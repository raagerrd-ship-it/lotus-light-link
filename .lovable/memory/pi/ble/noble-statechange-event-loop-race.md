---
name: Noble stateChange event loop race
description: Native modules (alsa-capture) som laddas synkront före noble.waitForFirstStateChange blockerar libuv och äter noble's enda stateChange-event på Pi Zero 2W
type: feature
---
**Problem:** noble emit:ar `stateChange` exakt EN gång via libuv strax efter `require('@stoprocent/noble')`. Om event-loopen blockeras av synkron native-init (t.ex. `import './alsaMic.js'` som drar igång C++ ALSA-bindningen) under det fönstret går eventet förlorat och `noble.state` fastnar i `'unknown'` för all framtid i den processen.

**Bevis (SSH-test 2026-04-18):**
- Fristående `node -e` script utan native-imports → `noble.state` blev `'poweredOn'` på 1.5s
- Samma noble-version i `lotus-light-engine`-tjänsten (med alsaMic top-level) → fastnade i `'unknown'` för alltid

**Fix (pi/src/index.ts):**
1. Ingen top-level `import` av `alsaMic` — bara typ-import
2. Inuti `main()`:
   - Vänta på hci0 UP (utan att röra noble)
   - `await import('./nobleBle.js')` — triggar noble's HCI-init
   - `await waitForFirstStateChange(30000)` — låt libuv köra noble's stateChange
   - **DÄREFTER** `await import('./alsaMic.js')` + tillämpa savedAlsaDevice/savedMicGain

**Regel:** Inga native-bindningar (alsa, FFI, sharp, etc.) får importeras top-level eller före `waitForFirstStateChange` har returnerat. Lazy-importera dem inuti `main()` efter noble har vaknat.
