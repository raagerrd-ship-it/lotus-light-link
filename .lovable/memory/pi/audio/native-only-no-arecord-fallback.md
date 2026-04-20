---
name: Native ALSA only — arecord-fallback borttagen
description: alsaMic.ts har ingen arecord-fallback. Engine vägrar starta mic om pi/vendor/alsa-capture/build/Release/capture.node inte kan laddas. setup-lotus.sh och update-services.sh exit 1 vid build-fel.
type: constraint
---
**Beslut (2026-04-20):** Användaren prioriterar lägsta möjliga audio→BLE latens. arecord-subprocess lägger till ~30-50ms (pipe-buffring + IPC) och har dolt verkliga problem med native binding genom att "fungera lite sämre tyst".

**Konsekvenser:**
- `pi/src/alsaMic.ts` importerar bara `../vendor/alsa-capture/index.js` (+ npm-fallback). Ingen `node-record-lpcm16`. `getMicBackend()` returnerar `'alsa-vendored' | 'alsa-npm' | 'none'`.
- `startMic()` i 'none'-fallet → `handleStartFailure(...)` med tydlig fix-instruktion (kör `sudo npm rebuild` i vendor-mappen).
- `setup-lotus.sh` och `update-services.sh` `exit 1` om vendor-mappen saknas, capture.node inte kan byggas, eller capture.node inte kan laddas mot installerad Node.
- Default device är `hw:0,0` (rå hårdvara, ingen plughw-konvertering) — kräver att engine matchar exakt format soundcardet stödjer (S32_LE 48kHz stereo för INMP441/google-voicehat).
- UI-badgen (`MicBackendBadge.tsx`) renderar bara ALSA eller INAKTIV — ingen "ARECORD"-stat längre.

**Bash-bugg som var dold tidigare:** `mktemp /tmp/foo.XXXXXX.err` failar tyst — XXXXXX MÅSTE ligga sist. Fixed till `mktemp /tmp/alsa-load-test.XXXXXX`.
