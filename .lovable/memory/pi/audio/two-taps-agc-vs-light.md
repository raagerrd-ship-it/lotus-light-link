---
name: Två tappar — AGC för analysen, fast gain för ljuset
description: Ringbufferten är O-GAINAD. Analys-tappen = ANALYSER_PREGAIN 30 + analysatorns AGC (autoGainTarget 0.8). Ljus-tappen = egen linjär RMS (130 ms EMA) × micGain. Aldrig levelVU till ljuset.
type: feature
---
**Sedan v1.0.744 (2026-08-24).** Ersätter "En ärlig linjär gain"-regeln om att
AGC:n ska vara låst: AGC:n är TILLBAKA, men BARA på analys-tappen.

- `ringBuf` innehåller rå mic-signal + hi-shelf. **Ingen `micGain` här.**
- **Analys:** `analyserScratch[i] = ringBuf[...] * ANALYSER_PREGAIN` (30, fast —
  AGC:ns interna gain är klampad 0.5–20× och rå mic-RMS är för svag utan lyft).
  `createAnalyser({ autoGainTarget: 0.8 })`, `setGainLock(false)` → siktar ~80 %
  med headroom, klipper inte → pålitlig beat/drop-detektion.
- **Ljus:** `lightRawRms` = 130 ms EMA av block-RMS på RÅ samples, uppdaterad per
  ALSA-callback. `emitBands`: `amp = min(1, lightRawRms * micGain)`.
  `bassRms/midHiRms` = amp × spektral andel ur `specAbs` (andel, aldrig nivå).

**Aldrig:** använd `frame.level`/`frame.levelVU` för ljuset — de är AGC:ade och
normaliserar bort användarens gain (symptom: gain 40→75 ändrade inget, output
pinnad ~50 %). Aldrig applicera användarens gain på rå-PCM/ringen igen (symptom:
analysator-input pinnad 100 %).

**Input-baren** visar `latestBands.totalRms` (= ljus-tappens linjära nivå), inte
`max(bass, midHi)` — de är andelar mot 0.5 och pinnas nära 1.0.
