---
name: Percentil-AGC på analysator-tappen
description: Analysatorns AGC mäter mot 95:e percentilen (16 block-maxima à 128 ms) med autoGainTarget 0.75 som TAK, maxGain 200. Aldrig momentan-nivå som mål — det brände in klippning.
type: feature
---
**Sedan v1.0.747 (2026-08-24).**

Problem (uppmätt live på v1.0.746): AGC:n mätte mot momentan-nivån → `analyser.level`
pinnad ≥0.95 i ~55 % av tiden, clipPct upp till 21 %, status "hot". Energi-uppgångar
blev osynliga (redan max) → off-beat-känsla och ljus som inte följer uppbyggnader.
Detta var INTE BLE-kö (outstandingAgeMs platt ~15 ms).

Fix i `analyser.ts` (enda tillåtna avvikelsen från DMX-mastern på AGC:n):
- `envelope` = hög percentil av **RÅ** rms: 16 block-maxima à 128 ms (~2 s), näst-största
  ≈ 95:e percentilen. En enstaka transient drar inte upp gainen.
- `desired = autoGainTarget / envelope`. Långsam attack (`tauUp*2`), snabb retreat
  (`tauDown*0.25`) — AGC:n kan inte ta bort inbränd klippning.
- `alsaMic`: `autoGainTarget 0.75` (TAK för topparna), `maxGain 200`, `noiseFloor 0.0015`.
- Aldrig fast pre-gain före AGC:n. Ljus-tappen är fortsatt separat (se two-taps-agc-vs-light).

Acceptans: level ≥0.95 i <15 % av sampeln, clipPct ~0, status "ok", tydlig dynamik.

**Ljus-defaults (persisterade, live-verifierade):** gain-punkter {vol 15, gain 2.2} /
{vol 50, gain 1.6}, `lightScale 0.95`, `dropFlashMs 320`, `brightnessFloor 25`.
Gain-slidrarna i UI: 0.5–10× i 0.1-steg.

**Synk-bugg (fixad):** `applyProfileGlobals` skriver nu även `gain-cal-points`, och
`PUT /api/calibration` anropar den — de två gain-lagren kan inte glida isär längre.
