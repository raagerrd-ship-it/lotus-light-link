---
name: HOP_SIZE 512 fast, frikopplad från tickMs
description: HOP_SIZE är hårdkodat till 512 frames (~10.7ms @ 48kHz). FFT körs ~93Hz, engine.tickInner gatear på tickMs → BLE-takt oförändrad men bättre transient-respons.
type: feature
---
**Beslut (2026-04-20):** Tidigare HOP=tickMs (1:1 FFT→tick, ~25Hz @ 40ms tick). Nu HOP=512 fast, FFT körs ~93Hz oavsett tick.

**Varför:** Snabbare transient-detektering — peakar fångas inom 10.7ms istället för upp till 40ms. Engine ser senaste FFT-frame när tickInner kör.

**Hur det inte överbelastar BLE:** `piEngine.onFFTFrame` har en gate `if (elapsed >= tickMs) tickInner()`. FFT-callbacken kör 93Hz men tickInner triggas bara på tickMs-takt (25Hz @ 40ms) → BLE-writes oförändrade.

**CPU-kostnad:** ~9% på Pi Zero 2W (var ~2.5%). Vendor-bufferten 8× period (43ms) täcker värsta GC-pausen → ingen overrun-spam.

**API-kompat:** `setTickHopMs(tickMs)` är nu en no-op men behållen så piEngine inte kraschar.

**Filer:** pi/src/alsaMic.ts (HOP_SIZE konstant + setTickHopMs no-op).
