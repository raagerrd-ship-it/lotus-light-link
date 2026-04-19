---
name: ALSA period 256 + buffer 8× period
description: Pi Zero 2W behöver periodSize=256 (~5.8ms) och buffer=8×period (~46ms) i vendor C-bindningen. 128 + 2× orsakade konstanta buffer overruns → 0% engine-output.
type: constraint
---
**Symptom (2026-04-19):** `[ALSA] Buffer overrun detected` spammade var ~5:e log-rad. Engine fick aldrig FFT-frames → output stannade på 0% trots att Sonos PLAYING och mic-mätare visade 6-8% i UI.

**Rotorsak:** Vendor-bindingen (pi/vendor/alsa-capture/capture.cc) körde med `periodSize=128` (~2.9ms) och `buffer=2×period` (~5.8ms total). På Pi Zero 2W överstiger varje JS GC-paus eller långsam BLE-write 5.8ms → ringbufferten i ALSA fylls innan vi hinner läsa → samples droppas → FFT körs aldrig.

**Lösning:**
- C-binding: `bufFrames = frames * 8` (~23ms @ p=128, ~46ms @ p=256)
- alsaMic.ts: `periodSize: 256` (~5.8ms) — väcker JS hälften så ofta

**Latens påverkas INTE** — ALSA-tråden i C läser `snd_pcm_readi` så fort den kan, bufferten är bara säkerhetsmarginal. Total mic→FFT-latens fortfarande <10ms.

**HOP_SIZE-relation oförändrad:** JS ackumulerar `HOP_SIZE = round(tickMs/2 * 44.1)` samples innan `processFFT()`. ALSA-perioden styr bara hur ofta C-tråden levererar audio-buffrar till JS — inte FFT-frekvensen.

**Kräver C-rebuild:** `cd pi/vendor/alsa-capture && npm rebuild` körs automatiskt i setup-lotus.sh / update-services.sh när vendor-mappen syncas.
