---
name: HOP_SIZE 480 = 100Hz FFT, synkad mot tick=20ms
description: HOP_SIZE är hårdkodat till 480 frames (10.0ms @ 48kHz) → exakt 100Hz FFT. Vid tickMs=20ms ger detta 2 FFT-frames per tick deterministiskt — senaste frame max 10ms gammal när engine läser.
type: feature
---
**Beslut (2026-04-23):** HOP=480 (var 512). FFT-takt 100Hz exakt, synkad 2:1 mot tickMs=20ms (50pps).

**Varför:** HOP=512 gav ~93Hz → 1.87 FFT-frames per tick → ibland 1, ibland 2 frames mellan ticks → ojämn färskhet på FFT-data när engine läser. HOP=480 ger exakt 2 frames/tick → deterministiskt, jämn transient-respons.

**Hur det inte överbelastar BLE:** `piEngine.onFFTFrame` har en gate `if (elapsed >= tickMs) tickInner()`. FFT-callbacken kör 100Hz men tickInner triggas bara på tickMs-takt (50Hz @ 20ms tick) → BLE-writes oförändrade.

**CPU-kostnad:** ~10% på Pi Zero 2W (var ~9% @ HOP=512). Vendor-bufferten 8× period (46ms) täcker värsta GC-pausen → ingen overrun-spam.

**FFT-storlek oförändrad:** N=1024 i fftRadix2.ts. Bara hop-stegen mellan FFTer ändras → bin-bredd (~47Hz) oförändrad.

**API-kompat:** `setTickHopMs(tickMs)` är fortsatt en no-op men behållen så piEngine inte kraschar.

**Filer:** pi/src/alsaMic.ts (HOP_SIZE konstant).
