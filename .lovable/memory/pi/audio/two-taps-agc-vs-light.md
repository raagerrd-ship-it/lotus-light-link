---
name: Två tappar — AGC för analysen, fast gain för ljuset
description: Ringbufferten är O-GAINAD. Analys-tappen = RÅ signal → analysatorns AGC (mål 0.8, maxGain 600, noiseFloor 0.0015) utan fast pre-gain. Ljus-tappen = egen linjär RMS (130 ms EMA) × micGain. Aldrig levelVU till ljuset.
type: feature
---
**Sedan v1.0.745 (2026-08-24).** Ersätter "En ärlig linjär gain"-regeln om att
AGC:n ska vara låst: AGC:n är TILLBAKA, men BARA på analys-tappen.

- `ringBuf` innehåller rå mic-signal + hi-shelf. **Ingen `micGain` här.**
- **Analys:** `analyserScratch[i] = ringBuf[...]` — RÅ, **ingen fast pre-gain**.
  `ANALYSER_PREGAIN = 30` är BORTTAGEN (v1.0.745): en fast faktor före AGC:n
  brände in klippning som AGC:n inte kan ta bort (uppmätt v1.0.743: `analyser.level`
  pinnad 100 → beat-conf hoppade 22–100). Istället:
  `createAnalyser({ autoGainTarget: 0.8, maxGain: 600, noiseFloor: 0.0015 })`,
  `setGainLock(false)` → AGC:n gör HELA gainen dynamiskt och siktar ~80 %.
  AGC-klampen är configbar (`maxGain`, default 20 i drivern).
  Tystnad: `rms > noiseFloor`-gaten fryser AGC:n → mic-brus förstärks inte.
- **Ljus:** `lightRawRms` = 130 ms EMA av block-RMS på RÅ samples, uppdaterad per
  ALSA-callback. `emitBands`: `amp = min(1, lightRawRms * micGain)`.
  `bassRms/midHiRms` = amp × spektral andel ur `specAbs` (andel, aldrig nivå).

**Aldrig:** använd `frame.level`/`frame.levelVU` för ljus-formen — de är uppmätt
platta i låtar och gav output pinnad ~50 %. Dirigent v2 använder `frame.intensity`
som form och `lightRawRms * micGain` bara som långsam loudness-skala. Aldrig
applicera användarens gain på rå-PCM/ringen igen (symptom: analysator-input
pinnad 100 %). Aldrig återinföra fast pre-gain före AGC:n.

**AGC-seed (2026-08-24):** `seedAnalyserGain()` i alsaMic sätter AGC:ns
STARTVÄRDE till `micGain` (klampat 0.5–AUTO_GAIN_MAX) vid mic-reset och när
kurvans gain flyttar sig >1.5×. `analyser.resetGain()` klampar mot `cfg.maxGain`
(inte hårdkodat 20). Detta är ett startvärde, INTE en pre-gain: ringen/rå-PCM är
fortsatt o-gainad och AGC:n reglerar fritt vidare därifrån.

**Input-baren** visar `latestBands.totalRms` (= ljus-tappens linjära nivå), inte
`max(bass, midHi)` — de är andelar mot 0.5 och pinnas nära 1.0.

