---
name: HOP_SIZE 600 = 80Hz FFT, synkad mot tick=25ms
description: HOP_SIZE är hårdkodat till 600 frames (12.5ms @ 48kHz) → exakt 80Hz FFT. Vid tickMs=25ms ger detta 2 FFT-frames per tick deterministiskt — senaste frame max 12.5ms gammal när engine läser.
type: feature
---
**Beslut (2026-08-20):** HOP=600 (var 480). FFT-takt 80Hz exakt, synkad 2:1 mot tickMs=25ms (40pps).

**Varför:** Regeln är HOP = tickMs/2 i samples. HOP=480 var avstämt mot gamla tickMs=20. När tickMs blev 25 gav 480 → 2.5 frames/tick → ibland 2, ibland 3 frames mellan ticks (ojämn färskhet) OCH 20% onödiga FFT:er på Zero 2W.

**Hur det inte överbelastar BLE:** `piEngine.onFFTFrame` har en gate `if (now >= _nextTickDeadline)`. FFT-callbacken kör 80Hz men tickInner triggas bara på tickMs-takt → BLE-writes oförändrade.

**CPU-kostnad:** ~8% på Pi Zero 2W (var ~10% @ HOP=480). Vendor-bufferten 8× period (46ms) täcker värsta GC-pausen.

**FFT-storlek oförändrad:** N=1024 i fftRadix2.ts. Bara hop-stegen mellan FFTer ändras → bin-bredd (~47Hz) oförändrad.

**Ändra tickMs? Ändra HOP:** 20ms → 480, 25ms → 600, 30ms → 720.

**Verifiera live:** `/api/status` → `runtime.fftFps` ska ligga ~80. Lägre = ALSA tappar samples.

**Filer:** pi/src/alsaMic.ts (HOP_SIZE konstant).
