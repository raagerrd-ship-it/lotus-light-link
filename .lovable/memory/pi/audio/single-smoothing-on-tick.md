---
name: Enkel smoothing på tick-takt
description: Release-smoothing körs ENBART i engine.tickInner @ 50Hz. alsaMic levererar rå RMS. Default releaseAlpha=0.15 (höjt från 0.025).
type: feature
---
**Pipeline efter 2026-04-24-fixen:**
```
Audio → FFT @ 100Hz (rå RMS) → tickInner @ 50Hz (EMA-smoothing) → dynamics → BLE
```

**Varför:**
- Tidigare: dubbel EMA (alsaMic + tickInner) → kvadrerad effektiv alpha → slött
- Mellansteg (bara alsaMic-smoothing): FFT @ 100Hz aliaserades mot tick @ 50Hz → flimmer
- Nu: en EMA på tick-takt → filtret synkat med output-rate, inget alias

**Kod:**
- `pi/src/alsaMic.ts`: `setMicSmoothing` är no-op (bevarad för bakåtkomp). Bands-objekt får `rawBass/rawMidHi/rawTotal` direkt.
- `pi/src/piEngine.ts`: `private smoothed = 0` återinförd. Smoothing-block ligger före dynamics i `tickInner`. Resetas i `setPlaying(false)`, `onBleConnected` (active mode) och `sanitizeState`.

**Default-värden i DEFAULT_CAL:**
- `attackAlpha: 1.0` (oförändrat — direkt respons på stigande)
- `releaseAlpha: 0.15` (höjt från 0.025 — kompenserar att filtret inte längre kvadreras)

**Tuning-tips:** Om flimmer återkommer vid konstant ton → höj Release-slidern. Om för slött → sänk. Om kvarstående flimmer behövs djupare fix (t.ex. flytande fönster på rawBass mot FFT-bin-spridning).
